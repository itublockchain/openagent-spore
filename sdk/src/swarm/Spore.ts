/**
 * `Spore` — managed-mode entry point. Pair it with `LangChainAgent`
 * instances to run a multi-agent workflow on top of the Spore
 * infrastructure (AXL mesh, on-chain DAG registry, 0G Storage) without
 * managing any wallet, gas, or P2P plumbing yourself.
 *
 *   import { Spore, LangChainAgent } from '@spore/sdk'
 *   import { ChatOpenAI } from '@langchain/openai'
 *   import { createReactAgent } from '@langchain/langgraph/prebuilt'
 *
 *   const llm = new ChatOpenAI({ model: 'gpt-4o' })
 *   const spore = new Spore({ apiKey: process.env.SPORE_API_KEY! })
 *
 *   await spore.sporeise([
 *     new LangChainAgent({ id: 'researcher', agent: createReactAgent({ llm, tools: [searchTool] }), llm }),
 *     new LangChainAgent({ id: 'writer',     agent: createReactAgent({ llm, tools: [] }), llm }),
 *   ])
 *
 *   const { result } = await spore.run('Write a 4-line haiku about decentralized AI')
 *
 * What `spore.sporeise(agents)` does:
 *   - POSTs to /v1/sporeise/register — the API mints an ephemeral EOA
 *     per agent (gas paid by operator, debited from your Treasury) and
 *     publishes them on AgentRegistry.
 *   - Opens a WebSocket to /v1/sporeise/ws so the API can route
 *     plan/execute/judge calls back into your process.
 *
 * What `spore.run(spec)` does:
 *   - POSTs to /v1/sporeise/tasks — the API spins up a SporeiseRunner
 *     state machine that drives FCFS planner → workers → next-worker
 *     judge through the on-chain DAGRegistry.
 *   - Each LLM call is dispatched back to your process over WS so the
 *     LangChain agent runs LOCALLY (your API keys, your tools, your
 *     model). The API only orchestrates.
 *   - Returns when the API emits `task_completed` over WS.
 *
 * What you do NOT manage: agent wallets, on-chain registration, DAG
 * sealing, claim races, output storage, validation orchestration, gas.
 * All billed against your Spore API key Treasury balance.
 */

import { LangChainAgent, type PlanInput, type PlanResult, type ExecuteInput, type ExecuteResult, type JudgeInput, type JudgeResult } from './LangChainAgent'
import type {
  SporeiseAgentInfo,
  SporeiseClientMessage,
  SporeiseEventMessage,
  SporeiseInvokeMessage,
  SporeiseRegisterRequest,
  SporeiseRegisterResponse,
  SporeiseRunRequest,
  SporeiseRunResponse,
  SporeiseServerMessage,
  WireResultPayload,
} from './types'

export interface SporeOptions {
  /** Plaintext SPORE API key — `sk_live_...` or `sk_test_...`. */
  apiKey: string
  /** Override the API base URL. Default: `https://api.sporeprotocol.xyz`. */
  baseUrl?: string
  /** Override the WS URL. Default derives from baseUrl by swapping
   *  http(s) → ws(s) and appending `/v1/sporeise/ws`. */
  wsUrl?: string
  /** Pluggable WebSocket constructor — pass `ws` from the `ws` package
   *  in Node 18 (Node 22+ has a global `WebSocket` and can skip this). */
  WebSocket?: WebSocketCtor
  /** Pluggable fetch — defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Sink for lifecycle logs. Default `console`. Pass a noop logger to
   *  silence. */
  logger?: SporeLogger
}

export interface SporeLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface WebSocketCtor {
  new(url: string, protocolsOrOpts?: any): WebSocketLike
}

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (evt: any) => void): void
  removeEventListener?(type: string, listener: (evt: any) => void): void
}

