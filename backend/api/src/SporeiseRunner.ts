import { ethers } from 'ethers'
import crypto from 'node:crypto'
import DAGRegistryABI from '../../../contracts/artifacts/src/DAGRegistry.sol/DAGRegistry.json'
import AgentRegistryABI from '../../../contracts/artifacts/src/AgentRegistry.sol/AgentRegistry.json'
import deployments from '../../../contracts/deployments/og_testnet.json'
import { getChainClient } from './v1/chain'
import { meterAndDebit, formatUsdc } from './lib/gasMeter'
import { sealToString, openFromString } from './lib/masterKeyCrypto'
import type { SporeiseStore, SporeiseAgentInfo } from './v1/sporeiseStore'
import type { IStoragePort } from '../../../shared/ports'

/**
 * SporeiseRunner — per-task state machine for SDK-supplied LangChain
 * agents. Mirrors what SwarmAgent does on the agent side, except:
 *
 *   - Compute is REMOTE: each plan / execute / judge call goes back to
 *     the SDK process over WebSocket. The Runner doesn't run any LLMs.
 *   - No stake / no slash. Workers don't lock USDC, no SlashingVault
 *     calls. Validation is "next worker judges" (option A); on reject
 *     the Runner reassigns the subtask to a different agent and the
 *     bad output is dropped (no stake to slash).
 *   - Every on-chain tx the operator submits is metered through
 *     `gasMeter.meterAndDebit` and billed against the user's Treasury.
 *
 * The Runner uses the EXISTING DAGRegistry / AgentRegistry contracts
 * verbatim — it just skips the SwarmEscrow-stake calls. `stakeForSubtask`
 * is never called; `markValidatedBatch` is called at the end and works
 * because `releaseSubtaskStake` is idempotent on zero-stake nodes.
 *
 * The Runner is operator-driven: agent EOAs are minted at register time
 * and sign their own claim/submit txs (via the operator-held PK), so the
 * on-chain trail still shows distinct claimants per node — the swarm
 * "looks the same" from outside, even though the same operator is
 * paying gas behind every signature.
 */

// ─── Wire bridge: callbacks the route handler injects ──────────────

export interface RunnerInvoker {
  /** Send a plan request and await the SDK's reply. Throws on transport
   *  error or `error` message from SDK. */
  invokePlan(agentId: string, taskId: string, spec: string): Promise<{ subtasks: Array<{ id: string; spec: string }> }>
  invokeExecute(agentId: string, taskId: string, nodeId: string, subtask: string, context: string | null): Promise<{ output: string }>
  invokeJudge(agentId: string, taskId: string, nodeId: string, subtask: string, output: string): Promise<{ valid: boolean; reason?: string }>
}

export interface RunnerEventEmitter {
  emit(taskId: string, event: SporeiseEvent): void
}

export interface NodeReceipt {
  node_id: string
  node_id_bytes32: string
  agent_id: string
  agent_address: string
  output_hash: string
  subtask: string
}

export type SporeiseEvent =
  | { kind: 'task_started'; planner_id: string }
  | { kind: 'dag_ready'; nodes: Array<{ id: string; subtask: string }> }
  | { kind: 'subtask_claimed'; node_id: string; agent_id: string }
  | { kind: 'subtask_done'; node_id: string; agent_id: string; output_hash: string }
  | { kind: 'subtask_validated'; node_id: string; valid: boolean; reason?: string }
  | { kind: 'subtask_retrying'; node_id: string; reason: string; next_agent_id: string }
  | {
      kind: 'task_completed'
      result: string
      /** USDC actually debited from the user's Treasury balance. */
      gas_charged: string
      /** USDC the user *would have been charged* had the operator
       *  config been correct. Equal to `gas_charged` when billing
       *  works; greater when the operator is absorbing cost (read
       *  the API's `[gasMeter] Treasury operator mismatch` warning).
       *  Surfaced so users can audit their bill before rotation lands. */
      gas_would_have_been: string
      balance_remaining: string
      task_id_bytes32: string
      nodes: NodeReceipt[]
    }
  | { kind: 'task_failed'; reason: string; phase: string }

