import type { Transport } from '../transport'
import type { Agent } from '../types'

interface AgentsListWire {
  agents: Agent[]
}

export class AgentsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * List agents in the pool. Requires the `agents:read` scope on the API key.
   * Returned shape mirrors AgentManager.list() — already camelCase, passed
   * through unchanged so future fields surface without an SDK release.
   */
  async list(): Promise<Agent[]> {
    const wire = await this.transport.request<AgentsListWire>('/v1/agents')
    return wire.agents
  }
}