export interface RunResult {
  taskId: string
  taskIdBytes32: string
  result: string
  /** USDC actually debited from your Treasury balance this run. */
  gasCharged: string
  /** USDC that *would have been* debited had the operator config been
   *  correct on-chain. Equals `gasCharged` on a healthy deployment;
   *  greater when the operator is currently absorbing gas — handy for
   *  budgeting and pre-rollout cost auditing. */
  gasWouldHaveBeen: string
  /** Treasury balance after this run, in human-readable USDC. */
  balanceRemaining: string
  /** Per-node on-chain receipts. Each entry's `output_hash` is fetchable
   *  from 0G Storage and cross-checkable against
   *  `DAGRegistry.nodes(node_id_bytes32).outputHash` on 0G Galileo. */
  nodes: NodeReceipt[]
}

export interface NodeReceipt {
  nodeId: string
  nodeIdBytes32: string
  agentId: string
  agentAddress: string
  outputHash: string
  subtask: string
}

export interface RunOptions {
  /** Hard cap on total wall time (ms) for this single run. Default 5min. */
  timeoutMs?: number
  /** Caller-provided AbortSignal — when fired, run() rejects. The API
   *  keeps the task alive (it has its own timeout); the SDK just stops
   *  waiting. */
  signal?: AbortSignal
}

/** Public event stream — superset of the wire `event` shapes. */
export type SporeEvent = SporeiseEventMessage['event'] & { taskId: string }
export type SporeEventHandler = (event: SporeEvent) => void

const DEFAULT_BASE_URL = 'https://api.sporeprotocol.xyz'
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000
// WS readyState constants — duplicated locally so we don't need a hard
// dep on a specific WebSocket implementation's enum.
const WS_OPEN = 1
const WS_CONNECTING = 0

export class Spore {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly wsUrl: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly WSCtor: WebSocketCtor
  private readonly logger: SporeLogger

  private readonly agents = new Map<string, LangChainAgent>()
  private readonly registered = new Set<string>()
  private readonly pendingRuns = new Map<string, PendingRun>()
  private readonly eventHandlers = new Set<SporeEventHandler>()

  private ws: WebSocketLike | null = null
  private wsReady: Promise<void> | null = null
  private wsClosing = false
  private reconnectAttempt = 0