export interface StartTaskInput {
  /** Server-issued task id (UUID-ish). */
  taskId: string
  /** SDK-supplied spec. Stored on 0G Storage; its hash becomes the
   *  on-chain bytes32 task id. */
  spec: string
  /** EOA of the API key owner — Treasury debit target. */
  userAddress: string
  /** Sporeise'd agent set this user has registered. The Runner picks
   *  planner + workers from this list. Order is the canonical
   *  round-robin order (FCFS-equivalent for a single-tenant swarm). */
  agents: SporeiseAgentInfo[]
  /** Hard cap on total wall time before the Runner gives up. */
  timeoutMs: number
}

// ─── Helpers ────────────────────────────────────────────────────────

function bytes32(s: string): string {
  return s.startsWith('0x') && s.length === 66 ? s : ethers.id(s)
}

function normalizeBytes32(hash: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(hash)) return hash
  return ethers.keccak256(ethers.toUtf8Bytes(hash))
}

const STATUS_PENDING = 0
const STATUS_RUNNING = 1
const STATUS_NUM_TO_STR: Record<number, 'pending' | 'running' | 'stopped' | 'error'> = {
  0: 'pending', 1: 'running', 2: 'stopped', 3: 'error',
}

/** Matches the AgentRegistry.register convention used in `AgentRunner.ts`. */
function toBytes32Id(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label))
}

// Native OG floor each ephemeral agent EOA must hold to sign its own
// claim/submit txs in the runner. Tuned for ~10 txs per task at testnet
// gas prices (~2e7 wei/gas × 21k–80k gas per tx = ~2e12 wei = 2e-6 OG;
// 0.05 OG is ~25_000 such txs of headroom, plenty for any realistic
// session). Override via SPOREISE_AGENT_PREFUND_OG env.
const AGENT_PREFUND_OG = process.env.SPOREISE_AGENT_PREFUND_OG ?? '0.05'
// Top-up triggers when balance falls below half the floor. Avoids
// re-funding on every register call when the wallet is still healthy.
const PREFUND_FLOOR_WEI = ethers.parseEther(AGENT_PREFUND_OG)
const PREFUND_TRIGGER_WEI = PREFUND_FLOOR_WEI / 2n

// ─── Operator-side agent registration ──────────────────────────────

export interface RegisterResult {
  /** Agents that already existed for this user — re-used unchanged. */
  existing: SporeiseAgentInfo[]
  /** Newly created agents (fresh on-chain registration). */
  fresh: SporeiseAgentInfo[]
  /** USDC base units billed against Treasury for `fresh` registrations. */
  gasChargedWei: bigint
  /** Treasury balance after the debit, USDC base units. */
  balanceAfterWei: bigint
}

export class SporeiseRegistrar {
  private readonly registryAddr: string
  private readonly registry: ethers.Contract | null
  // chain.ts now hands back a NonceManager-wrapped operator signer so
  // every consumer (here, AgentRunner, BridgeWatcher) shares one nonce
  // counter — see chain.ts ChainClient.ogWallet rationale.
  private readonly fundingSigner: ethers.NonceManager | null
  private readonly provider: ethers.JsonRpcProvider

  constructor(private readonly store: SporeiseStore) {
    const client = getChainClient()
    this.provider = client.ogProvider
    this.fundingSigner = client.ogWallet
    this.registryAddr = process.env.L2_AGENT_REGISTRY_ADDRESS || (deployments as any).AgentRegistry || ''
    if (this.fundingSigner && this.registryAddr) {
      this.registry = new ethers.Contract(this.registryAddr, AgentRegistryABI.abi, this.fundingSigner)
    } else {
      this.registry = null
    }
  }

