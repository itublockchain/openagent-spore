import type { Transport } from '../transport'
import { SporeAPIError, SporeTimeoutError } from '../errors'
import type {
  SubmitTaskInput,
  SubmitTaskResponse,
  Task,
  TaskResult,
} from '../types'

/**
 * Wire shapes — snake_case as the backend returns them. Kept private to
 * this file so callers always see the camelCase TS types.
 */
interface SubmitTaskWire {
  task_id: string
  task_id_bytes32: string
  status: 'pending'
  budget_locked: string
  balance_remaining: string
  submitted_at: string
  treasury_tx: string
  treasury: string
}
interface TaskWire {
  task_id: string
  status: 'pending' | 'completed'
  spec: string | null
  budget: string | null
  model: string | null
  submitted_by: string | null
  submitted_via: 'sdk' | 'web' | null
  node_count: number | null
}
interface TaskResultWire {
  task_id: string
  result: string
  node_results: Array<{ node_id: string; result: string }>
}

export interface WaitForResultOptions {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number
  /** Hard cap on total wait time. Default 5 minutes. */
  timeoutMs?: number
  /** Caller-supplied AbortSignal; when aborted, polling stops with the
   *  signal's reason as the rejection. */
  signal?: AbortSignal
}

export class TasksResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Submit a task for execution. Spends `budget` USDC from the caller's
   * Treasury balance atomically — no separate approval flow.
   *
   * Common errors (caught as SporeAPIError):
   *   - INSUFFICIENT_BALANCE (402) — top up the Treasury and retry
   *   - CAP_EXHAUSTED       (402) — daily spend cap hit
   *   - SCOPE_DENIED        (403) — key missing 'tasks:submit'
   *   - COLONY_PRIVATE      (403) — submitted to a private colony you don't own
   *   - COLONY_NOT_FOUND    (404) — colonyId doesn't exist
   *   - OPERATOR_DOWN       (503) — backend operator wallet not configured
   */
  async submit(input: SubmitTaskInput): Promise<SubmitTaskResponse> {
    const body: Record<string, unknown> = {
      spec: input.spec,
      budget: input.budget,
    }
    if (input.model !== undefined) body.model = input.model
    if (input.metadata !== undefined) body.metadata = input.metadata
    // Backend takes snake_case `colony_id`. Forward as such.
    if (input.colonyId !== undefined) body.colony_id = input.colonyId

    const wire = await this.transport.request<SubmitTaskWire>('/v1/tasks', {
      method: 'POST',
      body,
    })
    return {
      taskId: wire.task_id,
      taskIdBytes32: wire.task_id_bytes32,
      status: wire.status,
      budgetLocked: wire.budget_locked,
      balanceRemaining: wire.balance_remaining,
      submittedAt: wire.submitted_at,
      treasuryTx: wire.treasury_tx,
      treasury: wire.treasury,
    }
  }

  /** Read task metadata (status, spec, model, node count). */
  async get(taskId: string): Promise<Task> {
    const wire = await this.transport.request<TaskWire>(`/v1/tasks/${encodeURIComponent(taskId)}`)
    return {
      taskId: wire.task_id,
      status: wire.status,
      spec: wire.spec,
      budget: wire.budget,
      model: wire.model,
      submittedBy: wire.submitted_by,
      submittedVia: wire.submitted_via,
      nodeCount: wire.node_count,
    }
  }

  /**
   * Read aggregated subtask results. Returns null when the task hasn't
   * produced any output yet — distinct from `submit() didn't land`, which
   * raises 404 NOT_FOUND. We translate the NOT_READY 404 to a null return
   * so calling code can poll without try/catching just for that case.
   */
  async getResult(taskId: string): Promise<TaskResult | null> {
    try {
      const wire = await this.transport.request<TaskResultWire>(
        `/v1/tasks/${encodeURIComponent(taskId)}/result`,
      )
      return {
        taskId: wire.task_id,
        result: wire.result,
        nodeResults: wire.node_results.map(n => ({
          nodeId: n.node_id,
          result: n.result,
        })),
      }
    } catch (err) {
      if (err instanceof SporeAPIError && err.status === 404 && err.code === 'NOT_READY') {
        return null
      }
      throw err
    }
  }

  /**
   * Poll `getResult` until it returns non-null, the timeout fires, or the
   * caller's AbortSignal trips. Convenience for "submit then await output".
   *
   * Polling cadence is fixed (no jitter / backoff) — the API's read path
   * is cheap and the typical task duration is 30s–5min, so a steady 2s
   * poll is fine.
   */
  async waitForResult(taskId: string, opts: WaitForResultOptions = {}): Promise<TaskResult> {
    const interval = opts.intervalMs ?? 2_000
    const timeout = opts.timeoutMs ?? 5 * 60_000
    const start = Date.now()

    // Fast path: many submits arrive after the result already landed (e.g.
    // resubmits of the same content-addressed spec). Skip the first sleep
    // by checking once before entering the loop.
    const first = await this.getResult(taskId)
    if (first) return first

    return new Promise<TaskResult>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(handle)
        reject(opts.signal?.reason ?? new Error('aborted'))
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(opts.signal.reason ?? new Error('aborted'))
          return
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      const tick = async () => {
        try {
          const r = await this.getResult(taskId)
          if (r) {
            opts.signal?.removeEventListener('abort', onAbort)
            resolve(r)
            return
          }
          const elapsed = Date.now() - start
          if (elapsed >= timeout) {
            opts.signal?.removeEventListener('abort', onAbort)
            reject(new SporeTimeoutError(taskId, elapsed))
            return
          }
          handle = setTimeout(tick, interval)
        } catch (err) {
          opts.signal?.removeEventListener('abort', onAbort)
          reject(err)
        }
      }

      let handle = setTimeout(tick, interval)
    })
  }
}
