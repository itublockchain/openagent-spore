import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk'
import { ethers } from 'ethers'
import { IStoragePort } from '../../../../shared/ports'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Fetch retry budget — sized for 0G testnet indexer propagation lag
// (upload tx mines fast, but `getFileLocations` doesn't see the file
// until the indexer reindexes — observed up to ~90s on the public
// testnet under load). 8 attempts × linear 3s backoff = 108s total
// max wait, matches the keeper-timeout budget (90s + grace) so a
// downstream worker either succeeds or surfaces a failure within the
// same window the planner-keeper would react.
const MAX_RETRIES = 8
const RETRY_BASE_MS = 3000
// 0G SDK's `waitForLogEntry` has an unbounded `while (true)` loop that
// polls the storage node forever when sync is stalled. Without a wall-
// clock timeout on each `indexer.upload/download` call, a stuck node
// freezes every caller awaiting on it — and the existing withRetry()
// can't trigger because the inner promise never rejects. These caps
// turn that infinite hang into a bounded reject so retries kick in,
// and ultimately the caller (e.g. validateLastNodeAsPlanner) sees a
// real error it can catch.
const UPLOAD_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 45_000

function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[ZeroGStorage] ${label} timed out after ${ms}ms`)), ms)
    p.then(
      v => { clearTimeout(t); resolve(v) },
      e => { clearTimeout(t); reject(e) },
    )
  })
}

export class ZeroGStorage implements IStoragePort {
  private provider: ethers.JsonRpcProvider
  private signer: ethers.Wallet
  private indexer: Indexer
  private rpc: string

  constructor() {
    this.rpc = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
    const indexerUrl = process.env.OG_INDEXER_URL ?? 'https://indexer-storage-testnet-standard.0g.ai'
    const pk = process.env.PRIVATE_KEY

    if (!pk) {
      throw new Error('[ZeroGStorage] PRIVATE_KEY env var is required for 0G Storage')
    }
    this.provider = new ethers.JsonRpcProvider(this.rpc)
    this.signer = new ethers.Wallet(pk, this.provider)
    this.indexer = new Indexer(indexerUrl)
  }

  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const isLast = attempt === MAX_RETRIES
        console.warn(`[ZeroGStorage] ${operation} attempt ${attempt}/${MAX_RETRIES} failed:`, err)
        if (isLast) throw err
        // Linear increase: 3s, 6s, 9s... gives the indexer ample time to sync
        const delay = RETRY_BASE_MS * attempt
        await new Promise(r => setTimeout(r, delay))
      }
    }
    throw new Error(`[ZeroGStorage] ${operation} unreachable`)
  }

  async append(data: unknown): Promise<string> {
    return this.withRetry('append', async () => {
      const serialized = JSON.stringify(data)
      const buffer = Buffer.from(serialized, 'utf-8')

      const file = new MemData(buffer)

      const [tree, treeErr] = await file.merkleTree()
      if (treeErr || !tree) throw new Error(`Tree error: ${treeErr}`)

      const rootHash = tree.rootHash()!
      console.log(`[ZeroGStorage] uploading, root: ${rootHash}`)

      const [result, uploadErr] = await withTimeout(
        'append.upload',
        UPLOAD_TIMEOUT_MS,
        this.indexer.upload(file, this.rpc, this.signer),
      )
      if (uploadErr || !result) throw new Error(`Upload error: ${uploadErr}`)

      const txHash = 'txHash' in result ? result.txHash : result.txHashes[0]
      console.log(`[ZeroGStorage] stored: ${rootHash}, tx: ${txHash}`)
      return rootHash
    })
  }

  /**
   * Hash-now, upload-later. The merkle root is fully deterministic from the
   * payload bytes, so we can hand it to the caller immediately (for on-chain
   * submitOutput) while the actual upload runs in the background. Peers that
   * try to fetch this hash before the upload lands see a transient miss and
   * fall through to the existing fetch retry-with-backoff (3 attempts, 2s
   * spacing) — by the time the second worker's judge() needs the bytes,
   * upload is virtually always complete.
   */
  async appendDeferred(data: unknown): Promise<{ rootHash: string; uploadPromise: Promise<void> }> {
    const serialized = JSON.stringify(data)
    const buffer = Buffer.from(serialized, 'utf-8')
    const file = new MemData(buffer)

    const [tree, treeErr] = await file.merkleTree()
    if (treeErr || !tree) throw new Error(`Tree error: ${treeErr}`)
    const rootHash = tree.rootHash()!
    console.log(`[ZeroGStorage] deferred upload starting, root: ${rootHash}`)

    const uploadPromise = (async () => {
      try {
        const [result, uploadErr] = await withTimeout(
          'appendDeferred.upload',
          UPLOAD_TIMEOUT_MS,
          this.indexer.upload(file, this.rpc, this.signer),
        )
        if (uploadErr || !result) throw uploadErr ?? new Error('upload returned no result')
        const txHash = 'txHash' in result ? result.txHash : result.txHashes[0]
        console.log(`[ZeroGStorage] deferred upload landed: ${rootHash}, tx: ${txHash}`)
      } catch (err) {
        console.error(`[ZeroGStorage] deferred upload FAILED for ${rootHash}:`, err)
        throw err
      }
    })()

    return { rootHash, uploadPromise }
  }

  async fetch(hash: string): Promise<unknown> {
    return this.withRetry('fetch', async () => {
      console.log(`[ZeroGStorage] fetching: ${hash}`)

      const tempDir = os.tmpdir()
      const tempFilePath = path.join(tempDir, `0g-download-${hash}-${Date.now()}.json`)

      try {
        const err = await withTimeout(
          'fetch.download',
          FETCH_TIMEOUT_MS,
          this.indexer.download(hash, tempFilePath, true /* verify */),
        )
        if (err) throw new Error(`Download error: ${err}`)

        const text = fs.readFileSync(tempFilePath, 'utf-8')
        return JSON.parse(text)
      } finally {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath)
        }
      }
    })
  }
}