  /** Register N agents for `userAddress`. Existing labels short-circuit
   *  on-chain registration but STILL get a balance top-up if their
   *  ephemeral wallet has drifted below the prefund floor — without it
   *  a long-lived agent eventually runs out of gas mid-claim.
   *
   *  Note: stake amount on-chain is set to 0 — sporeise'd agents don't
   *  stake. AgentRegistry accepts uint256 0 as a valid value. */
  async registerMany(
    userAddress: string,
    requests: Array<{ id: string; description?: string; model?: string }>,
  ): Promise<RegisterResult> {
    if (!this.registry || !this.fundingSigner) {
      throw new Error('[SporeiseRegistrar] AgentRegistry / operator wallet not configured')
    }

    const existing: SporeiseAgentInfo[] = []
    const fresh: SporeiseAgentInfo[] = []
    let gasChargedWei = 0n

    for (const req of requests) {
      // Idempotency: same (user, label) → same on-chain EOA, no churn.
      const found = this.store.getByLabel(userAddress, req.id)
      if (found) {
        // Top up the existing wallet if its OG balance has fallen below
        // the floor (prior runs spent it). Skip if already healthy so we
        // don't burn gas on no-op transfers.
        const debited = await this.ensureGasFloor(found.agent_address, userAddress)
        gasChargedWei += debited
        existing.push({
          id: found.id,
          agentLabel: found.agent_label,
          agentAddress: found.agent_address,
          description: found.description,
          model: found.model,
          createdAt: found.created_at,
        })
        continue
      }

      // 1. Mint EOA, persist encrypted PK.
      const wallet = ethers.Wallet.createRandom()
      const pkSealed = sealToString(wallet.privateKey)
      const rowId = crypto.randomUUID()

      // 2. Prefund native OG so the agent can sign its OWN claim/submit
      //    txs in the runner. AgentRegistry.register below is operator-
      //    signed (operator pays gas), but DAGRegistry.claimPlanner /
      //    claimSubtask / submitOutput must be signed by the agent's
      //    EOA so on-chain `claimedBy` reflects the actual agent — and
      //    those txs need OG in the agent's wallet to clear gas.
      const prefundDebit = await this.ensureGasFloor(wallet.address, userAddress)
      gasChargedWei += prefundDebit

      // 3. On-chain register. stakeAmount=0 — sporeise'd agents don't stake.
      const onchainId = toBytes32Id(req.id + ':' + userAddress)  // dedupe by (user,label) on-chain
      const tx1 = await this.registry.register(
        onchainId,
        wallet.address,
        req.description ?? `${req.id} (sporeise)`,
        req.model ?? 'langchain',
        0,
      )
      const r1 = await tx1.wait()
      const debit1 = await meterAndDebit(userAddress, r1, tx1)
      gasChargedWei += debit1.amountWei

      const tx2 = await this.registry.setStatus(onchainId, STATUS_RUNNING)
      const r2 = await tx2.wait()
      const debit2 = await meterAndDebit(userAddress, r2, tx2)
      gasChargedWei += debit2.amountWei

      // 3. Store the row only AFTER on-chain register succeeds — a chain
      //    revert mid-flight leaves no orphan SQLite row.
      const info = this.store.insert({
        id: rowId,
        userAddress,
        agentLabel: req.id,
        agentAddress: wallet.address,
        pkEncrypted: pkSealed,
        description: req.description ?? null,
        model: req.model ?? 'langchain',
      })
      fresh.push(info)
    }

    const client = getChainClient()
    const balanceAfter = (await client.readTreasury.balanceOf(userAddress)) as bigint
    return { existing, fresh, gasChargedWei, balanceAfterWei: balanceAfter }
  }

