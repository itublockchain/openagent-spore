import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { getChainClient, USDC_DECIMALS, sendWithNonceRetry } from './v1/chain'

/**
 * Watches `Deposited` events on Base Sepolia from BOTH the legacy
 * USDCGateway (direct deposits) and the CCTPDepositReceiver (cross-chain
 * USDC mints relayed in via Circle CCTP V2). Both contracts emit the
 * exact same event signature, so a single ABI parses both — what differs
 * is which contract address the event came from. We mirror each into
 * SwarmTreasury.balanceOf on 0G.
 *
 * Idempotency: every processed event is keyed by
 *   `${contractAddress}:${txHash}:${logIndex}`
 * and persisted to disk. Per-contract block cursors so adding a new
 * watch source (e.g., another receiver in the future) doesn't reset
 * the others. Old single-cursor state is auto-migrated on first load.
 *
 * On boot we scan from `lastProcessedBlock - 5` (a small overlap to
 * catch reorgs / missed events) up to the current head, then poll every
 * 12s for incremental events. eth_subscribe is avoided because the Base
 * Sepolia public RPC sometimes drops it; polling is robust and the
 * trickle of deposit events doesn't justify the complexity.
 */

const STATE_DIR = process.env.BRIDGE_STATE_DIR || '/data'
const STATE_FILE = 'bridge-watcher.json'
const POLL_INTERVAL_MS = 12_000 // Base block time ~2s; 12s = 6 blocks behind, fine for UX
const REORG_OVERLAP_BLOCKS = 5
const MAX_SCAN_CHUNK = 2_000 // Public RPCs (Base Sepolia) often cap at 2k-5k blocks

type WatchSource = {
  label: string
  address: string
  contract: ethers.Contract
  fallbackStartBlock: number
}

interface PersistedState {
  /** address (lowercase) → last processed block. */
  lastProcessedBlockByContract: Record<string, number>
  /** `${address}:${txHash}:${logIndex}` */
  processedKeys: string[]
  /** Legacy single-cursor field — migrated on load. */
  lastProcessedBlock?: number
}

export class BridgeWatcher {
  private lastProcessedBlockByContract: Record<string, number> = {}
  private processedKeys = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private statePath: string
  private inFlight = false
  private sources: WatchSource[] = []

  constructor() {
    this.statePath = path.join(STATE_DIR, STATE_FILE)
  }

