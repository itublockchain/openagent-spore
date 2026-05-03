import { Transport, type FetchLike } from './transport'
import { TasksResource } from './resources/tasks'
import { BalanceResource } from './resources/balance'
import { AgentsResource } from './resources/agents'
import { ColoniesResource } from './resources/colonies'

export interface SporeClientOptions {
  /** Base URL of the SPORE API, e.g. `https://api.sporeprotocol.xyz`.
   *  Trailing slashes are tolerated. */
  baseUrl: string
  /** Plaintext API key — `sk_live_...` or `sk_test_...`. Generate one from
   *  the dashboard; the plaintext is shown ONCE at creation time. */
  apiKey: string
  /** Per-request timeout in ms. Default 30s. AbortSignal supplied to a
   *  resource method composes with this — whichever fires first wins. */
  timeoutMs?: number
  /** Override the global fetch. Useful for tests, custom retry policies,
   *  or running in environments without a built-in fetch. */
  fetch?: FetchLike
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
}

/**
 * Top-level client. Resources are mounted as namespaces on the instance:
 *
 *   const spore = new SporeClient({ baseUrl, apiKey: 'sk_live_...' })
 *   const balance = await spore.balance.get()
 *   const { taskId } = await spore.tasks.submit({ spec: '...', budget: '5' })
 *   const result = await spore.tasks.waitForResult(taskId)
 *
 * The client is stateless — safe to share across requests / threads. Holds
 * no connection pool of its own; per-request fetch handles that.
 */
export class SporeClient {
  readonly tasks: TasksResource
  readonly balance: BalanceResource
  readonly agents: AgentsResource
  readonly colonies: ColoniesResource

  constructor(opts: SporeClientOptions) {
    const transport = new Transport({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      fetch: opts.fetch,
      headers: opts.headers,
    })
    this.tasks = new TasksResource(transport)
    this.balance = new BalanceResource(transport)
    this.agents = new AgentsResource(transport)
    this.colonies = new ColoniesResource(transport)
  }
}