  /** Read the agent EOA's native OG balance; if below the trigger, send
   *  enough OG to reach the floor. Returns USDC base units debited from
   *  Treasury for the top-up tx (0n if no top-up was needed).
   *
   *  Note: only the *gas* of the top-up tx is metered through Treasury.
   *  The OG value being moved (~0.05 OG) is not separately billed —
   *  it's the operator funding the agent's future gas. When that agent
   *  later signs txs, those tx receipts get metered (gasUsed × gasPrice
   *  → USDC) at the point of use, so accounting stays consistent: the
   *  user pays for the gas the agent actually burns, not for the OG
   *  sitting in the wallet. Residual OG on completion is operator
   *  overhead — it's the cost of one wallet's existence. */
  private async ensureGasFloor(agentAddress: string, userAddress: string): Promise<bigint> {
    if (!this.fundingSigner) return 0n
    let balance: bigint
    try {
      balance = await this.provider.getBalance(agentAddress)
    } catch (err) {
      console.warn(`[SporeiseRegistrar] balance read for ${agentAddress} failed (will attempt prefund anyway):`, err)
      balance = 0n
    }
    if (balance >= PREFUND_TRIGGER_WEI) return 0n

    const topUpAmount = PREFUND_FLOOR_WEI - balance
    try {
      const tx = await this.fundingSigner.sendTransaction({
        to: agentAddress,
        value: topUpAmount,
      })
      const receipt = await tx.wait()
      const debit = await meterAndDebit(userAddress, receipt, tx)
      console.log(
        `[SporeiseRegistrar] funded ${agentAddress.slice(0, 10)}… with ${ethers.formatEther(topUpAmount)} OG (tx ${tx.hash.slice(0, 10)}…)`,
      )
      return debit.amountWei
    } catch (err) {
      // Operator wallet broke (insufficient funds / RPC error). Surface
      // loudly — without OG the agent's later txs all revert. Caller
      // (registerMany) will continue but the user's task will fail at
      // claim_planner with "insufficient funds", same as before.
      console.error(`[SporeiseRegistrar] FAILED to prefund ${agentAddress}:`, (err as Error).message)
      return 0n
    }
  }
}

// ─── Per-task runner ────────────────────────────────────────────────

export class SporeiseTaskRunner {
  private readonly dagRegistry: ethers.Contract
  private readonly fundingSigner: ethers.NonceManager

  constructor(
    private readonly store: SporeiseStore,
    private readonly storage: IStoragePort,
    private readonly invoker: RunnerInvoker,
    private readonly events: RunnerEventEmitter,
  ) {
    const client = getChainClient()
    if (!client.ogWallet) {
      throw new Error('[SporeiseTaskRunner] operator wallet not configured')
    }
    this.fundingSigner = client.ogWallet
    const dagAddr = process.env.L2_DAG_REGISTRY_ADDRESS || (deployments as any).DAGRegistry
    if (!dagAddr) throw new Error('[SporeiseTaskRunner] DAGRegistry address missing')
    // Operator-signed contract for createTask / register / claim ops on
    // behalf of agents. Per-agent signing is done with each agent's own
    // wallet (loaded from the encrypted store) so on-chain trail stays
    // distinct.
    this.dagRegistry = new ethers.Contract(dagAddr, DAGRegistryABI.abi, this.fundingSigner)
  }