  /** Boot: load persisted state, then run a single catch-up pass and
   *  schedule the periodic poll. Safe to call repeatedly — second call
   *  is a no-op while the first poll is in flight. */
  async start(): Promise<void> {
    const client = getChainClient()
    if (!client.writeTreasury) {
      console.warn('[BridgeWatcher] PRIVATE_KEY missing — bridge disabled (read-only)')
      return
    }

    const head = await client.baseProvider.getBlockNumber().catch(() => 0)

    if (client.gatewayAddr && client.readGateway) {
      this.sources.push({
        label: 'USDCGateway',
        address: client.gatewayAddr.toLowerCase(),
        contract: client.readGateway,
        fallbackStartBlock: Math.max(0, head - 1),
      })
    }
    if (client.cctpReceiverAddr && client.readCctpReceiver) {
      this.sources.push({
        label: 'CCTPDepositReceiver',
        address: client.cctpReceiverAddr.toLowerCase(),
        contract: client.readCctpReceiver,
        // Receiver was deployed at a known block — start there so we
        // don't miss any mints that landed before this watcher booted.
        fallbackStartBlock: client.cctpReceiverDeployBlock || Math.max(0, head - 1),
      })
    }

    if (this.sources.length === 0) {
      console.warn('[BridgeWatcher] no watch sources configured — bridge disabled')
      return
    }

    this.loadState()

    // First-time init per source: pin the cursor so we don't scan
    // unbounded history. Existing entries are kept as-is.
    for (const src of this.sources) {
      if (this.lastProcessedBlockByContract[src.address] == null) {
        this.lastProcessedBlockByContract[src.address] = src.fallbackStartBlock
        console.log(
          `[BridgeWatcher] First-run init for ${src.label} @ ${src.address}: starting at block ${src.fallbackStartBlock}`,
        )
      }
    }
    this.persistState()

    console.log(
      `[BridgeWatcher] starting; sources=[${this.sources
        .map(s => `${s.label}@${s.address.slice(0, 10)}…(block ${this.lastProcessedBlockByContract[s.address]})`)
        .join(', ')}] treasury=${client.treasuryAddr}`,
    )

    // One-shot recovery sweep. Set BRIDGE_RECOVERY=true to scan ALL
    // Deposited events on every watched gateway, ALL Credited events
    // on Treasury, and credit the difference per user. Use this when
    // the old buggy "key-locked-on-pre-submit-error" path stranded
    // user deposits — the new processEvent path handles fresh ones,
    // but historical strands need explicit reconciliation. Runs
    // BEFORE the regular tick loop so the catch-up doesn't race.
    // Remove the env var (or set to false) after one boot cycle.
    if (process.env.BRIDGE_RECOVERY === 'true') {
      try {
        await this.runRecoverySweep()
      } catch (err) {
        console.error('[BridgeWatcher] RECOVERY sweep failed:', err)
      }
    }

    await this.tick().catch(err => console.error('[BridgeWatcher] initial tick failed:', err))
    this.timer = setInterval(() => {
      this.tick().catch(err => console.error('[BridgeWatcher] tick failed:', err))
    }, POLL_INTERVAL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * Reconcile per-user `sum(Deposited on Base)` against
   * `sum(Credited on 0G Treasury)` and credit the difference. The old
   * processEvent path marked a dedup key BEFORE the credit tx
   * submitted, so any pre-submit revert (nonce drift, RPC blip,
   * estimateGas failure) silently locked the deposit out forever.
   * The new path no longer does that, but historical victims need
   * explicit recovery — this sweep walks all events from the gateway
   * deploy blocks forward, derives the missing-credit total per user,
   * and submits one consolidating creditBalance per user.
   *
   * Idempotency: re-running this sweep on already-recovered users is
   * a no-op (sum_credits == sum_deposits → 0 to credit). Safe to fire
   * repeatedly during debugging. We DO NOT touch the local
   * processedKeys file — those keys stay marked, and the new
   * processEvent path handles future events correctly.
   *
   * Sums-not-pairs matters: a user with 5 deposits + 3 prior credits
   * doesn't need to be matched event-for-event; the difference is
   * authoritative. Refunds from withdraw failures / agent stop drains
   * also emit Credited but those just inflate sum_credits beyond
   * sum_deposits and clamp to 0 via max — they cannot cause
   * double-credit since we only credit when sum_credits < sum_deposits.
   */
  private async runRecoverySweep(): Promise<void> {
    const client = getChainClient()
    if (!client.writeTreasury || !client.readTreasury) {
      console.warn('[BridgeWatcher] RECOVERY: Treasury wallet missing — skipping')
      return
    }

    console.warn('[BridgeWatcher] RECOVERY: starting per-user diff reconciliation. Set BRIDGE_RECOVERY=false after this run.')

    // ── 1. Aggregate Deposited per user across both source contracts.
    // The per-source `fallbackStartBlock` is the regular polling cursor
    // (= head-1 for USDCGateway, deploy-block for CCTPDepositReceiver),
    // which is too narrow for a recovery sweep — we want full history.
    // Use BRIDGE_RECOVERY_FROM_BASE_BLOCK env if set; otherwise fall back
    // to the CCTP receiver's deploy block (oldest known anchor we have)
    // for both, accepting that USDCGateway events older than that won't
    // be caught. If the user knows the gateway deploy block, they can
    // pass it via the env to extend coverage.
    const baseHead = await client.baseProvider.getBlockNumber()
    const recoveryFromBase = process.env.BRIDGE_RECOVERY_FROM_BASE_BLOCK
      ? Number(process.env.BRIDGE_RECOVERY_FROM_BASE_BLOCK)
      : (client.cctpReceiverDeployBlock || 0)
    const deposits = new Map<string, bigint>() // user (lowercased) → total
    for (const src of this.sources) {
      try {
        const filter = src.contract.filters.Deposited()
        const events = await src.contract.queryFilter(filter, recoveryFromBase, baseHead)
        for (const ev of events) {
          const args = (ev as ethers.EventLog).args ?? ([] as any)
          const user = (args[0] as string)?.toLowerCase()
          const amount = args[1] as bigint
          if (!user || amount === undefined) continue
          deposits.set(user, (deposits.get(user) ?? 0n) + amount)
        }
        console.log(`[BridgeWatcher] RECOVERY: ${src.label}: scanned blocks ${recoveryFromBase}..${baseHead}, ${events.length} events`)
      } catch (err) {
        console.error(`[BridgeWatcher] RECOVERY: failed scanning ${src.label}:`, err)
      }
    }

    // ── 2. Aggregate Credited per user on 0G Treasury.
    // Walk from block 0 — 0G Galileo is fresh enough that this is fine.
    // If it ever becomes too slow, narrow with a TREASURY_RECOVERY_FROM
    // env override.
    const credits = new Map<string, bigint>()
    try {
      const fromBlock = process.env.TREASURY_RECOVERY_FROM
        ? Number(process.env.TREASURY_RECOVERY_FROM)
        : 0
      const ogHead = await client.ogProvider.getBlockNumber()
      const filter = client.readTreasury.filters.Credited()
      const events = await client.readTreasury.queryFilter(filter, fromBlock, ogHead)
      for (const ev of events) {
        const args = (ev as ethers.EventLog).args ?? ([] as any)
        const user = (args[0] as string)?.toLowerCase()
        const amount = args[1] as bigint
        if (!user || amount === undefined) continue
        credits.set(user, (credits.get(user) ?? 0n) + amount)
      }
      console.log(`[BridgeWatcher] RECOVERY: Treasury.Credited: scanned blocks ${fromBlock}..${ogHead}, ${events.length} events`)
    } catch (err) {
      console.error('[BridgeWatcher] RECOVERY: failed scanning Treasury.Credited:', err)
      return
    }

    // ── 3. Diff and credit. One tx per user with stuck > 0.
    let totalRescued = 0n
    let usersRescued = 0
    for (const [user, deposited] of deposits) {
      const credited = credits.get(user) ?? 0n
      if (credited >= deposited) continue
      const stuck = deposited - credited
      try {
        const tx = await sendWithNonceRetry(`recovery.creditBalance(${user})`, () =>
          client.writeTreasury!.creditBalance(user, stuck),
        )
        const receipt = await tx.wait()
        const ogTxHash = receipt?.hash ?? tx.hash
        totalRescued += stuck
        usersRescued++
        console.log(
          `[BridgeWatcher] RECOVERY: credited ${ethers.formatUnits(stuck, USDC_DECIMALS)} USDC to ${user} (deposited=${ethers.formatUnits(deposited, USDC_DECIMALS)} credited=${ethers.formatUnits(credited, USDC_DECIMALS)}) og tx ${ogTxHash}`,
        )
      } catch (err) {
        console.error(
          `[BridgeWatcher] RECOVERY: creditBalance failed for ${user} (stuck=${ethers.formatUnits(stuck, USDC_DECIMALS)} USDC):`,
          (err as any)?.shortMessage ?? (err as Error)?.message ?? err,
        )
      }
    }

    console.warn(
      `[BridgeWatcher] RECOVERY DONE: rescued ${usersRescued} user(s), total ${ethers.formatUnits(totalRescued, USDC_DECIMALS)} USDC. Remove BRIDGE_RECOVERY env before next deploy.`,
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Look up whether a specific deposit event was already credited.
   *  Used by /v1/cctp/status to surface the final 0G credit step. */
  hasProcessed(contractAddress: string, txHash: string): boolean {
    return this.processedKeys.has(txHash.toLowerCase())
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const client = getChainClient()
      const head = await client.baseProvider.getBlockNumber()

      for (const src of this.sources) {
        let cursor = this.lastProcessedBlockByContract[src.address] ?? src.fallbackStartBlock
        
        while (cursor < head) {
          const fromBlock = Math.max(0, cursor - REORG_OVERLAP_BLOCKS)
          const toBlock = Math.min(head, fromBlock + MAX_SCAN_CHUNK)
          
          if (fromBlock >= toBlock) {
            cursor = head
            break
          }

          console.log(`[BridgeWatcher] ${src.label}: scanning ${fromBlock}..${toBlock} (head ${head})`)
          const filter = src.contract.filters.Deposited()
          const events = await src.contract.queryFilter(filter, fromBlock, toBlock)
          
          for (const event of events) {
            await this.processEvent(src.label, src.address, event as ethers.EventLog)
          }

          cursor = toBlock
          this.lastProcessedBlockByContract[src.address] = toBlock
          this.persistState()

          // If we have a massive gap (e.g. server was down for days), don't
          // block the event loop — yield briefly between chunks.
          if (toBlock < head) {
            await new Promise(r => setTimeout(r, 100))
          }
        }
      }
    } finally {
      this.inFlight = false
    }
  }

  private async processEvent(
    label: string,
    contractAddress: string,
    event: ethers.EventLog,
  ): Promise<void> {
    const key = event.transactionHash.toLowerCase()
    if (this.processedKeys.has(key)) return

    const args = event.args ?? ([] as any)
    const user = args[0] as string | undefined
    const amount = args[1] as bigint | undefined
    if (!user || amount === undefined) {
      console.warn(`[BridgeWatcher] malformed Deposited event ${key} — skipping`)
      return
    }

    const client = getChainClient()
    if (!client.writeTreasury) {
      throw new Error('writeTreasury missing — operator wallet went away after start')
    }

    // Two-phase dedup. Earlier code marked the key BEFORE submitting and
    // never released it on any error, which meant ANY pre-submit failure
    // (estimateGas revert, nonce drift, RPC down) permanently locked the
    // deposit out — user's 0G Treasury balance never updated and the only
    // recovery was manual operator intervention. The split below:
    //   - Pre-submit phase (estimateGas → broadcast): on error, DON'T
    //     mark the key. Next tick re-tries. The tx never reached chain,
    //     so retry is safe — no double-credit risk.
    //   - Post-submit phase (tx.wait): on error, KEEP the key locked.
    //     The tx may already have mined; a retry would double-credit.
    //     Operator reconciliation from the log handles the (rare) case
    //     where wait() failed but the tx never actually mined.
    // sendWithNonceRetry wraps the pre-submit phase so transient nonce
    // drift on the shared operator wallet (CentralComputeProxy / agent
    // prefund / Treasury debits all share one EOA) self-recovers.
    let tx: ethers.ContractTransactionResponse
    try {
      tx = await sendWithNonceRetry(`bridge.creditBalance(${user})`, () =>
        client.writeTreasury!.creditBalance(user, amount),
      )
    } catch (err) {
      // Pre-submit error — tx did not reach chain. Don't mark, allow
      // retry on next poll tick. Logged so persistent failures are
      // visible (e.g. operator out of 0G gas, chain genuinely down).
      console.error(
        `[BridgeWatcher] ${label} pre-submit error for ${key} — will retry next tick:`,
        (err as any)?.shortMessage ?? (err as Error)?.message ?? err,
      )
      return
    }

    // Mark + persist NOW that the tx is on the wire. Any error from
    // here on must keep the key — we don't know if the tx mined.
    this.processedKeys.add(key)
    this.persistState()

    try {
      const receipt = await tx.wait()
      const ogTxHash = receipt?.hash ?? tx.hash
      console.log(
        `[BridgeWatcher] ${label}: credited ${ethers.formatUnits(amount, USDC_DECIMALS)} USDC to ${user} (base tx ${event.transactionHash.slice(0, 12)}, og tx ${ogTxHash.slice(0, 12)})`,
      )
    } catch (err) {
      // Post-submit error — tx might have mined. Key stays locked to
      // prevent double-credit; operator can verify on-chain status from
      // tx.hash logged here and manually reconcile if the tx silently
      // dropped.
      console.error(
        `[BridgeWatcher] ${label} post-submit wait failed for ${key} (og tx ${tx.hash}) — key kept; manual reconciliation if tx didn't mine:`,
        err,
      )
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as PersistedState

      this.lastProcessedBlockByContract = parsed.lastProcessedBlockByContract || {}
      
      // Normalize processedKeys: legacy keys were `address:txHash:logIndex`.
      // We now dedupe on txHash alone for simplicity.
      const rawKeys = parsed.processedKeys || []
      this.processedKeys = new Set(
        rawKeys.map(k => {
          if (k.includes(':')) {
            const parts = k.split(':')
            // If it's address:txHash:logIndex, the middle part is the txHash.
            // If it's just address:txHash (older legacy), it's the second part.
            return (parts[1] || parts[0]).toLowerCase()
          }
          return k.toLowerCase()
        })
      )

      // Migrate legacy single-cursor field. The pre-CCTP watcher had a
      // single `lastProcessedBlock` that always referred to the gateway —
      // map it onto the gateway address and drop the old field.
      if (parsed.lastProcessedBlock != null && Object.keys(this.lastProcessedBlockByContract).length === 0) {
        const client = getChainClient()
        if (client.gatewayAddr) {
          const addr = client.gatewayAddr.toLowerCase()
          this.lastProcessedBlockByContract[addr] = parsed.lastProcessedBlock
          console.log(`[BridgeWatcher] migrated legacy cursor → ${addr}@${parsed.lastProcessedBlock}`)
        }
      }

      // Migrate legacy dedupe keys (no contract address prefix). They
      // can't be retroactively classified, so we just keep them — old
      // events won't re-emit anyway since the cursor has moved past them.

      console.log(
        `[BridgeWatcher] state loaded: cursors=${JSON.stringify(this.lastProcessedBlockByContract)} processedKeys=${this.processedKeys.size}`,
      )
    } catch (err) {
      console.warn('[BridgeWatcher] failed to load state, starting fresh:', err)
    }
  }

  private persistState(): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true })
      }
      const state: PersistedState = {
        lastProcessedBlockByContract: this.lastProcessedBlockByContract,
        // Cap the set so it doesn't grow unbounded. The catch-up scan
        // only re-reads REORG_OVERLAP_BLOCKS worth of history, so keys
        // far older than that can't reappear. 50k gives generous headroom.
        processedKeys: [...this.processedKeys].slice(-50_000),
      }
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn('[BridgeWatcher] failed to persist state:', err)
    }
  }
}
