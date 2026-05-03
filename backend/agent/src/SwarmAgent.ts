import { Wallet, randomBytes, hexlify, solidityPackedKeccak256, id as keccakId } from 'ethers'
import { IStoragePort, IComputePort, INetworkPort, IChainPort } from '../../../shared/ports'
import { EventType, DAGNode, AgentConfig, AXLEvent } from '../../../shared/types'
import { runAgentLoop } from './agentLoop'
import { JsonAgentFormat } from './agentFormat'
import { TOOLS } from './tools/definitions'
import { REACT_SYSTEM_PROMPT } from './prompts/react'

/** Cheap shallow equality for the colony membership refresh — Set compare
 *  by content so we only log "memberships updated" on real changes. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/**
 * Storage may hold either the new structured payload (post tool-aware loop)
 * or a legacy plain-string output. Coerce to a single readable string for
 * judge() / context propagation.
 */
function extractFinal(stored: unknown): string {
  if (stored == null) return ''
  if (typeof stored === 'string') return stored
  if (typeof stored === 'object') {
    const obj = stored as any
    if (typeof obj.finalAnswer === 'string') return obj.finalAnswer
    return JSON.stringify(stored).slice(0, 4000)
  }
  return String(stored)
}

export interface AgentDeps {
  storage: IStoragePort
  compute: IComputePort
  network: INetworkPort
  chain: IChainPort
  config: AgentConfig
}

export class SwarmAgent {
  // taskId → { nodes, taskId, plannerAgentId }
  private tasks = new Map<string, { nodes: DAGNode[], taskId: string, plannerAgentId?: string }>()
  private currentTaskId: string | null = null
  private lastActivity: number = Date.now()
  // Track which tasks this agent is planner for (keeper responsibility)
  private plannerFor = new Set<string>()
  // nodeId-keyed reentrancy guard for executeSubtask. Multiple paths can
  // race into execution for the same node (SUBTASK_DONE re-entry, fallback
  // timer, watchdog, AXL gossip-loopback) — without this, the second path
  // re-stakes a node that's already mid-flight and the contract reverts
  // with "Already staked". Cleared in the finally block.
  private inflightSubtasks = new Set<string>()
  // Commit-reveal jury state. Holds the salt + verdict between the commit
  // tx and the scheduled reveal tx (~30 min later). In-memory only — a
  // process restart between phases forfeits this juror's vote.
  private pendingReveals = new Map<string, {
    taskId: string
    accusedGuilty: boolean
    salt: string
    revealAt: number
  }>()
  // Per-task dedupe for the keeper-timeout watchdog. Multiple peers may
  // hear the same DAG_VALIDATING event AND a worker may emit-then-receive
  // it locally; without this guard we'd spawn N redundant timers per task
  // (each agent already arms its own; we just don't want one agent doing
  // it twice). Cleared on DAG_COMPLETED in the existing handler.
  private keeperWatchdogScheduled = new Set<string>()

  constructor(private deps: AgentDeps) { }

  public async start(): Promise<void> {
    this.deps.network.on(EventType.TASK_SUBMITTED, (event) => {
      this.onTaskSubmitted(event)
    })
    this.deps.network.on(EventType.TASK_REOPENED, (event) => {
      this.onTaskReopened(event)
    })
    this.deps.network.on(EventType.DAG_READY, (event) => {
      this.onDAGReady(event)
    })

    // Live membership update — fires when the API's addMember/removeMember
    // route mutates a colony this agent might belong to. Skips the 30s
    // poll window so a "create colony, add agent, dispatch task" sequence
    // doesn't hit the abstain race. Only events that name THIS agent are
    // relevant (broadcast is fan-out, every agent receives it).
    this.deps.network.on(EventType.COLONY_MEMBERSHIP_CHANGED, (event) => {
      const { colonyId, agentId, change } = event.payload as {
        colonyId?: string
        agentId?: string
        change?: 'added' | 'removed'
      }
      if (!colonyId || !agentId || agentId !== this.deps.config.agentId) return
      if (change === 'added') {
        if (!this.myColonies.has(colonyId)) {
          this.myColonies.add(colonyId)
          console.log(`[Agent ${this.deps.config.agentId}] live membership add: ${colonyId}`)
        }
      } else if (change === 'removed') {
        if (this.myColonies.delete(colonyId)) {
          console.log(`[Agent ${this.deps.config.agentId}] live membership remove: ${colonyId}`)
        }
      }
    })

    // --- Synchronization listeners (shared state) ---
    this.deps.network.on(EventType.PLANNER_SELECTED, (event) => {
      const { taskId, agentId } = event.payload as any
      if (agentId !== this.deps.config.agentId) {
        this.deps.chain.syncPlannerClaim(taskId, agentId)
      }
    })

    this.deps.network.on(EventType.SUBTASK_CLAIMED, (event) => {
      const { nodeId, agentId, taskId } = event.payload as any
      if (agentId !== this.deps.config.agentId) {
        console.log(`[Agent ${this.deps.config.agentId}] sync: subtask ${nodeId} claimed by ${agentId}`)
        this.deps.chain.syncSubtaskClaim(nodeId, agentId)

        // Track who owns the slot in our local cache so the SUBTASK_DONE
        // dispatch knows whether to fire executeSubtask for this node when
        // prev finishes (it shouldn't, since the peer holds it).
        const task = this.tasks.get(taskId)
        if (task) {
          const node = task.nodes.find(n => n.id === nodeId)
          if (node) {
            node.status = 'claimed'
            node.claimedBy = agentId
          }
        }
      }
    })

    this.deps.network.on(EventType.SUBTASK_DONE, (event) => {
      const { nodeId, outputHash, taskId } = event.payload as any
      if (taskId === this.currentTaskId) {
        this.lastActivity = Date.now()
      }
      const task = this.tasks.get(taskId)
      if (!task) return

      const doneIndex = task.nodes.findIndex(n => n.id === nodeId)
      const doneNode = task.nodes[doneIndex]
      if (doneNode) {
        doneNode.status = 'done'
        doneNode.outputHash = outputHash
      }

      // Critical for parallel-claim/sequential-execute: lift the next node's
      // prevHash from "placeholder-..." to the real outputHash so any agent
      // (including the one holding the claim) can now execute it. Without
      // this update, a peer who pre-claimed node-2 has no way to know prev
      // is ready.
      const nextNode = task.nodes[doneIndex + 1]
      if (nextNode && nextNode.prevHash && nextNode.prevHash.includes('placeholder-')) {
        nextNode.prevHash = outputHash
      }

      // Deferred-execute dispatch: if WE pre-claimed the next node and were
      // waiting on prev, now's the time to run it.
      if (
        nextNode &&
        nextNode.claimedBy === this.deps.config.agentId &&
        nextNode.status === 'claimed'
      ) {
        console.log(`[Agent ${this.deps.config.agentId}] prev done, dispatching held claim ${nextNode.id}`)
        this.executeSubtask(nextNode, taskId).catch(err =>
          console.error(`[Agent ${this.deps.config.agentId}] deferred execute error:`, err),
        )
      }

      // Always try to claim more — a slot we passed on earlier (prev not
      // ready, network blip) might be takeable now.
      this.claimFirstAvailable(taskId).catch(() => { })
    })

    // Track peer validations so the next worker can skip its own judge()
    // call. Saves ~5-10s per node when a peer has already accepted the
    // previous output as context.
    this.deps.network.on(EventType.SUBTASK_PEER_VALIDATED, (event) => {
      const { nodeId, taskId } = event.payload as any
      const task = this.tasks.get(taskId)
      if (!task) return
      const node = task.nodes.find(n => n.id === nodeId)
      if (node) node.peerValidated = true
    })

    this.deps.network.on(EventType.SUBTASK_VALIDATED, (event) => {
      const { nodeId, taskId } = event.payload as any
      const task = this.tasks.get(taskId)
      if (!task) return
      const node = task.nodes.find(n => n.id === nodeId)
      if (node) node.peerValidated = true
    })

    this.deps.network.on(EventType.CHALLENGE, (event) => {
      this.onChallengeRaised(event).catch(err =>
        console.error(`[Agent ${this.deps.config.agentId}] juror flow error:`, err),
      )
    })

    // Keeper handoff: last subtask is on-chain but markValidatedBatch +
    // settleTask haven't run yet. Two paths:
    //   - We ARE the planner-keeper for this task → judge + settle now.
    //     Skip self-emits (we already ran the path inline in executeSubtask).
    //   - We are NOT the planner → schedule the keeper-timeout watchdog.
    //     If the planner is offline / restarted / crashed, after
    //     KEEPER_TIMEOUT (90s on-chain + grace) anyone can call
    //     `DAGRegistry.forceComplete` to settle with planner share = 0.
    //     Without this, a stuck "validate" state locks worker stake +
    //     task budget forever — the failure mode that motivated this
    //     watchdog in the first place.
    this.deps.network.on(EventType.DAG_VALIDATING, async (event) => {
      const { taskId, lastNodeId, lastOutputHash } = event.payload as any
      if (this.plannerFor.has(taskId)) {
        if (event.agentId === this.deps.config.agentId) return
        console.log(`[Agent ${this.deps.config.agentId}] KEEPER: DAG_VALIDATING for ${taskId} — judging last node`)
        await this.validateLastNodeAsPlanner(lastNodeId, lastOutputHash, taskId)
      } else {
        this.scheduleKeeperWatchdog(taskId)
      }
    })

    this.deps.network.on(EventType.DAG_COMPLETED, async (event) => {
      const { taskId, agentId } = event.payload as any
      console.log(`[Agent ${this.deps.config.agentId}] Received DAG_COMPLETED for ${taskId} from ${agentId || event.agentId}`)

      // DAG_COMPLETED now strictly means: keeper has judged, batch-validated
      // and settled. Safe to sync chain state and free the agent.
      this.deps.chain.syncTaskCompletion(taskId, agentId || event.agentId)

      if (this.currentTaskId === taskId) {
        console.log(`[Agent ${this.deps.config.agentId}] Resetting busy state for task ${taskId}`)
        this.currentTaskId = null
        this.tasks.delete(taskId)
        this.plannerFor.delete(taskId)
      }
      // Drop the watchdog dedupe entry too — task is settled, no point
      // keeping a "we already armed forceComplete for this" memo. The
      // setTimeout itself can't be cancelled but its body short-circuits
      // on `isTaskFinalized`.
      this.keeperWatchdogScheduled.delete(taskId)
    })

    console.log(`[Agent ${this.deps.config.agentId}] started and listening for ALL events`)

    this.startSurplusWatchdog()
    this.startColonyMembershipRefresh()
  }

