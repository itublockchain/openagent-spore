import { SporeAPIError } from './errors'

/**
 * Pluggable fetch type — Node 18+, browsers, and Workers all expose a global
 * `fetch`. Tests inject a mock by passing `fetch` to the client constructor.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TransportOpts {
  baseUrl: string
  apiKey: string
  fetch?: FetchLike
  /** Per-request timeout in ms. AbortSignal flips at this mark. Default 30s. */
  timeoutMs?: number
  /** Extra headers merged into every request. Useful for tracing / proxies. */
  headers?: Record<string, string>
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Auto-stringified to JSON. Skipped for GET/DELETE. */
  body?: unknown
  /** Caller-supplied AbortSignal — composed with the timeout signal so EITHER
   *  cancellation source aborts the in-flight request. */
  signal?: AbortSignal
}

/**
 * Thin fetch wrapper that:
 *  - injects `Authorization: Bearer <apiKey>` and `Content-Type: application/json`
 *  - composes per-request signal + a timeout signal
 *  - parses 2xx as JSON (or returns null on 204)
 *  - throws SporeAPIError on non-2xx with the parsed body
 *
 * Resource modules live on top of this — they shape inputs, call request(),
 * and translate the snake_case wire response into the camelCase TS type
 * exposed on the public API.
 */
export class Transport {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly extraHeaders: Record<string, string>

  constructor(opts: TransportOpts) {
    if (!opts.apiKey) throw new Error('SporeClient: apiKey is required')
    if (!opts.baseUrl) throw new Error('SporeClient: baseUrl is required')
    // Trim trailing slash so we can naively join "/v1/..." paths below.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.fetchImpl =
      opts.fetch ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined as unknown as FetchLike)
    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'SporeClient: no global fetch found. Pass a fetch implementation explicitly (Node 18+ has it built-in).',
      )
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.extraHeaders = opts.headers ?? {}
  }

  async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const method = opts.method ?? 'GET'
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...this.extraHeaders,
    }
    let body: string | undefined
    if (opts.body !== undefined && method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }

    // Timeout + caller signal compose into one signal that aborts on the
    // first source. AbortSignal.any is Node 20+; the manual fallback keeps
    // Node 18 working since package.json claims engines.node >= 18.
    const timeoutCtrl = new AbortController()
    const timeoutId = setTimeout(() => timeoutCtrl.abort(new Error('Request timed out')), this.timeoutMs)
    const composedSignal = opts.signal
      ? composeSignals(opts.signal, timeoutCtrl.signal)
      : timeoutCtrl.signal

    let response: Response
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: composedSignal })
    } catch (err) {
      throw err
    } finally {
      clearTimeout(timeoutId)
    }

    if (response.status === 204) return null as T

    // Buffer once — we read it twice (parse + error path) otherwise.
    const text = await response.text()
    let parsed: unknown = null
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text // surface raw text on a non-JSON 5xx
      }
    }

    if (!response.ok) {
      const bodyObj = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : {}
      throw new SporeAPIError({
        status: response.status,
        code: typeof bodyObj.code === 'string' ? bodyObj.code : undefined,
        message:
          typeof bodyObj.error === 'string'
            ? bodyObj.error
            : `${method} ${path} failed with ${response.status}`,
        body: parsed,
        request: { method, path },
      })
    }

    return parsed as T
  }
}

/**
 * Manual AbortSignal composition for Node 18 (which lacks AbortSignal.any).
 * Returns a new signal that aborts as soon as any input signal aborts.
 */
function composeSignals(...signals: AbortSignal[]): AbortSignal {
  // Prefer the native helper when available — same semantics, less code.
  const anyImpl = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyImpl === 'function') return anyImpl(signals)

  const ctrl = new AbortController()
  const onAbort = (event: Event) => {
    ctrl.abort((event.target as AbortSignal).reason)
  }
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason)
      break
    }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return ctrl.signal
}