  /** Drive a task end-to-end. Resolves with the final answer; throws on
   *  unrecoverable error (state will be reflected via `task_failed`
   *  event before the throw). Caller (the route handler) catches and
   *  forwards to the SDK over WS. */
  async run(input: StartTaskInput): Promise<{ result: string; gasCharged: string; balanceRemaining: string }> {
    const { taskId, spec, userAddress, agents, timeoutMs } = input
    if (agents.length === 0) {
      throw runFail('billing', 'No agents registered for this API key — call sporeise() first')
    }
    const deadline = Date.now() + timeoutMs
    // Tracks USDC actually moved (Treasury.debitBalance succeeded).
    let totalGasWei = 0n
    // Tracks USDC that WOULD have moved had operator config been correct.
    // When operator rotation lands these two converge; until then this
    // is the "real" billing the user can audit off-chain.
    let totalGasWouldHaveBeenWei = 0n
    let lastBalanceWei = 0n
    // Per-node on-chain proof — populated as each subtask lands its
    // submitOutput tx; surfaced on task_completed so the SDK can verify.
    const nodeReceipts: NodeReceipt[] = []
    const debit = async (label: string, receipt: any, tx: any) => {
      try {
        const r = await meterAndDebit(userAddress, receipt, tx)
        totalGasWei += r.amountWei
        totalGasWouldHaveBeenWei += r.shouldHaveDebitedWei
        lastBalanceWei = r.balanceWei
        if (!r.paidInFull) {
          throw runFail('billing', `Treasury debit failed at "${label}" — balance ${formatUsdc(r.balanceWei)} USDC, top up`)
        }
      } catch (err) {
        if ((err as any)?.__sporeFail) throw err
        throw runFail('billing', `meterAndDebit threw at "${label}": ${(err as Error).message}`)
      }
    }

    const remainingMs = () => deadline - Date.now()
    const checkDeadline = (phase: string) => {
      if (remainingMs() <= 0) throw runFail(phase, `wall-clock deadline exceeded`)
    }

    // ─── 1. Pick planner — round-robin first agent for this task. ─────
    // Future: rotate across runs by hashing taskId mod agents.length.
    // ALL invoker / event payloads use the SDK-supplied label (agentLabel)
    // as the agent_id — that's the key the SDK has in its local
    // LangChainAgent map. The internal SQLite UUID stays server-side.
    const planner = agents[0]
    this.events.emit(taskId, { kind: 'task_started', planner_id: planner.agentLabel })

    // ─── 2. Plan via planner LC agent. ───────────────────────────────
    checkDeadline('plan')
    const planRes = await this.invoker.invokePlan(planner.agentLabel, taskId, spec)
    const subtasks = (planRes.subtasks ?? []).slice(0, 3)
    if (subtasks.length === 0) {
      throw runFail('plan', 'planner returned an empty subtask list')
    }
    // Stable per-task node ids — keccak(taskId, subtask.id) ensures
    // uniqueness across concurrent tasks of the same user.
    const nodes = subtasks.map((s, i) => ({
      id: `${taskId}:${s.id || `node-${i + 1}`}`,
      subtask: s.spec,
    }))
    this.events.emit(taskId, { kind: 'dag_ready', nodes: nodes.map(n => ({ id: n.id, subtask: n.subtask })) })

    // ─── 3. Spec → 0G Storage → bytes32 task id. ─────────────────────
    // 0G Storage costs are operator-paid (no per-call gas billing today —
    // append() doesn't return a receipt). Spore SLA covers the cost.
    let specHash: string
    try {
      specHash = await this.storage.append({ spec, taskId, agents: agents.map(a => a.agentLabel) })
    } catch (err) {
      throw runFail('storage', `spec append failed: ${(err as Error).message}`)
    }
    const taskIdBytes32 = bytes32(specHash)

    // ─── 4. Planner claims + registers DAG. ──────────────────────────
    // Use planner's OWN wallet (from store) so on-chain claimedBy matches
    // the agent's distinct EOA.
    const plannerWallet = this.walletFor(planner)
    const dagAsPlanner = this.dagRegistry.connect(plannerWallet) as ethers.Contract

    checkDeadline('claim_planner')
    try {
      const tx = await dagAsPlanner.claimPlanner(taskIdBytes32)
      const r = await tx.wait()
      await debit('claimPlanner', r, tx)
    } catch (err) {
      throw runFail('claim_planner', `claimPlanner reverted: ${(err as Error).message}`)
    }

    checkDeadline('register_dag')
    const nodeIdsBytes32 = nodes.map(n => bytes32(n.id))
    try {
      const tx = await dagAsPlanner.registerDAG(taskIdBytes32, nodeIdsBytes32)
      const r = await tx.wait()
      await debit('registerDAG', r, tx)
    } catch (err) {
      throw runFail('register_dag', `registerDAG reverted: ${(err as Error).message}`)
    }

    // ─── 5. Per-node loop: claim → execute → submit → judge. ─────────
    const workerOrder = agents.length === 1 ? agents : agents.slice(1)  // exclude planner if possible
    let lastOutput: string | null = null
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const isLast = i === nodes.length - 1

      // Worker assignment: round-robin over the non-planner pool.
      // Retry-on-reject reassigns within the same pool, picking next.
      let workerIdx = i % workerOrder.length
      let attempts = 0
      const maxAttempts = Math.min(workerOrder.length, 3)
      let validatedOutput: string | null = null

      while (attempts < maxAttempts) {
        attempts++
        const worker = workerOrder[workerIdx]

        // Claim
        const workerWallet = this.walletFor(worker)
        const dagAsWorker = this.dagRegistry.connect(workerWallet) as ethers.Contract
        const nodeIdB = bytes32(node.id)

        checkDeadline('claim_subtask')
        try {
          const tx = await dagAsWorker.claimSubtask(nodeIdB)
          const r = await tx.wait()
          await debit('claimSubtask', r, tx)
        } catch (err) {
          // Tx-level revert (rare on claimSubtask — usually nonce / RPC).
          this.events.emit(taskId, {
            kind: 'subtask_retrying',
            node_id: node.id,
            reason: `claim reverted: ${(err as Error).message.slice(0, 120)}`,
            next_agent_id: workerOrder[(workerIdx + 1) % workerOrder.length].agentLabel,
          })
          workerIdx = (workerIdx + 1) % workerOrder.length
          continue
        }

        // CRITICAL: DAGRegistry.claimSubtask returns `false` (instead of
        // reverting) when the slot is already taken — ethers reports a
        // successful tx, but the on-chain `claimedBy` is still the
        // previous worker. The follow-up `submitOutput` would then revert
        // with "Only claimant". Read back to confirm we actually own the
        // slot before doing any more work; if not, this node was already
        // claimed by someone else (most likely a stale claim from a
        // previous run since sporeise has no on-chain reset path) and we
        // bail with a clear error.
        try {
          const onchain = await this.dagRegistry.nodes(nodeIdB)
          const claimedBy: string = onchain.claimedBy ?? onchain[2]
          if (claimedBy.toLowerCase() !== worker.agentAddress.toLowerCase()) {
            throw runFail(
              'claim_subtask',
              `claimSubtask succeeded but on-chain claimedBy is ${claimedBy} (expected ${worker.agentAddress}). ` +
              `Node likely held by a stale claim; sporeise has no resetNode path. Re-run with fresh agent ids.`,
            )
          }
        } catch (err) {
          if ((err as any)?.__sporeFail) throw err
          // Read failure — soft-fail so RPC blips don't kill the task.
          console.warn(`[sporeise/run] claim read-back failed for ${node.id}, proceeding optimistically:`, (err as Error).message)
        }

        this.events.emit(taskId, { kind: 'subtask_claimed', node_id: node.id, agent_id: worker.agentLabel })

        // Same-worker retry loop. DAGRegistry.submitOutput is overwrite-
        // capable (no check that outputHash was already set), so we can
        // re-call execute on the same agent with a "your previous answer
        // was rejected because X, do better" hint and submit a fresh
        // output that overwrites the stale one. This sidesteps the lack
        // of an on-chain resetNode path for sporeise (vault-only) — the
        // SAME worker keeps its claim, just produces a new output.
        const MAX_REWRITES = 2  // initial + 2 retries = 3 total attempts
        let lastVerdict: { valid: boolean; reason?: string } = { valid: true }
        let lastExecuteOut = ''
        let lastOutputHash = ''
        let rewriteHint: string | undefined
        let rewrites = 0

        while (rewrites <= MAX_REWRITES) {
          // Execute (remote, over WS) — pass the SDK label, not internal UUID.
          // On retry: bake the rejection reason into the subtask string so
          // the LLM sees what the judge complained about.
          const subtaskForCall = rewriteHint
            ? `${node.subtask}\n\n[REVISION REQUESTED — your previous answer was rejected by the validator: "${rewriteHint}". Address the issue concretely and re-output the FULL answer, not a diff.]`
            : node.subtask
          let executeOut: { output: string }
          checkDeadline('execute')
          try {
            executeOut = await this.invoker.invokeExecute(worker.agentLabel, taskId, node.id, subtaskForCall, lastOutput)
          } catch (err) {
            throw runFail('execute', `worker ${worker.agentLabel} execute failed: ${(err as Error).message}`)
          }
          lastExecuteOut = executeOut.output

          // Persist + on-chain submit (overwrites prior outputHash slot)
          let outputHash: string
          try {
            outputHash = await this.storage.append({
              taskId, nodeId: node.id, subtask: node.subtask, output: executeOut.output, agentId: worker.agentLabel,
              attempt: rewrites + 1,
            })
          } catch (err) {
            throw runFail('storage', `output append failed: ${(err as Error).message}`)
          }
          lastOutputHash = outputHash

          checkDeadline('submit_output')
          try {
            const tx = await (dagAsWorker as any).submitOutput(nodeIdB, normalizeBytes32(outputHash))
            const r = await tx.wait()
            await debit('submitOutput', r, tx)
          } catch (err) {
            throw runFail('submit_output', `submitOutput reverted: ${(err as Error).message}`)
          }
          this.events.emit(taskId, {
            kind: 'subtask_done', node_id: node.id, agent_id: worker.agentLabel, output_hash: outputHash,
          })

          // Judge — option A: NEXT worker validates. For the last node,
          // pick any agent other than the worker (planner usually).
          const judgeAgent = isLast
            ? agents.find(a => a.agentLabel !== worker.agentLabel) ?? worker
            : workerOrder[(workerIdx + 1) % workerOrder.length]

          if (judgeAgent.agentLabel === worker.agentLabel) {
            // 1-agent swarm — no peer judge available, trust the output.
            lastVerdict = { valid: true, reason: 'no peer judge available' }
          } else {
            checkDeadline('judge')
            try {
              lastVerdict = await this.invoker.invokeJudge(
                judgeAgent.agentLabel, taskId, node.id, node.subtask, executeOut.output,
              )
            } catch (err) {
              // Transport error → fail-OPEN (accept). Sporeise has no
              // stake/slash to disincentivise judge over-rejection.
              lastVerdict = { valid: true, reason: `judge transport error: ${(err as Error).message.slice(0, 120)}` }
            }
          }
          this.events.emit(taskId, {
            kind: 'subtask_validated', node_id: node.id, valid: lastVerdict.valid, reason: lastVerdict.reason,
          })

          if (lastVerdict.valid) break

          // Reject path: ask the SAME worker for a revision (cheaper than
          // cross-agent reclaim, doesn't need on-chain reset).
          if (rewrites >= MAX_REWRITES) {
            console.warn(
              `[sporeise/run] task=${taskId.slice(0, 8)} node=${node.id.slice(-8)} judge rejected after ${rewrites + 1} attempt(s) by ${judgeAgent.agentLabel} (${lastVerdict.reason ?? 'no reason'}); accepting last output`,
            )
            break
          }
          rewrites++
          rewriteHint = lastVerdict.reason ?? 'previous answer marked invalid'
          this.events.emit(taskId, {
            kind: 'subtask_retrying',
            node_id: node.id,
            reason: `judge rejected (attempt ${rewrites}/${MAX_REWRITES + 1}): ${rewriteHint}`,
            next_agent_id: worker.agentLabel,  // SAME agent — retry, not reassign
          })
        }

        validatedOutput = lastExecuteOut
        nodeReceipts.push({
          node_id: node.id,
          node_id_bytes32: bytes32(node.id),
          agent_id: worker.agentLabel,
          agent_address: worker.agentAddress,
          output_hash: lastOutputHash,
          subtask: node.subtask,
        })
        break
      }

      if (validatedOutput == null) {
        throw runFail('judge', `node ${node.id} could not produce a validated output`)
      }
      lastOutput = validatedOutput
    }