  constructor(opts: SporeOptions) {
    if (!opts.apiKey) throw new Error('Spore: apiKey is required')
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.wsUrl = opts.wsUrl ?? deriveWsUrl(this.baseUrl)
    this.fetchImpl = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as any)
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Spore: no fetch available — pass `fetch` explicitly (Node 18+ has it built-in)')
    }
    const globalWS = (globalThis as any).WebSocket as WebSocketCtor | undefined
    this.WSCtor = opts.WebSocket ?? globalWS!
    if (typeof this.WSCtor !== 'function') {
      throw new Error('Spore: no WebSocket constructor available — pass `WebSocket` explicitly (Node 18: `import WebSocket from "ws"`; Node 22+ + browsers have it global)')
    }
    this.logger = opts.logger ?? defaultLogger()
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Register one or more LangChain agents with this Spore client. Each
   *  agent gets an ephemeral on-chain EOA on first registration; repeat
   *  calls for the same id are no-ops (the API short-circuits if the
   *  label already exists for this API key). */
  async sporeise(agents: LangChainAgent[]): Promise<SporeiseAgentInfo[]> {
    if (!Array.isArray(agents) || agents.length === 0) {
      throw new Error('Spore.sporeise: pass at least one LangChainAgent')
    }
    const fresh: LangChainAgent[] = []
    for (const a of agents) {
      if (this.agents.has(a.id)) {
        if (this.agents.get(a.id) !== a) {
          throw new Error(`Spore.sporeise: duplicate agent id "${a.id}" — pass only one instance per id`)
        }
        continue
      }
      this.agents.set(a.id, a)
      fresh.push(a)
    }
    if (fresh.length === 0) {
      // All already registered locally — return a synthesised view from
      // what we know. agent_address and registered_at are intentionally
      // empty because the SDK never persists them; callers needing the
      // canonical values should hit GET /v1/sporeise/agents.
      return [...this.agents.values()].map(a => ({
        id: a.id,
        agent_label: a.id,
        agent_address: '',
        description: a.description,
        model: a.model,
        registered_at: '',
      }))
    }

    const body: SporeiseRegisterRequest = {
      agents: fresh.map(a => ({ id: a.id, description: a.description ?? undefined, model: a.model })),
    }
    const res = await this.httpJson<SporeiseRegisterResponse>('POST', '/v1/sporeise/register', body)

    // Server returns the user-supplied label in `agent_label` — no
    // remapping needed because every WS invoke also keys on that same
    // label. We just track which labels are confirmed-registered.
    for (const info of res.agents) {
      const label = info.agent_label || info.id
      this.registered.add(label)
      // Stale-row fallback: if the API still returns rows where
      // `agent_label === id` (i.e. it predates the cleanup migration),
      // we can't route invokes for them. Warn loudly and keep going.
      if (label === info.id && !this.agents.has(label)) {
        this.logger.warn(
          `[Spore] Server returned an agent without a label (${info.id}). It cannot receive invokes — re-register or restart your API server with the latest sporeiseStore migration.`,
        )
      }
    }

    this.logger.info(
      `[Spore] registered ${res.agents.length} agent(s); gas charged ${res.gas_charged} USDC; balance ${res.balance_remaining}`,
    )
    // Open the WS now so the first run() doesn't pay the connect handshake
    // on the hot path. Failure here is non-fatal — run() will retry.
    this.ensureWebSocket().catch(err =>
      this.logger.warn('[Spore] background WS connect failed (run() will retry):', err),
    )
    return res.agents
  }

  /** Submit a task spec and wait for the final result. Resolves on
   *  `task_completed`; rejects on `task_failed`, timeout, or signal abort.
   *  Throws if no agents have been sporeise'd yet. */
  async run(spec: string, opts: RunOptions = {}): Promise<RunResult> {
    if (this.agents.size === 0) {
      throw new Error('Spore.run: no agents registered — call sporeise([...]) first')
    }
    await this.ensureWebSocket()

    const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
    // Always scope the run to THIS Spore instance's local agent map so
    // a user's stale historic registrations don't get picked as planner
    // (the SDK can't route invokes to agent labels it doesn't know).
    const reqBody: SporeiseRunRequest = {
      spec,
      timeout_ms: timeoutMs,
      validation: 'next-worker',
      agent_ids: [...this.agents.keys()],
    }
    const accepted = await this.httpJson<SporeiseRunResponse>('POST', '/v1/sporeise/tasks', reqBody)

    return new Promise<RunResult>((resolve, reject) => {
      const onAbort = () => {
        this.pendingRuns.delete(accepted.task_id)
        reject(opts.signal?.reason ?? new Error('Spore.run aborted'))
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort()
          return
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => {
        this.pendingRuns.delete(accepted.task_id)
        reject(new Error(`Spore.run: task ${accepted.task_id.slice(0, 12)} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingRuns.set(accepted.task_id, {
        resolve: r => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort as any)
          resolve(r)
        },
        reject: err => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort as any)
          reject(err)
        },
        taskIdBytes32: accepted.task_id_bytes32,
      })
    })
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  on(handler: SporeEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Close the WebSocket and reject any pending run()s. The instance is
   *  re-usable — the next run() reconnects. */
  async close(): Promise<void> {
    this.wsClosing = true
    for (const [, pending] of this.pendingRuns) pending.reject(new Error('Spore.close called'))
    this.pendingRuns.clear()
    if (this.ws) {
      try { this.ws.close() } catch { }
    }
    this.ws = null
    this.wsReady = null
  }

  // ─── HTTP transport ────────────────────────────────────────────────

  private async httpJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    }
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await this.fetchImpl(url, { method, headers, body: payload })
    const text = await res.text()
    let parsed: any = null
    if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = text }
    }
    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && parsed.error)
        ? String(parsed.error)
        : `${method} ${path} failed with ${res.status}`
      const err = new Error(msg) as Error & { status?: number; code?: string; body?: unknown }
      err.status = res.status
      err.code = (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') ? parsed.code : undefined
      err.body = parsed
      throw err
    }
    return parsed as T
  }

  // ─── WebSocket lifecycle ───────────────────────────────────────────

  private async ensureWebSocket(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_OPEN) return
    if (this.wsReady) return this.wsReady
    this.wsReady = this.connectWebSocket()
    return this.wsReady
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const url = `${this.wsUrl}?key=${encodeURIComponent(this.apiKey)}`
      // ws package accepts a second positional arg for headers in Node;
      // browsers ignore it. We pass the API key via query string to
      // keep both shapes happy and also via Sec-WebSocket-Protocol when
      // possible (some proxies strip query params).
      let socket: WebSocketLike
      try {
        socket = new this.WSCtor(url)
      } catch (err) {
        this.wsReady = null
        reject(err)
        return
      }
      this.ws = socket

      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      socket.addEventListener('open', () => {
        this.reconnectAttempt = 0
        this.logger.info('[Spore] WS connected')
        settle(() => resolve())
      })
      socket.addEventListener('error', (evt: any) => {
        const msg = evt?.message || evt?.error?.message || 'WebSocket error'
        this.logger.warn('[Spore] WS error:', msg)
        settle(() => {
          this.wsReady = null
          reject(new Error(msg))
        })
      })
      socket.addEventListener('close', () => {
        this.logger.info('[Spore] WS closed')
        this.ws = null
        this.wsReady = null
        if (!this.wsClosing && (this.pendingRuns.size > 0 || this.eventHandlers.size > 0)) {
          this.scheduleReconnect()
        }
      })
      socket.addEventListener('message', (evt: any) => {
        const raw = typeof evt?.data === 'string' ? evt.data : (evt?.data ? String(evt.data) : '')
        if (!raw) return
        let parsed: SporeiseServerMessage
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          this.logger.warn('[Spore] WS frame parse failed:', err)
          return
        }
        this.handleServerMessage(parsed).catch(err => this.logger.error('[Spore] handler error:', err))
      })
    })
  }

  private scheduleReconnect(): void {
    const attempt = ++this.reconnectAttempt
    const delay = Math.min(500 * 2 ** (attempt - 1), 15_000) + Math.random() * 250
    this.logger.info(`[Spore] WS reconnect in ${Math.round(delay)}ms (attempt ${attempt})`)
    setTimeout(() => {
      this.ensureWebSocket().catch(err =>
        this.logger.warn('[Spore] WS reconnect failed:', err),
      )
    }, delay)
  }

  private async handleServerMessage(msg: SporeiseServerMessage): Promise<void> {
    switch (msg.type) {
      case 'invoke':
        await this.handleInvoke(msg)
        break
      case 'event':
        await this.handleEvent(msg)
        break
      case 'error':
        // Top-level error (no correlation_id) → bail every pending run.
        // Correlated errors are surfaced inside handleInvoke through the
        // sender's own promise.
        if (!msg.correlation_id) {
          this.logger.warn('[Spore] server error:', msg.message)
          for (const [, p] of this.pendingRuns) p.reject(new Error(`Spore server error: ${msg.message}`))
          this.pendingRuns.clear()
        } else {
          this.logger.warn(`[Spore] invoke error (corr=${msg.correlation_id.slice(0, 8)}): ${msg.message}`)
        }
        break
    }
  }

  private async handleInvoke(msg: SporeiseInvokeMessage): Promise<void> {
    const agent = this.agents.get(msg.agent_id)
    if (!agent) {
      this.sendClient({
        type: 'error',
        correlation_id: msg.correlation_id,
        message: `Unknown agent id "${msg.agent_id}" — sporeise it first`,
        code: 'UNKNOWN_AGENT',
      })
      return
    }
    try {
      let result: WireResultPayload
      switch (msg.payload.kind) {
        case 'plan': {
          const out = await agent.plan({ spec: msg.payload.spec })
          result = { kind: 'plan', subtasks: out.subtasks }
          break
        }
        case 'execute': {
          const out = await agent.execute({
            subtask: msg.payload.subtask,
            context: msg.payload.context,
            nodeId: msg.payload.node_id,
          })
          result = { kind: 'execute', output: out.output }
          break
        }
        case 'judge': {
          const out = await agent.judge({
            subtask: msg.payload.subtask,
            output: msg.payload.output,
            nodeId: msg.payload.node_id,
          })
          result = { kind: 'judge', valid: out.valid, reason: out.reason }
          break
        }
      }
      this.sendClient({
        type: 'result',
        correlation_id: msg.correlation_id,
        kind: msg.kind,
        payload: result,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.sendClient({
        type: 'error',
        correlation_id: msg.correlation_id,
        message: `Agent "${msg.agent_id}" ${msg.kind} failed: ${message}`,
        code: 'AGENT_THREW',
      })
    }
  }

  private async handleEvent(msg: SporeiseEventMessage): Promise<void> {
    const event: SporeEvent = { ...msg.event, taskId: msg.task_id }
    for (const h of this.eventHandlers) {
      try { h(event) } catch (err) { this.logger.warn('[Spore] event handler threw:', err) }
    }
    // Resolve / reject pending run() promises.
    const pending = this.pendingRuns.get(msg.task_id)
    if (!pending) return
    if (msg.event.kind === 'task_completed') {
      this.pendingRuns.delete(msg.task_id)
      pending.resolve({
        taskId: msg.task_id,
        // Prefer the server's authoritative bytes32 (it's the keccak of
        // the storage spec hash, which the SDK can't compute without
        // downloading the spec back); fall back to the value the SDK
        // pre-computed on POST /tasks for back-compat.
        taskIdBytes32: msg.event.task_id_bytes32 ?? pending.taskIdBytes32,
        result: msg.event.result,
        gasCharged: msg.event.gas_charged,
        gasWouldHaveBeen: msg.event.gas_would_have_been ?? msg.event.gas_charged,
        balanceRemaining: msg.event.balance_remaining,
        nodes: (msg.event.nodes ?? []).map(n => ({
          nodeId: n.node_id,
          nodeIdBytes32: n.node_id_bytes32,
          agentId: n.agent_id,
          agentAddress: n.agent_address,
          outputHash: n.output_hash,
          subtask: n.subtask,
        })),
      })
    } else if (msg.event.kind === 'task_failed') {
      this.pendingRuns.delete(msg.task_id)
      pending.reject(new Error(`Spore task failed at ${msg.event.phase}: ${msg.event.reason}`))
    }
  }

  private sendClient(msg: SporeiseClientMessage): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      this.logger.warn('[Spore] cannot send — WS not open, dropping', msg.type)
      return
    }
    try {
      this.ws.send(JSON.stringify(msg))
    } catch (err) {
      this.logger.warn('[Spore] WS send threw:', err)
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface PendingRun {
  resolve: (result: RunResult) => void
  reject: (err: Error) => void
  taskIdBytes32: string
}

function deriveWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return baseUrl.replace(/^https/, 'wss') + '/v1/sporeise/ws'
  if (baseUrl.startsWith('http://')) return baseUrl.replace(/^http/, 'ws') + '/v1/sporeise/ws'
  return baseUrl + '/v1/sporeise/ws'
}

function defaultLogger(): SporeLogger {
  return {
    info: (m, ...a) => console.log(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
  }
}

// Re-exports for convenience — `import { Spore, LangChainAgent } from '@spore/sdk'`
export { LangChainAgent }
export type { PlanInput, PlanResult, ExecuteInput, ExecuteResult, JudgeInput, JudgeResult }