  // Colony memberships this agent currently belongs to. Refreshed every
  // COLONY_REFRESH_MS by hitting the API's /internal/agents/:id/colonies
  // endpoint. Tasks tagged with a colonyId are filtered against this set
  // in onTaskSubmitted; tasks without a colonyId remain public.
  private myColonies = new Set<string>()
  private colonyMembershipFetched = false

  private startColonyMembershipRefresh(): void {
    const apiUrl = process.env.API_INTERNAL_URL ?? 'http://api:3001'
    const url = `${apiUrl}/internal/agents/${this.deps.config.agentId}/colonies`
    const id = this.deps.config.agentId

    const tick = async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          // 404 / 5xx → keep stale set; better than wiping memberships
          // because the API hiccupped. The legitimate "no memberships"
          // case is a 200 with an empty colony_ids array.
          return
        }
        const data = await res.json() as { colony_ids?: string[] }
        const next = new Set(data.colony_ids ?? [])
        if (!setsEqual(next, this.myColonies)) {
          console.log(`[Agent ${id}] colony memberships updated: [${[...next].join(', ') || '(none)'}]`)
          this.myColonies = next
        }
        this.colonyMembershipFetched = true
      } catch (err) {
        // Network failure → keep stale set, log and try again next tick.
        console.warn(`[Agent ${id}] colony refresh failed:`, err)
      }
    }
    // Kick once immediately so the first task we see is filtered with
    // current state, then poll. Fire-and-forget — failures are logged
    // inside tick().
    tick().catch(() => {})

    const COLONY_REFRESH_MS = 30_000
    const timer = setInterval(tick, COLONY_REFRESH_MS)
    if (typeof timer.unref === 'function') timer.unref()
    console.log(`[Agent ${id}] colony membership refresh running every ${COLONY_REFRESH_MS / 1000}s`)
  }

  /**
   * Surplus auto-payout was a token-era construct: it forwarded any USDC
   * earned above the stake floor from the agent's wallet to the owner.
   * In the tokenless model the agent has no transferable token — earnings
   * accumulate as `agentBalances[agent]` in Escrow and flow back to the
   * user's Treasury balance via the API's withdraw flow (operator-signed
   * Escrow.debitAgent + Treasury.creditBalance) when the user explicitly
   * requests it. So this watchdog is now a no-op and intentionally not
   * reactivated.
   */
  private startSurplusWatchdog(): void {
    const id = this.deps.config.agentId
    console.log(`[Agent ${id}] surplus sweep disabled — earnings live in Escrow.agentBalances ledger`)
  }

  private isBusyWithTimeout(newTaskId: string): boolean {
    if (!this.currentTaskId) return false
    if (this.currentTaskId === newTaskId) return false

    // 15 saniye sessizlik varsa meşgul sayılma (timeout)
    const silentDuration = Date.now() - this.lastActivity
    if (silentDuration > 15000) {
      console.log(`[Agent ${this.deps.config.agentId}] Previous task ${this.currentTaskId} timed out (${Math.round(silentDuration / 1000)}s silent). Resetting.`)
      // Drop the stale local cache too — leaving it in this.tasks lets a
      // late SUBTASK_DONE / SUBTASK_PEER_VALIDATED event for the abandoned
      // task re-enter dispatch logic and try to operate on its old node list.
      const stale = this.currentTaskId
      this.tasks.delete(stale)
      this.plannerFor.delete(stale)
      this.currentTaskId = null
      return false
    }

    return true
  }

  private async onTaskSubmitted(event: AXLEvent<any>): Promise<void> {
    try {
      const taskId = event.payload.taskId

      // Colony scope. Tasks broadcast with a colonyId only run on member
      // agents — non-members ignore them outright (no PLANNER_SELECTED
      // emit, no claim race). Public tasks (no colonyId) bypass this gate.
      const colonyId = event.payload?.colonyId
      if (colonyId && !this.myColonies.has(colonyId)) {
        console.log(`[Agent ${this.deps.config.agentId}] task ${taskId} scoped to colony ${colonyId} — not a member, abstain`)
        return
      }

      if (this.isBusyWithTimeout(taskId)) {
        console.log(`[Agent ${this.deps.config.agentId}] busy with ${this.currentTaskId}, ignoring ${taskId}`)
        return
      }

      // Ensure we have enough balance to stake as a planner before racing.
      // If we don't, we can still participate as a worker later.
      // Planner stake is 10% of stakeAmount (same scale as worker per-
      // subtask stake — see plannerStakeAmount() / executeSubtask). The
      // earlier version checked against the FULL stakeAmount and locked
      // 100% of the bond on stake(), which meant a single in-flight task
      // bricked the agent for any future planning until settle finalized.
      if (typeof this.deps.chain.getStakeCapacity === 'function') {
        try {
          const capacity = await this.deps.chain.getStakeCapacity(this.plannerStakeAmount())
          if (capacity < 1) {
            console.log(`[Agent ${this.deps.config.agentId}] insufficient balance to be planner, abstaining`)
            return
          }
        } catch {
          // read failure -> fall through
        }
      }

      this.lastActivity = Date.now()
      // Plancı olmak için niyetini belli et
      await this.deps.network.emit(this.buildEvent(EventType.PLANNER_SELECTED, { agentId: this.deps.config.agentId, taskId }))

      // Race directly. The PLANNER_SELECTED gossip + on-chain FCFS are
      // the actual coordination — the previous 1s sleep was meant to give
      // peers a head start but only added dead time to every task. The
      // first-write-wins claimPlanner contract call already handles ties.
      const claimed = await this.deps.chain.claimPlanner(taskId)
      if (claimed) {
        this.currentTaskId = taskId
        console.log(`[Agent ${this.deps.config.agentId}] WON planner race. Acting as planner.`)
        await this.runAsPlanner(event)
      } else {
        // Lost the race. The planner address is on-chain at planners[taskId];
        // the previous "chosenPlanner" log read a MockChain-only field via
        // `as any` and printed our own id on real chain — misleading. Skip.
        console.log(`[Agent ${this.deps.config.agentId}] LOST planner race. Acting as worker.`)
      }
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onTaskSubmitted error:`, err)
    }
  }

  private async runAsPlanner(event: AXLEvent<any>): Promise<void> {
    try {
      const { taskId, spec } = event.payload
      // Forward the colony scope into DAG_READY so workers can run the
      // same membership gate that planner-selection enforces — without
      // it, non-member peers happily claim subtasks in colony-scoped
      // DAGs (the gate at onTaskSubmitted only filters planner candidates).
      const colonyId = event.payload?.colonyId
      const agentId = this.deps.config.agentId
      console.log(`[Agent ${agentId}] PLANNER for task ${taskId}`)

      const nodes = await this.deps.compute.buildDAG(spec)

      // Storage append is content-addressed and idempotent — fire-and-forget
      // it via appendDeferred so DAG_READY can emit ~30-40s sooner. The
      // hash isn't actually needed by anyone; readers go through outputHash
      // on-chain. We only run it for the audit trail.
      if (typeof this.deps.storage.appendDeferred === 'function') {
        this.deps.storage.appendDeferred(nodes).then(r =>
          r.uploadPromise.catch(err => console.warn('[Planner] DAG metadata upload failed (non-fatal):', err)),
        ).catch(err => console.warn('[Planner] DAG metadata appendDeferred failed (non-fatal):', err))
      } else {
        // Legacy adapter path — still kick it off but don't await.
        this.deps.storage.append(nodes).catch(err =>
          console.warn('[Planner] DAG metadata append failed (non-fatal):', err),
        )
      }

      // Sequential: ethers v6 NonceManager has a known race when
      // sendTransaction calls overlap (delta is snapshotted before await,
      // so both calls observe the same pending nonce). Until we wrap it
      // with a mutex, fall back to sequential order. registerDAG first so
      // a revert there doesn't lock our stake (Fix 3).
      const nodeIds = nodes.map(n => n.id)
      await this.deps.chain.registerDAG(taskId, nodeIds)
      console.log(`[Agent ${agentId}] DAG registered on-chain with ${nodeIds.length} nodes`)

      // Defensive re-check between registerDAG and stake. The earlier
      // pre-race check at onTaskSubmitted can race with another task
      // consuming the same Escrow ledger balance — by the time we get
      // here our agentBalances may have dropped below the planner stake
      // and stake() would revert with "insufficient balance", silently
      // killing settlement (no DAG_READY ever fires). Skip-and-fail
      // here lets us emit TASK_FAILED so the UI surfaces the real
      // reason instead of spinning forever.
      const plannerStake = this.plannerStakeAmount()
      if (typeof this.deps.chain.getStakeCapacity === 'function') {
        try {
          const capacity = await this.deps.chain.getStakeCapacity(plannerStake)
          if (capacity < 1) {
            throw new Error(
              `Planner stake unaffordable: agent Escrow balance < ${plannerStake} USDC. Old planner stakes may be locked on a prior task that never settled — wait for the keeper watchdog (~110s) or top up ${agentId}.`,
            )
          }
        } catch (capErr) {
          // Re-throw so the outer catch at runAsPlanner emits TASK_FAILED.
          // Don't swallow read failures here — they may mask the real
          // issue and let stake() blow up downstream.
          throw capErr
        }
      }

      await this.deps.chain.stake(taskId, plannerStake)
      // Self-arm the keeper watchdog the moment our planner stake lands.
      // Without this, only NON-planner peers schedule it (via
      // DAG_VALIDATING in registerEventHandlers). If our own keeper duties
      // — markValidatedBatch / settleTask in validateLastNodeAsPlanner —
      // revert OR if any later step here throws before DAG_VALIDATING
      // ever emits, no peer rescues our locked planner stake until
      // someone manually fires forceComplete. Idempotent on taskId, so
      // duplicate arms (e.g. catch-block re-arm below) are no-ops.
      this.scheduleKeeperWatchdog(taskId)

      // Mark planner responsibility BEFORE emitting DAG_READY. AxlNetwork.emit
      // schedules local handlers on the microtask queue; if onDAGReady runs
      // before this set is populated, claimFirstAvailable's `plannerFor.has()`
      // guard fails open and the planner ends up racing for its own node-1.
      this.plannerFor.add(taskId)
      this.tasks.set(taskId, { nodes, taskId, plannerAgentId: agentId })

      await this.deps.network.emit(this.buildEvent(EventType.DAG_READY, {
        nodes,
        taskId,
        plannerAgentId: agentId,
        colonyId,
      }))

      console.log(`[Agent ${agentId}] DAG_READY emitted, ${nodes.length} nodes`)

      // Single-agent fallback: if no peer claims any subtask within this
      // window, the planner self-claims its own DAG. Without this a one-agent
      // swarm hangs forever after DAG_READY (planners normally don't race for
      // their own subtasks because settlement double-pays them). Settlement
      // math still works — escrow happily pays the same address twice.
      // Trimmed from 30s — peers always race in <8s, the longer wait was
      // just demo dead time.
      const SINGLE_AGENT_FALLBACK_MS = 8_000
      setTimeout(async () => {
        const cached = this.tasks.get(taskId)
        if (!cached) return
        const anyClaimed = cached.nodes.some(n => n.status === 'claimed' || n.status === 'done')
        if (anyClaimed) return // peer is on it
        if (!this.plannerFor.has(taskId)) return
        console.log(`[Agent ${agentId}] single-agent fallback: no peer claimed in ${SINGLE_AGENT_FALLBACK_MS}ms, planner self-claiming`)
        await this.claimFirstAvailable(taskId, true, true).catch(err =>
          console.error(`[Agent ${agentId}] self-claim error:`, err),
        )
      }, SINGLE_AGENT_FALLBACK_MS)
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] runAsPlanner FAILED:`, err)
      // Without this, the frontend sits on "Awaiting DAG…" forever because
      // no DAG_READY ever fires. Surface the failure so the UI can paint
      // an actionable error instead of an indefinite spinner.
      const taskId = event?.payload?.taskId
      if (taskId) {
        // Defensive watchdog arm: if stake() landed before this throw
        // (e.g. registerDAG succeeded but a later step blew up before we
        // could emit DAG_READY), our planner stake is locked and no
        // peer's DAG_VALIDATING handler will ever rescue it. Schedule
        // forceComplete now so KEEPER_TIMEOUT recovery kicks in. Safe
        // when stake never landed — the on-chain notFinalized + no-stake
        // checks make forceComplete a no-op revert that we swallow.
        try { this.scheduleKeeperWatchdog(taskId) } catch {}
        const reason = (err as any)?.shortMessage ?? (err as any)?.message ?? String(err)
        this.deps.network.emit(this.buildEvent(EventType.TASK_FAILED, {
          taskId,
          reason: `Planner failed during DAG construction: ${reason}`,
          stage: 'planner',
        })).catch(emitErr => {
          console.error(`[Agent ${this.deps.config.agentId}] TASK_FAILED emit also failed:`, emitErr)
        })
      }
    }
  }

  private async onDAGReady(event: AXLEvent<any>): Promise<void> {
    try {
      const { nodes, taskId } = event.payload

      // Colony scope (worker side). Mirrors the planner-selection gate in
      // onTaskSubmitted: a non-member peer that received DAG_READY over AXL
      // must NOT cache the task or race claimFirstAvailable, otherwise it
      // claims and earns from a colony-scoped task it has no business in.
      // Public tasks (no colonyId) bypass this gate.
      const colonyId = event.payload?.colonyId
      if (colonyId && !this.myColonies.has(colonyId)) {
        console.log(`[Agent ${this.deps.config.agentId}] DAG_READY for colony ${colonyId} task ${taskId} — not a member, abstain`)
        return
      }

      if (this.isBusyWithTimeout(taskId)) {
        return
      }

      this.lastActivity = Date.now()
      // cache'e al ve sahiplen
      this.currentTaskId = taskId
      const plannerAgentId = event.payload.plannerAgentId
      this.tasks.set(taskId, { nodes, taskId, plannerAgentId })
      console.log(`[Agent ${this.deps.config.agentId}] DAG cached, trying first node`)
      // Skill-aware first pass — only race for nodes the agent's prompt
      // claims to be a fit for.
      await this.claimFirstAvailable(taskId, false)

      // Fallback: if this window passes with uncllaimed nodes, every agent
      // drops the skill filter and tries again. Prevents a DAG from
      // stalling when no one self-selected as a fit (e.g. very generic
      // prompts that all said NO, or a subtask domain no agent specialised in).
      // Trimmed from 30s — assess() responses arrive in 2-5s; 8s is plenty
      // of margin and shaves ~22s off any task that needs the fallback.
      const FALLBACK_MS = 8_000
      setTimeout(async () => {
        const task = this.tasks.get(taskId)
        if (!task) return // task already completed / abandoned
        if (this.currentTaskId !== taskId) return // we moved on
        const anyUnclaimed = task.nodes.some(n => n.status !== 'claimed' && n.status !== 'done')
        if (!anyUnclaimed) return
        console.log(`[Agent ${this.deps.config.agentId}] skill filter timed out — retrying without filter`)
        await this.claimFirstAvailable(taskId, true).catch(err => {
          console.error(`[Agent ${this.deps.config.agentId}] fallback claim error:`, err)
        })
      }, FALLBACK_MS)
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] onDAGReady error:`, err)
    }
  }

  /**
   * Cheap one-token YES/NO probe gating subtask claims by the agent's own
   * system prompt. Returns true when the assessor LLM thinks the agent is
   * a good match, OR when no system prompt is set (generalist agents claim
   * everything by default), OR when `bypass=true` (fallback path).
   */
  private async fitsSkill(subtask: string, bypass: boolean): Promise<boolean> {
    if (bypass) return true
    const prompt = this.deps.config.systemPrompt
    if (!prompt || !prompt.trim()) return true
    try {
      return await this.deps.compute.assess(subtask, prompt)
    } catch (err) {
      console.warn(`[Agent ${this.deps.config.agentId}] assess error, claiming anyway:`, err)
      return true
    }
  }

  private async claimFirstAvailable(taskId: string, bypassSkill = false, allowSelfPlanner = false): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    // Role separation: the planner of this task is its keeper-validator and
    // does NOT race for its own subtasks. The settlement split (20% planner,
    // 80% workers) collapses to "planner takes everything" if the planner
    // also fills the worker slots — fine in a single-agent swarm but bad
    // when peers exist. Default: skip; only the single-agent fallback timer
    // passes allowSelfPlanner=true after waiting for peers.
    if (this.plannerFor.has(taskId) && !allowSelfPlanner) return

    // Balance-aware cap: a single agent (typically the planner during the
    // single-agent fallback) used to claim every node in the DAG, then run
    // out of USDC mid-execution because each subtask needs its own stake.
    // The mid-DAG ERC20InsufficientBalance revert left orphan claims that
    // peers couldn't recover. Cap upfront based on what we can actually
    // afford, leaving the rest for peers (or, if no peers, the next round
    // of fallback once stakes are released).
    //
    // CRITICAL: pass the *per-subtask* stake (10% of full stakeAmount, see
    // executeSubtask) to getStakeCapacity, NOT the full stakeAmount. The
    // earlier version passed the full amount and under-capped by 10x —
    // benign for 3-node demos but starves larger DAGs.
    const totalStakeNum = parseFloat(this.deps.config.stakeAmount || '100')
    const perSubtaskStakeStr = (totalStakeNum * 0.1).toString()
    let stakeCapacity = Number.MAX_SAFE_INTEGER
    if (typeof this.deps.chain.getStakeCapacity === 'function') {
      try {
        stakeCapacity = await this.deps.chain.getStakeCapacity(perSubtaskStakeStr)
      } catch {
        // unreadable balance → don't claim anything this round; let the
        // next pass try again rather than crash mid-execute.
        stakeCapacity = 0
      }
    }
    let claimedThisRound = 0

    // Pre-warm assess() in parallel for every candidate node. Without this,
    // fitsSkill runs sequentially inside the loop and an agent without a
    // systemPrompt returns instantly while a prompted agent waits 2-5s per
    // node — the promptless agent wins every race by structural advantage.
    // Running the probes concurrently means each agent pays one round-trip
    // of LLM latency total, regardless of prompt presence.
    const candidates = task.nodes.filter(
      n => n.status !== 'done' && n.status !== 'claimed',
    )
    const fitnessByNodeId = new Map<string, boolean>()
    const fitnessResults = await Promise.all(
      candidates.map(async n => [n.id, await this.fitsSkill(n.subtask, bypassSkill)] as const),
    )
    for (const [id, fits] of fitnessResults) fitnessByNodeId.set(id, fits)

    // Shuffle the iteration order. Walking task.nodes in fixed order makes
    // the marginally-fastest agent race for node-1 first, then node-2 etc.,
    // so every FCFS race resolves to the same winner. Shuffling means each
    // agent attempts a different node first — a 3-node DAG with 3 racers
    // naturally distributes claims across the swarm instead of collapsing
    // onto one greedy claimant.
    const shuffled = [...candidates]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    // Parallel claim, sequential execute: agents race to claim ALL eligible
    // nodes upfront (regardless of whether prev is done). Once a node is
    // claimed, the claimer waits for prev's SUBTASK_DONE — at which point
    // the listener wakes up and dispatches executeSubtask. This breaks the
    // single-agent-zincirleme bias of the old "claim only when prev is
    // ready" rule, since every node opens for FCFS the moment the DAG is
    // sealed.
    for (const node of shuffled) {
      if (claimedThisRound >= stakeCapacity) {
        console.log(
          `[Agent ${this.deps.config.agentId}] balance limit reached (${claimedThisRound}/${stakeCapacity} stakes), leaving rest for peers`,
        )
        break
      }
      // Status may have flipped during pre-warm — a peer claimed it while
      // we were waiting on assess().
      if (node.status === 'done' || node.status === 'claimed') continue

      const fits = fitnessByNodeId.get(node.id) ?? true
      if (!fits) {
        console.log(`[Agent ${this.deps.config.agentId}] passing on ${node.id} — outside skill`)
        this.deps.network.emit(this.buildEvent(EventType.AGENT_PASSED, {
          nodeId: node.id, taskId, agentId: this.deps.config.agentId, reason: 'outside_skill',
        })).catch(() => { })
        continue
      }

      // Wider jitter (was 0-100ms). 500-1500ms gives DAG_READY gossip time
      // to actually reach all peers before any agent attempts the on-chain
      // claim — without it, the agent that received the gossip a few hundred
      // ms earlier wins every race deterministically.
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000))

      // Pre-check: if the chain already shows this node claimed, skip the
      // tx. Saves gas and avoids "tx success / verify says not us" noise.
      try {
        if (await this.deps.chain.isSubtaskClaimed(node.id)) {
          node.status = 'claimed'
          continue
        }
      } catch {
        // Read failure → fall through to optimistic claim.
      }

      const claimed = await this.deps.chain.claimSubtask(node.id)
      if (claimed) {
        node.status = 'claimed'
        node.claimedBy = this.deps.config.agentId
        claimedThisRound++
        console.log(`[Agent ${this.deps.config.agentId}] claimed ${node.id} (${claimedThisRound}/${stakeCapacity} stake budget)`)

        // Dispatch decision: if prev is ready (or we're the first node)
        // execute now; otherwise hold the claim and let the SUBTASK_DONE
        // listener kick off execution when prev finishes.
        const prevReady = !node.prevHash || !node.prevHash.includes('placeholder-')
        if (prevReady) {
          // Don't await — keep racing for more nodes in this loop iteration.
          this.executeSubtask(node, taskId).catch(err =>
            console.error(`[Agent ${this.deps.config.agentId}] execute error:`, err),
          )
        } else {
          console.log(`[Agent ${this.deps.config.agentId}] holding ${node.id} — prev not ready`)
        }
        // Continue racing for additional eligible nodes on this same DAG.
      }
    }
  }

  private async executeSubtask(node: DAGNode, taskId: string): Promise<void> {
    // Reentrancy guard — if any other path is mid-execution for this same
    // node, skip. Without this, gossip-loopback / fallback timer / watchdog
    // can each call executeSubtask concurrently and the second one hits
    // "Already staked" on the SwarmEscrow when stakeForSubtask runs again.
    if (this.inflightSubtasks.has(node.id)) {
      console.log(`[Agent ${this.deps.config.agentId}] executeSubtask: ${node.id} already in flight, skipping`)
      return
    }
    this.inflightSubtasks.add(node.id)
    try {
      const agentId = this.deps.config.agentId

      // Dynamic Stake: Each agent risks 10% of their total stakeAmount per subtask.
      // This allows them to handle up to 10 parallel subtasks while scaling the
      // risk/reward based on their total capacity.
      const totalStake = parseFloat(this.deps.config.stakeAmount || '100')
      const perSubtaskStake = (totalStake * 0.1).toString()

      // Fire-and-forget stake: stakeForSubtask is serialized inside the
      // L2Contract tx mutex anyway, so awaiting it here just blocks the LLM
      // from starting. Kick it off, do the slow LLM work concurrently, and
      // await right before submitOutput (which is the next tx that
      // *requires* the stake to have landed). Saves ~5-10s per node.
      let stakePromise: Promise<any> = Promise.resolve()
      if (!this.plannerFor.has(taskId)) {
        stakePromise = this.deps.chain.stakeForSubtask(taskId, node.id, perSubtaskStake)
        // Don't let an unhandled rejection bubble out before our await — we
        // catch it explicitly later. Attach a noop catch now so Node doesn't
        // log "PromiseRejectionHandledWarning".
        stakePromise.catch(() => {})
      } else {
        console.log(`[Agent ${agentId}] skipping stakeForSubtask for ${node.id} — already staked for full task as planner`)
      }

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_CLAIMED, { nodeId: node.id, agentId, taskId }))

      let prevOutput: unknown = null
      let prevText: string = ''
      let prevFetchFailed = false
      if (node.prevHash) {
        // Fail-soft: if the indexer can't surface the prev upload after
        // all retries (typical when 0G testnet propagation lags beyond
        // our retry budget, or the producer's upload genuinely dropped),
        // proceed with empty prev context instead of killing the whole
        // DAG. Output quality on this node degrades — the LLM gets less
        // grounding — but the task completes. Without this fallback the
        // worker just throws and the explorer sees a stuck DAG that
        // only forceComplete (after KEEPER_TIMEOUT) can rescue.
        try {
          prevOutput = await this.deps.storage.fetch(node.prevHash)
          prevText = extractFinal(prevOutput)
        } catch (fetchErr) {
          prevFetchFailed = true
          console.warn(
            `[Agent ${agentId}] prev fetch FAILED for ${node.prevHash} after retries — proceeding with empty context. Error:`,
            (fetchErr as Error)?.message ?? fetchErr,
          )
        }

        // Find the prev node so we can decide whether to re-judge or trust
        // an existing peer validation.
        const task = this.tasks.get(taskId)
        const currentIndex = task ? task.nodes.findIndex(n => n.id === node.id) : -1
        const prevNode = task && currentIndex > 0 ? task.nodes[currentIndex - 1] : null

        // Skip the LLM-Judge call when another peer (or the planner) has
        // already validated this output — the SUBTASK_PEER_VALIDATED /
        // SUBTASK_VALIDATED listeners set this flag. Saves ~5-10s per
        // node in healthy multi-agent runs. We still judge cold outputs.
        // Also skip judge when we couldn't fetch — judging an empty
        // string is meaningless and would always reject, triggering an
        // unwanted challenge against a node whose output we just
        // happen to not be able to read.
        const alreadyValidated = !!prevNode?.peerValidated
        if (!alreadyValidated && !prevFetchFailed) {
          const isValid = await this.deps.compute.judge(prevText)
          if (!isValid) {
            console.log(`[Agent ${agentId}] LLM-Judge rejected output. Challenging previous node.`)
            if (prevNode) {
              await this.challengeNode(prevNode, taskId, node.id)
            }
            return // Stop execution of current subtask
          }

          // Peer-validation: judge accepted the previous output. Surface
          // this to peers + UI so the prev box flips green and other
          // workers can skip their own judge() call.
          if (prevNode) {
            prevNode.peerValidated = true
            this.deps.network.emit(this.buildEvent(EventType.SUBTASK_PEER_VALIDATED, {
              nodeId: prevNode.id,
              taskId,
              validatorAgentId: agentId,
            })).catch(() => { })
          }
        } else if (prevFetchFailed) {
          console.log(`[Agent ${agentId}] skipping judge for ${prevNode?.id ?? '?'} — prev output unfetchable (fail-soft)`)
        } else {
          console.log(`[Agent ${agentId}] skipping judge for ${prevNode!.id} — already peer-validated`)
        }
      }

      // Tool-aware agent loop. Returns a structured record that's preserved
      // verbatim in 0G Storage, so the judge / next agent / UI can see
      // exactly which tools fired and what they returned.
      // Fall back to REACT_SYSTEM_PROMPT when the operator didn't supply a
      // custom prompt — keeps the UI's "System Prompt (optional)" field
      // empty for the user while still giving the model a structured
      // DÜŞÜN→EYLEM→GÖZLEM rhythm by default. Treat whitespace-only as
      // unset so a stray newline in the form doesn't bypass the default.
      const userPrompt = this.deps.config.systemPrompt?.trim()
      const loopResult = await runAgentLoop({
        compute: this.deps.compute,
        tools: TOOLS,
        format: new JsonAgentFormat(),
        systemPrompt: userPrompt && userPrompt.length > 0 ? userPrompt : REACT_SYSTEM_PROMPT,
        subtask: node.subtask,
        context: prevText || null,
        agentId,
      })

      const persisted = {
        subtask: node.subtask,
        finalAnswer: loopResult.finalAnswer,
        transcript: loopResult.transcript,
        toolsUsed: loopResult.toolsUsed,
        iterations: loopResult.iterations,
        stopReason: loopResult.stopReason,
      }

      // Hash-now, upload-later: rootHash is deterministic from the payload,
      // so we submit it on-chain immediately and let the upload run in
      // background. Peer agents fetching this hash retry on miss (3× 2s).
      let outputHash: string
      let uploadPromise: Promise<void> | undefined
      if (typeof this.deps.storage.appendDeferred === 'function') {
        const r = await this.deps.storage.appendDeferred(persisted)
        outputHash = r.rootHash
        uploadPromise = r.uploadPromise
      } else {
        outputHash = await this.deps.storage.append(persisted)
      }
      node.status = 'done'
      node.outputHash = outputHash

      // Now make sure the stake landed before we declare output on-chain.
      // submitOutput on a not-yet-staked node would still succeed at the
      // contract level, but the stake tx is what locks our economic
      // commitment — if it reverted (insufficient balance, etc.) we want
      // to fail before submitting an output that we can't back up.
      try {
        await stakePromise
      } catch (stakeErr) {
        console.error(`[Agent ${agentId}] stake failed for ${node.id}, abandoning subtask:`, stakeErr)
        node.status = undefined as any
        node.outputHash = undefined
        // Try to free the on-chain claim so a peer (or our next claim
        // round) can pick this up. resetSubtask is a no-op on the real
        // L2 contract today, but mock honours it and the call is harmless.
        await this.deps.chain.resetSubtask(node.id).catch(() => {})
        return
      }

      // Submit output hash on-chain (independent of upload completion)
      await this.deps.chain.submitOutput(node.id, outputHash)

      // Wait for the storage upload to land BEFORE emitting SUBTASK_DONE.
      // Earlier "fire-and-forget" design assumed the next worker's fetch
      // retry would absorb the propagation lag — in practice the 0G
      // testnet indexer can take 60–120s to surface a fresh upload via
      // `getFileLocations`, longer than the downstream worker's retry
      // budget. The downstream then gives up with "file not found" and
      // the whole DAG dies. Awaiting here adds the upload tail to *this*
      // worker's wall time but guarantees readers see the file. Wrapped
      // in a tolerant timeout so a stuck indexer doesn't block forever —
      // if the upload genuinely failed, our async catch below logs it
      // and the keeper watchdog eventually forceCompletes.
      if (uploadPromise) {
        try {
          await uploadPromise
        } catch (uploadErr) {
          // Upload genuinely failed (timeout / RPC). On-chain hash is
          // already submitted — the next worker will hit "file not
          // found" and fall back to its empty-context degraded path
          // (see executeSubtask prevHash branch). Log loudly so ops
          // can see whether this is a one-off or a real outage.
          console.error(`[Agent ${agentId}] upload await failed for ${outputHash}; downstream will run without prev context:`, uploadErr)
        }
      }

      console.log(
        `[Agent ${agentId}] subtask done (${node.id}) iters=${loopResult.iterations} tools=[${loopResult.toolsUsed.join(',')}] reason=${loopResult.stopReason}`,
      )

      // Broadcast a UI-friendly view of the transcript. Tool outputs can
      // be megabytes (web search dumps, file reads) — clipping each to a
      // few KB keeps the WS payload small while preserving the shape of
      // the agent's reasoning for the explorer's per-node detail panel.
      // The full untruncated transcript still lives at `outputHash` in
      // 0G Storage, so judges + downstream agents read the canonical copy.
      const TOOL_OUTPUT_CLIP = 2_000
      const transcriptForBroadcast = loopResult.transcript.map(step =>
        step.kind === 'tool_call'
          ? {
              ...step,
              output:
                step.output.length > TOOL_OUTPUT_CLIP
                  ? step.output.slice(0, TOOL_OUTPUT_CLIP) + `\n…[+${step.output.length - TOOL_OUTPUT_CLIP} chars]`
                  : step.output,
            }
          : step,
      )

      await this.deps.network.emit(this.buildEvent(EventType.SUBTASK_DONE, {
        nodeId: node.id,
        outputHash,
        // Plain-text final answer for downstream context + UI legibility.
        // The full structured payload is in 0G Storage at outputHash.
        result: loopResult.finalAnswer,
        toolsUsed: loopResult.toolsUsed,
        // Reasoning trace + counters drive the explorer's "thinking
        // process" panel — the transcript is the per-step view, the
        // counters give the panel a quick summary.
        transcript: transcriptForBroadcast,
        iterations: loopResult.iterations,
        stopReason: loopResult.stopReason,
        agentId,
        taskId,
      }))

      const task = this.tasks.get(taskId)

      // Local loopback: if WE pre-claimed the next node, we don't wait for the 
      // network event to bounce back. Trigger it immediately so the chain flows.
      const nextNode = task && task.nodes[task.nodes.findIndex(n => n.id === node.id) + 1]
      if (
        nextNode &&
        nextNode.claimedBy === agentId &&
        nextNode.status === 'claimed'
      ) {
        const nextOutputHash = outputHash // current is prev for next
        nextNode.prevHash = nextOutputHash
        console.log(`[Agent ${agentId}] local loopback: triggering held claim ${nextNode.id}`)
        this.executeSubtask(nextNode, taskId).catch(err =>
          console.error(`[Agent ${agentId}] local dispatch error:`, err)
        )
      }

      // Last-node check: under parallel-claim/sequential-execute, the next
      // worker (if any) was already claimed at DAG_READY time and is sitting
      // on its prevHash. Our SUBTASK_DONE broadcast is what unblocks them —
      // so we don't re-claim here. We only need to handle the terminal case.
      const isLastNode = !!task && task.nodes[task.nodes.length - 1]?.id === node.id
      if (isLastNode) {
        if (this.plannerFor.has(taskId)) {
          // We're the planner-keeper — validate immediately.
          await this.validateLastNodeAsPlanner(node.id, outputHash, taskId)
        } else {
          // Different agent finished the last node; ask the planner to judge
          // + settle. Use DAG_VALIDATING (NOT DAG_COMPLETED) so peers don't
          // free their busy state before settlement actually happens.
          console.log(`[Agent ${agentId}] last node done, signaling planner for validation`)
          await this.deps.network.emit(this.buildEvent(EventType.DAG_VALIDATING, {
            taskId,
            lastNodeId: node.id,
            lastOutputHash: outputHash,
          }))
        }
      }

    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] executeSubtask error:`, err)
      // Hata akışında stuck busy state'e düşmemek için bu task'tan çekil.
      // Eğer hata transient ise yeni task'lar yine de bizden açılabilsin;
      // gerçekten kalıcı bir sorun varsa zaten bir sonraki task'da fail eder.
      if (this.currentTaskId === taskId) {
        this.currentTaskId = null
      }
    } finally {
      this.inflightSubtasks.delete(node.id)
    }
  }

  /**
   * Planner'ın keeper rolü: Son agent'ın çıktısını denetler.
   * Mimari gereği son agent'ı denetleyecek bir sonraki agent olmadığı için
   * bu sorumluluk planner'a aittir.
   */
  private async validateLastNodeAsPlanner(lastNodeId: string, outputHash: string, taskId: string): Promise<void> {
    const agentId = this.deps.config.agentId
    const task = this.tasks.get(taskId)
    if (!task) return

    console.log(`[Agent ${agentId}] KEEPER: Validating last node ${lastNodeId} output`)

    // Outcome accumulators. We always emit DAG_COMPLETED at the end (in the
    // finally block) so the UI never sits in "validating" forever — even if
    // an on-chain step or storage call throws. `settled` reflects whether
    // the chain actually finalized; `failureReason` is surfaced to the
    // frontend so the user gets actionable feedback instead of silence.
    let settled = false
    let failureReason: string | undefined
    let challenged = false

    try {
      // Self-claimant guard: if the planner-keeper also worked the last node,
      // a judge → challenge flow is impossible (SlashingVault rejects
      // self-challenge: `accused != msg.sender`). There is also no peer
      // worker to peer-validate the last node. Trust own work and mark
      // validated; the per-node SUBTASK_PEER_VALIDATED signal earlier in the
      // chain still gives meaningful jury coverage to every other node.
      const rawAddr = this.deps.config.agentAddress
        ?? (process.env.AGENT_PRIVATE_KEY
          ? new Wallet(process.env.AGENT_PRIVATE_KEY).address
          : '')
      const myAddr = rawAddr.toLowerCase()
      let claimant = ''
      try {
        claimant = await this.deps.chain.getNodeClaimant(lastNodeId)
      } catch (err) {
        console.warn(`[Agent ${agentId}] KEEPER: getNodeClaimant failed for ${lastNodeId}:`, err)
      }

      const selfClaimed = !!myAddr && !!claimant && myAddr.toLowerCase() === claimant.toLowerCase()

      // Deterministic marker check runs BEFORE the self-claim shortcut so
      // a worker-keeper can't bypass validation by trusting its own
      // explicit failure output. Same regex as compute.judge() — keep them
      // in sync. Fetched output may be the JSON envelope or a raw string;
      // extractFinal normalizes both shapes.
      const isExplicitFailure = (text: string): boolean => {
        const t = text.trim()
        return t.startsWith('[AGENT_NO_FINAL') ||
               /^\{[\s\S]{0,200}"action"\s*:\s*"tool"/i.test(t)
      }
      let preFetchedFinal: string | null = null
      try {
        const lastOutput = await this.deps.storage.fetch(outputHash)
        preFetchedFinal = extractFinal(lastOutput)
      } catch (err) {
        // Storage miss — fall through; the legacy non-self-claim path
        // below will retry and the trust fallback handles it.
        console.warn(`[Agent ${agentId}] KEEPER: pre-fetch for marker check failed:`, err)
      }
      if (preFetchedFinal && isExplicitFailure(preFetchedFinal)) {
        console.warn(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} carries explicit failure marker — challenging regardless of self-claim.`)
        const lastNode = task.nodes.find(n => n.id === lastNodeId)
        if (lastNode) {
          await this.challengeNode(lastNode, taskId)
        }
        challenged = true
        return
      }

      if (!selfClaimed) {
        // Storage fetch is the most common stall point — 0G storage node
        // sync gaps used to hang here forever. ZeroGStorage now caps each
        // attempt with a wall-clock timeout, so a stuck node throws here
        // instead of pinning the whole settlement flow.
        let isValid = true
        try {
          // Reuse the pre-fetched output if available to avoid hitting 0G
          // storage twice. judge() runs its own deterministic checks too,
          // but the LLM step still adds value when content is borderline.
          const finalText = preFetchedFinal ?? extractFinal(await this.deps.storage.fetch(outputHash))
          isValid = await this.deps.compute.judge(finalText)
        } catch (err) {
          // Couldn't fetch / judge the output — treat as "trust the worker"
          // rather than aborting settlement. The chain already has the
          // outputHash; refusing to settle here would punish the worker
          // for our infra failure. Log loudly so we notice in operator
          // dashboards.
          console.error(`[Agent ${agentId}] KEEPER: judge step failed (continuing to settle on trust):`, err)
        }

        if (!isValid) {
          console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} FAILED validation. Challenging.`)
          const lastNode = task.nodes.find(n => n.id === lastNodeId)
          if (lastNode) {
            await this.challengeNode(lastNode, taskId)
          }
          challenged = true
          return
        }
      } else {
        console.log(`[Agent ${agentId}] KEEPER: I worked the last node — skipping self-judge, trusting own output`)
      }

      console.log(`[Agent ${agentId}] KEEPER: Last node ${lastNodeId} validated. Marking + settling.`)

      const nodeIds = task.nodes.map(n => n.id)
      const workerAddrs = await Promise.all(
        nodeIds.map(id => this.deps.chain.getNodeClaimant(id))
      )
      const budget = BigInt(await this.deps.chain.getTaskBudget(taskId))
      const plannerAddr = this.deps.config.agentAddress ?? this.deps.config.agentId
      const { addresses, amounts } = this.computePayouts(budget, plannerAddr, workerAddrs)

      // Per-step try/catch so a revert in one chain call doesn't kill the
      // DAG_COMPLETED emit at the bottom. The order is meaningful:
      // markValidatedBatch must precede settleTask (releases stakes), and
      // completeTask is the on-chain finalization hook.
      let markedValidated = false
      try {
        await this.deps.chain.markValidatedBatch(nodeIds)
        markedValidated = true
      } catch (err) {
        failureReason = `markValidatedBatch reverted: ${(err as any)?.shortMessage ?? (err as any)?.message ?? String(err)}`
        console.error(`[Agent ${agentId}] KEEPER: markValidatedBatch FAILED:`, err)
      }

      let settledOnChain = false
      if (markedValidated) {
        try {
          await this.deps.chain.settleTask(taskId, addresses, amounts.map(a => a.toString()))
          settledOnChain = true
        } catch (err) {
          failureReason = `settleTask reverted: ${(err as any)?.shortMessage ?? (err as any)?.message ?? String(err)}`
          console.error(`[Agent ${agentId}] KEEPER: settleTask FAILED (stakes released, payouts NOT made):`, err)
        }
      }

      // Per-node validated events for the UI animation. Always safe to fire
      // once markValidatedBatch landed — the contract did the actual work.
      if (markedValidated) {
        for (const nid of nodeIds) {
          this.deps.network.emit(this.buildEvent(EventType.SUBTASK_VALIDATED, {
            nodeId: nid, taskId, agentId,
          })).catch(() => { })
        }
      }

      try {
        await this.deps.chain.completeTask(taskId)
      } catch (err) {
        // completeTask is mostly an idempotent sync hook; a revert here is
        // not fatal to settlement (settleTask already paid out) but worth
        // surfacing for ops.
        console.warn(`[Agent ${agentId}] KEEPER: completeTask non-fatal error:`, err)
      }

      settled = markedValidated && settledOnChain
      if (settled) {
        console.log(`[Agent ${agentId}] KEEPER: DAG_COMPLETED — paid planner ${amounts[0]} + ${workerAddrs.length} workers`)
      } else {
        console.error(`[Agent ${agentId}] KEEPER: settlement INCOMPLETE — emitting DAG_COMPLETED with settled=false: ${failureReason}`)
      }
    } catch (err) {
      failureReason = (err as any)?.shortMessage ?? (err as any)?.message ?? String(err)
      console.error(`[Agent ${agentId}] KEEPER validation error:`, err)
    } finally {
      // Skip the unconditional emit only when we deliberately bailed into
      // the challenge flow — challenge has its own settlement timeline.
      if (!challenged) {
        this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, {
          taskId,
          settled,
          ...(failureReason ? { error: failureReason } : {}),
        })).catch(err => {
          console.error(`[Agent ${agentId}] KEEPER: DAG_COMPLETED emit failed:`, err)
        })
      }
    }
  }

  /**
   * Open a challenge against `node`. `challengerNodeId` identifies the
   * challenger's *own* subtask — its stake is what gets slashed if the
   * challenge turns out to be false. Pass undefined when the planner is
   * challenging (their stake lives at task-level, not subtask-level).
   */
  private async challengeNode(node: DAGNode, taskId: string, challengerNodeId?: string): Promise<void> {
    try {
      await this.deps.chain.challenge(node.id, challengerNodeId)
      await this.deps.network.emit(this.buildEvent(EventType.CHALLENGE, {
        nodeId: node.id, taskId, agentId: this.deps.config.agentId,
      }))
      await this.deps.chain.resetSubtask(node.id)
      await this.deps.network.emit(this.buildEvent(EventType.TASK_REOPENED, {
        nodeId: node.id, taskId, reason: 'validation_failed',
      }))
    } catch (err) {
      console.error(`[Agent ${this.deps.config.agentId}] challenge error:`, err)
    } finally {
      // Çıkış kuralı: bu task için sorumluluğumuz challenge ile bitti.
      // Cache'i de temizle — eski subtask stake'imiz kilitli olabilir, eski
      // tasks.get() kayıtları SUBTASK_DONE listener'ını re-entrant claim'e
      // sürüklüyor ve "Already staked" zincirleme revert'ine sebep oluyor.
      if (this.currentTaskId === taskId) {
        console.log(`[Agent ${this.deps.config.agentId}] releasing task ${taskId} after challenge`)
        this.currentTaskId = null
        this.tasks.delete(taskId)
        this.plannerFor.delete(taskId)
      }
    }
  }

  /**
   * LLM-Judge jury vote — commit-reveal flow. When another agent raises a
   * CHALLENGE, every eligible peer runs its own judge() and produces a
   * verdict, then submits a SEALED commit hash on-chain. Votes stay hidden
   * until the reveal phase opens (~30 min later), at which point a scheduled
   * timer here calls revealVoteOnChallenge with the stored salt. Sealing the
   * vote closes the "tail-the-majority" attack the previous direct-vote
   * design exposed.
   *
   * Self-events (we are the challenger), missing local cache, or ineligibility
   * (we are the accused worker, not RUNNING in AgentRegistry, already
   * committed) are silently skipped — the contract is the authoritative gate.
   *
   * KNOWN LIMITATION: pendingReveals is in-memory. A process restart between
   * commit and reveal forfeits this juror's vote. For demo only.
   */
  private async onChallengeRaised(event: AXLEvent<any>): Promise<void> {
    const { nodeId, taskId } = event.payload
    const myAgentId = this.deps.config.agentId

    if (event.agentId === myAgentId) return

    const task = this.tasks.get(taskId)
    if (!task) return
    const node = task.nodes.find(n => n.id === nodeId)
    if (!node?.outputHash) {
      console.log(`[Agent ${myAgentId}] CHALLENGE: no cached output for ${nodeId}, abstain`)
      return
    }

    if (node.claimedBy === myAgentId) return
    if (this.pendingReveals.has(nodeId)) {
      console.log(`[Agent ${myAgentId}] CHALLENGE: already committed for ${nodeId}, skipping`)
      return
    }

    // Need the agent's wallet address to bind the commit hash to msg.sender.
    // Also used for the on-chain eligibility lookup below.
    const myAddr = this.deps.config.agentAddress
    if (!myAddr) {
      console.warn(`[Agent ${myAgentId}] cannot commit — agentAddress missing in config`)
      return
    }

    // Random jury gate. SlashingVault.challenge() picks JURY_SIZE jurors at
    // tx-time; everyone else self-filters here with a single mapping read,
    // skipping the expensive storage-fetch + LLM judge() round entirely.
    let eligible = false
    try {
      eligible = await this.deps.chain.isJuryEligible(nodeId, myAddr)
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] eligibility check failed for ${nodeId}:`, err)
      return
    }
    if (!eligible) {
      console.log(`[Agent ${myAgentId}] CHALLENGE: not selected as juror for ${nodeId}, abstaining`)
      return
    }

    let output: unknown
    try {
      output = await this.deps.storage.fetch(node.outputHash)
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] juror could not fetch output for ${nodeId}:`, err)
      return
    }

    const isValid = await this.deps.compute.judge(extractFinal(output))
    const accusedGuilty = !isValid
    console.log(
      `[Agent ${myAgentId}] JUROR verdict on ${nodeId}: ${accusedGuilty ? 'GUILTY' : 'INNOCENT'} (sealing commit)`,
    )

    // Build the commit hash. Format must match SlashingVault.revealVote:
    //   keccak256(abi.encodePacked(bytes32 nodeId, bool guilty, bytes32 salt, address juror))
    // nodeId here is the off-chain string; keccakId mirrors L2Contract.formatId.
    const salt = hexlify(randomBytes(32))
    const nodeIdBytes32 = keccakId(nodeId)
    const commitHash = solidityPackedKeccak256(
      ['bytes32', 'bool', 'bytes32', 'address'],
      [nodeIdBytes32, accusedGuilty, salt, myAddr],
    )

    try {
      await this.deps.chain.commitVoteOnChallenge(nodeId, commitHash)
      this.deps.network.emit(this.buildEvent(EventType.JUROR_COMMITTED, {
        nodeId, taskId, agentId: myAgentId,
      })).catch(() => { })
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] juror commit failed for ${nodeId}:`, err)
      return
    }

    // Demo timing — must match SlashingVault's COMMIT_WINDOW / REVEAL_WINDOW
    // (currently 20s each) so the full challenge resolves inside ~1 minute.
    // Reveal scheduled at commitDeadline + 3s grace so block.timestamp lands
    // safely past on-chain commitDeadline; finalize scheduled at the end of
    // reveal window + 3s. Multiple jurors may schedule finalize — first one
    // wins, the rest revert silently with "Already resolved", harmless.
    const COMMIT_WINDOW_MS = 20_000
    const REVEAL_WINDOW_MS = 20_000
    const REVEAL_GRACE_MS = 3_000
    const FINALIZE_GRACE_MS = 3_000
    const revealDelay = COMMIT_WINDOW_MS + REVEAL_GRACE_MS
    const finalizeDelay = COMMIT_WINDOW_MS + REVEAL_WINDOW_MS + FINALIZE_GRACE_MS

    this.pendingReveals.set(nodeId, {
      taskId,
      accusedGuilty,
      salt,
      revealAt: Date.now() + revealDelay,
    })

    setTimeout(() => {
      this.tryReveal(nodeId).catch(err =>
        console.error(`[Agent ${myAgentId}] reveal scheduler error for ${nodeId}:`, err),
      )
    }, revealDelay)

    setTimeout(() => {
      this.deps.chain.finalizeChallenge(nodeId).catch(err =>
        console.log(`[Agent ${myAgentId}] finalize attempt for ${nodeId} skipped: ${err?.message ?? err}`),
      )
    }, finalizeDelay)
  }

  /**
   * Send the second half of the commit-reveal pair. Called by the timer set
   * up in onChallengeRaised. Idempotent at the contract layer (revealVote
   * reverts if we already revealed), so retries from a manual nudge are safe.
   */
  private async tryReveal(nodeId: string): Promise<void> {
    const pending = this.pendingReveals.get(nodeId)
    if (!pending) return
    const myAgentId = this.deps.config.agentId
    try {
      await this.deps.chain.revealVoteOnChallenge(nodeId, pending.accusedGuilty, pending.salt)
      console.log(
        `[Agent ${myAgentId}] revealed vote for ${nodeId}: ${pending.accusedGuilty ? 'GUILTY' : 'INNOCENT'}`,
      )
      this.deps.network.emit(this.buildEvent(EventType.JUROR_VOTED, {
        nodeId,
        taskId: pending.taskId,
        agentId: myAgentId,
        accusedGuilty: pending.accusedGuilty,
      })).catch(() => { })
    } catch (err) {
      console.warn(`[Agent ${myAgentId}] reveal failed for ${nodeId}:`, err)
    } finally {
      this.pendingReveals.delete(nodeId)
    }
  }

  private async onTaskReopened(event: AXLEvent<any>): Promise<void> {
    const { nodeId, taskId } = event.payload

    // Kendi yayınladığımız REOPEN event'inde re-claim'e gitmeyelim:
    //   1) challengeNode sonrası bu task'tan zaten çekildik (currentTaskId temizlendi).
    //   2) Vault `slashSubtaskPartial` sadece QUORUM sonrası subtask stake'ini
    //      temizliyor — kimse oy vermediyse stake hâlâ bizde kilitli, yeniden
    //      stakeForSubtask çağırırsak "Already staked" revert'ine düşeriz.
    //   3) Adillik: kendi challenge ettiğimiz node'u kendimiz tekrar almak
    //      ekonomik olarak garip; başka agent'lara bırak.
    if (event.agentId === this.deps.config.agentId) {
      return
    }

    const task = this.tasks.get(taskId)
    if (!task) return

    const node = task.nodes.find(n => n.id === nodeId)
    if (node) {
      node.status = undefined as any
      node.outputHash = undefined
    }

    // Try once immediately in case the on-chain reset has already landed
    // (jury hit quorum before this event reached us). If still un-claimed
    // locally afterwards, schedule a polling watchdog — the vault only
    // resets the node after QUORUM guilty votes or finalizeExpired.
    await this.claimFirstAvailable(taskId)

    const fresh = task.nodes.find(n => n.id === nodeId)
    if (fresh && fresh.status !== 'claimed' && fresh.status !== 'done') {
      this.scheduleReopenWatchdog(nodeId, taskId)
    }
  }

  /**
   * After a CHALLENGE, the vault only calls registry.resetNode once the
   * commit-reveal flow finalizes with a majority-guilty verdict. Until that
   * happens, claimSubtask returns false because claimedBy is still the
   * slashed worker. Poll the registry periodically and re-attempt the claim
   * once the slot is empty. Also nudges finalize() every few iterations so
   * a fully-revealed window resolves without a manual operator step.
   */
  private scheduleReopenWatchdog(nodeId: string, taskId: string): void {
    // Tight polling to match the demo-tuned commit+reveal total of ~50s.
    // Each commit-side juror also schedules a one-shot finalize, so this
    // watchdog is mostly a safety net for the re-claim path after resetNode.
    const POLL_MS = 5_000
    // ~5 minutes of total runway — well past the ~1-min resolution window,
    // covers retries when 0G testnet RPC throttles individual finalize calls.
    const MAX_ITERATIONS = 60
    const ZERO = '0x0000000000000000000000000000000000000000'
    let attempt = 0
    const agentId = this.deps.config.agentId

    const tick = async (): Promise<void> => {
      attempt++
      const task = this.tasks.get(taskId)
      if (!task) return // task abandoned / completed
      const node = task.nodes.find(n => n.id === nodeId)
      if (node && (node.status === 'claimed' || node.status === 'done')) return
      if (attempt > MAX_ITERATIONS) {
        console.log(`[Agent ${agentId}] reopen watchdog: giving up on ${nodeId}`)
        return
      }

      // Best-effort kick to close the challenge once the reveal window has
      // elapsed. Reverts with "Reveal still open" before the deadline;
      // harmless to attempt.
      if (attempt % 4 === 0) {
        try {
          await this.deps.chain.finalizeChallenge(nodeId)
        } catch { /* expected before reveal deadline */ }
      }

      try {
        const claimant = await this.deps.chain.getNodeClaimant(nodeId)
        if (!claimant || claimant.toLowerCase() === ZERO) {
          console.log(`[Agent ${agentId}] reopen watchdog: ${nodeId} reset detected, retrying claim`)
          await this.claimFirstAvailable(taskId)
        }
      } catch (err) {
        console.warn(`[Agent ${agentId}] reopen watchdog poll failed:`, err)
      }

      setTimeout(tick, POLL_MS)
    }

    setTimeout(tick, POLL_MS)
  }

  /**
   * Keeper-timeout watchdog. When DAG_VALIDATING fires and we are NOT the
   * planner, schedule a one-shot timer; on fire, check the chain and call
   * `forceComplete` if the planner-keeper still hasn't settled.
   *
   * Why this exists: `validateLastNodeAsPlanner` runs only on the agent
   * whose `plannerFor` set has the taskId — and that set is in-memory.
   * If the planner's process restarted after registerDAG (or the agent
   * crashed silently between submitOutput batches), no one acts on the
   * DAG_VALIDATING event and the task hangs forever, locking every
   * worker's stake AND the user's budget. The on-chain
   * `DAGRegistry.forceComplete` provides the permissionless escape; this
   * watchdog is what *triggers* it from the swarm side without manual
   * operator intervention.
   *
   * Multiple peers may schedule this for the same task — that's fine.
   * forceComplete is idempotent on-chain: the first caller wins, the
   * rest revert "Task already finalized" (caught + logged at debug).
   * Adapters that don't implement it (mock without override) just no-op.
   */
  private scheduleKeeperWatchdog(taskId: string): void {
    if (this.keeperWatchdogScheduled.has(taskId)) return
    this.keeperWatchdogScheduled.add(taskId)
    const agentId = this.deps.config.agentId

    // On-chain KEEPER_TIMEOUT = 90s; pad a bit so a marginal block-time
    // race doesn't trigger the "Keeper still has time" revert. With ~3s
    // 0G testnet block time, +20s grace is plenty.
    const FIRE_AFTER_MS = 110_000
    setTimeout(async () => {
      // Cleanup-on-completion already happens in DAG_COMPLETED handler;
      // the dedupe entry's only job here is to gate the *next* schedule.
      // Drop it now so a follow-up DAG_VALIDATING (e.g. operator
      // re-broadcast) can re-arm the watchdog if this round failed.
      this.keeperWatchdogScheduled.delete(taskId)

      // Fast-path skip: if isTaskFinalized is supported AND the chain
      // says yes, don't even attempt forceComplete (saves an RPC + a
      // potential pending-tx slot). Falls through to the attempt when
      // the read fails — the on-chain `notFinalized(taskId)` modifier
      // is the authoritative check.
      try {
        const finalized = await this.deps.chain.isTaskFinalized?.(taskId)
        if (finalized === true) {
          console.log(`[Agent ${agentId}] keeper watchdog: ${taskId} already finalized — no-op`)
          return
        }
      } catch (err) {
        console.warn(`[Agent ${agentId}] keeper watchdog isTaskFinalized check failed:`, err)
      }

      if (typeof this.deps.chain.forceComplete !== 'function') {
        console.warn(`[Agent ${agentId}] keeper watchdog: chain adapter has no forceComplete, skipping`)
        return
      }

      console.log(`[Agent ${agentId}] keeper watchdog FIRE: calling forceComplete for ${taskId}`)
      try {
        await this.deps.chain.forceComplete(taskId)
        console.log(`[Agent ${agentId}] keeper watchdog: forceComplete succeeded for ${taskId}`)
        // Broadcast DAG_COMPLETED so peers + UI flush their busy state
        // without waiting on chain log indexing. settled=true is the
        // signal taskIndex.markCompleted reads on the API side.
        await this.deps.network.emit(this.buildEvent(EventType.DAG_COMPLETED, {
          taskId, settled: true, viaForceComplete: true,
        })).catch(() => {})
      } catch (err: any) {
        // Common benign reverts:
        //   "Keeper still has time"        — clock skew / pre-grace race
        //   "Task already finalized"       — peer's forceComplete won
        //   "Node missing output"          — stuck claim, needs expireClaim first
        // Anything else is worth surfacing — the protocol expects this
        // call to succeed when the precondition holds.
        const msg = err?.shortMessage ?? err?.reason ?? err?.message ?? String(err)
        console.warn(`[Agent ${agentId}] keeper watchdog forceComplete failed for ${taskId}: ${msg}`)
      }
    }, FIRE_AFTER_MS)
  }

  private buildEvent<T>(type: EventType, payload: T): AXLEvent<T> {
    return { type, payload, timestamp: Date.now(), agentId: this.deps.config.agentId }
  }

  /**
   * Planner stake size, in USDC decimal-string form. Set to 10% of the
   * agent's configured stakeAmount — same scale as the per-subtask
   * worker stake — so a stuck planner stake on one task doesn't lock
   * the agent's full bond. The 100%-stake legacy behavior caused a
   * cascade where any settlement failure (markValidatedBatch revert,
   * settleTask revert, RPC drop mid-flight) left the agent unable to
   * be planner on ANY future task until manual operator forceComplete.
   * The keeper watchdog auto-recovers locked stakes after KEEPER_TIMEOUT
   * (~110s with grace), so the only durable cost of using a smaller
   * planner stake is a slightly smaller slashable collateral against
   * malicious planning — acceptable trade-off vs. agent bricking.
   */
  private plannerStakeAmount(): string {
    const totalStake = parseFloat(this.deps.config.stakeAmount || '100')
    return (totalStake * 0.1).toString()
  }

  /**
   * Settlement split: 20% to planner, 80% split equally among the workers
   * who claimed subtasks. Returns parallel addresses[]/amounts[] arrays for
   * SwarmEscrow.settleWithAmounts; the planner is always at index 0.
   *
   * If the planner also worked on a subtask, their address legitimately
   * appears twice — the escrow refunds their stake on the first iteration
   * and treats the second as a pure reward, which is correct.
   */
  private computePayouts(
    budget: bigint,
    plannerAddr: string,
    workerAddrs: string[],
  ): { addresses: string[]; amounts: bigint[] } {
    const PLANNER_BPS = 2000n // 20%
    const WORKER_BPS = 8000n  // 80%
    const BPS = 10000n

    const plannerShare = (budget * PLANNER_BPS) / BPS
    const workerPool = (budget * WORKER_BPS) / BPS
    const workerShare = workerAddrs.length > 0
      ? workerPool / BigInt(workerAddrs.length)
      : 0n

    const addresses = [plannerAddr, ...workerAddrs]
    const amounts = [plannerShare, ...workerAddrs.map(() => workerShare)]
    return { addresses, amounts }
  }
}