    // ─── 6. Mark all nodes validated (releases zero-stake silently). ──
    checkDeadline('finalize')
    try {
      const tx = await dagAsPlanner.markValidatedBatch(nodeIdsBytes32)
      const r = await tx.wait()
      await debit('markValidatedBatch', r, tx)
    } catch (err) {
      // Non-fatal — output already in storage, hash on-chain. We still
      // surface task_completed so the user gets their result; the
      // markValidated row just stays "false" on chain. The user can
      // retry it later via a separate route if needed.
      console.warn(`[SporeiseTaskRunner] markValidatedBatch failed (non-fatal):`, err)
    }

    // ─── 7. Done. Emit + return. ─────────────────────────────────────
    const result = lastOutput ?? ''
    const gasCharged = formatUsdc(totalGasWei)
    const gasWouldHaveBeen = formatUsdc(totalGasWouldHaveBeenWei)
    const balanceRemaining = formatUsdc(lastBalanceWei)
    // Audit log — single line per completed run with both numbers,
    // grep-friendly. Lets the operator reconcile off-chain bills with
    // on-chain debits before rotation lands.
    if (totalGasWouldHaveBeenWei > 0n && totalGasWei !== totalGasWouldHaveBeenWei) {
      console.log(
        `[sporeise/billing] task=${taskId.slice(0, 12)} user=${userAddress} ` +
        `actually_debited=${gasCharged} USDC owed=${gasWouldHaveBeen} USDC ` +
        `(operator absorbed ${formatUsdc(totalGasWouldHaveBeenWei - totalGasWei)} — rotate to enable real billing)`,
      )
    } else if (totalGasWei > 0n) {
      console.log(`[sporeise/billing] task=${taskId.slice(0, 12)} user=${userAddress} debited=${gasCharged} USDC`)
    }
    this.events.emit(taskId, {
      kind: 'task_completed',
      result,
      gas_charged: gasCharged,
      gas_would_have_been: gasWouldHaveBeen,
      balance_remaining: balanceRemaining,
      task_id_bytes32: taskIdBytes32,
      nodes: nodeReceipts,
    })
    return { result, gasCharged, balanceRemaining }
  }

  /** Load an agent's wallet from the encrypted store, lazy-cached for
   *  the lifetime of the process so we don't pay the AES decrypt on
   *  every per-tx signer. Keyed on the internal SQLite id (UUID) so
   *  re-registers under the same label re-use the wallet entry. */
  private walletCache = new Map<string, ethers.Wallet>()
  private walletFor(agent: SporeiseAgentInfo): ethers.Wallet {
    const cached = this.walletCache.get(agent.id)
    if (cached) return cached
    const row = this.store.getRow(agent.id)
    if (!row) throw new Error(`SporeiseTaskRunner: unknown agent id ${agent.id} (label=${agent.agentLabel})`)
    const pk = openFromString(row.pk_encrypted)
    const wallet = new ethers.Wallet(pk, this.fundingSigner.provider)
    this.walletCache.set(agent.id, wallet)
    return wallet
  }
}

// ─── Failure typing ────────────────────────────────────────────────

interface SporeFail extends Error {
  __sporeFail: true
  phase: string
}

function runFail(phase: string, message: string): SporeFail {
  const e = new Error(message) as SporeFail
  e.__sporeFail = true
  e.phase = phase
  return e
}

export function isSporeFail(err: unknown): err is SporeFail {
  return !!err && typeof err === 'object' && (err as any).__sporeFail === true
}
