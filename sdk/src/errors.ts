/**
 * Single error class for all non-2xx responses from the SPORE API.
 *
 * The backend's error envelope is `{ error, code?, ...details }`. We surface
 * `code` as the primary discriminator — it's stable across releases — and
 * keep the full `body` for callers that need extra fields (e.g. INSUFFICIENT_BALANCE
 * carries `balance` and `required`).
 *
 * Caller pattern:
 *   try {
 *     await spore.tasks.submit({ ... })
 *   } catch (err) {
 *     if (err instanceof SporeAPIError && err.code === 'INSUFFICIENT_BALANCE') {
 *       // top up
 *     }
 *     throw err
 *   }
 */
export class SporeAPIError extends Error {
  /** HTTP status code (4xx / 5xx). */
  readonly status: number
  /** Backend-stable error code (e.g. INSUFFICIENT_BALANCE, SCOPE_DENIED).
   *  Undefined for upstream / network errors that didn't reach the API. */
  readonly code?: string
  /** Full parsed JSON body. May contain extra fields beyond { error, code }. */
  readonly body: unknown
  /** HTTP method + path that produced the error — handy for logs. */
  readonly request: { method: string; path: string }

  constructor(args: {
    status: number
    code?: string
    message: string
    body: unknown
    request: { method: string; path: string }
  }) {
    super(args.message)
    this.name = 'SporeAPIError'
    this.status = args.status
    this.code = args.code
    this.body = args.body
    this.request = args.request
  }
}

/**
 * Thrown when the SDK gives up waiting on a long-poll (waitForResult).
 * Distinct from a network timeout — the API kept responding, the task
 * just didn't finish in time.
 */
export class SporeTimeoutError extends Error {
  readonly taskId: string
  readonly waitedMs: number
  constructor(taskId: string, waitedMs: number) {
    super(`Task ${taskId} did not complete within ${waitedMs}ms`)
    this.name = 'SporeTimeoutError'
    this.taskId = taskId
    this.waitedMs = waitedMs
  }
}
