import type { Transport } from '../transport'
import type {
  Colony,
  ColonyDetail,
  ColonyMember,
  ColonyVisibility,
  CreateColonyInput,
  PublicColony,
} from '../types'

interface ColonyWire {
  id: string
  name: string
  description: string | null
  visibility: ColonyVisibility
  owner: string
  created_at: string
  member_count: number
  task_stats?: { total: number; completed: number; pending: number }
}
interface ColonyMemberWire {
  agent_id: string
  added_at: string
  name: string | null
  status: string
  agent_address: string | null
}
interface ColonyDetailWire extends ColonyWire {
  members: ColonyMemberWire[]
}
interface PublicColonyWire {
  id: string
  name: string
  description: string | null
  owner: string
  created_at: string
  member_count?: number
}

function mapColony(w: ColonyWire): Colony {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    visibility: w.visibility,
    owner: w.owner,
    createdAt: w.created_at,
    memberCount: w.member_count,
    taskStats: w.task_stats,
  }
}

function mapMember(w: ColonyMemberWire): ColonyMember {
  return {
    agentId: w.agent_id,
    addedAt: w.added_at,
    name: w.name,
    status: w.status,
    agentAddress: w.agent_address,
  }
}

export class ColoniesResource {
  constructor(private readonly transport: Transport) {}

  /** List colonies owned by the caller. */
  async list(): Promise<Colony[]> {
    const wire = await this.transport.request<{ colonies: ColonyWire[] }>('/v1/colonies')
    return wire.colonies.map(mapColony)
  }

  /** Public discovery — lists colonies with `visibility: 'public'` across
   *  all users. No auth required on the backend, but the SDK still uses
   *  the configured key for consistency. */
  async listPublic(): Promise<PublicColony[]> {
    const wire = await this.transport.request<{ colonies: PublicColonyWire[] }>(
      '/v1/colonies/public',
    )
    return wire.colonies.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      owner: c.owner,
      createdAt: c.created_at,
      memberCount: c.member_count,
    }))
  }

  /** Create a new colony. Defaults to `private`. */
  async create(input: CreateColonyInput): Promise<Colony> {
    const body: Record<string, unknown> = { name: input.name }
    if (input.description !== undefined) body.description = input.description
    if (input.visibility !== undefined) body.visibility = input.visibility
    const wire = await this.transport.request<ColonyWire>('/v1/colonies', {
      method: 'POST',
      body,
    })
    return mapColony(wire)
  }

  /** Fetch a colony with its full member roster hydrated against the
   *  current agent pool. Members for deleted agents keep `status: 'unknown'`. */
  async get(colonyId: string): Promise<ColonyDetail> {
    const wire = await this.transport.request<ColonyDetailWire>(
      `/v1/colonies/${encodeURIComponent(colonyId)}`,
    )
    return {
      ...mapColony(wire),
      members: wire.members.map(mapMember),
    }
  }

  /** Toggle visibility. Only the owner can call this. */
  async setVisibility(
    colonyId: string,
    visibility: ColonyVisibility,
  ): Promise<{ changed: boolean; visibility: ColonyVisibility }> {
    const wire = await this.transport.request<{
      ok: boolean
      changed: boolean
      visibility: ColonyVisibility
    }>(`/v1/colonies/${encodeURIComponent(colonyId)}`, {
      method: 'PATCH',
      body: { visibility },
    })
    return { changed: wire.changed, visibility: wire.visibility }
  }

  /** Soft-delete (archive). The on-disk row is preserved with archived_at set. */
  async archive(colonyId: string): Promise<void> {
    await this.transport.request<{ ok: boolean }>(
      `/v1/colonies/${encodeURIComponent(colonyId)}`,
      { method: 'DELETE' },
    )
  }

  /** Add an agent to the colony. Caller must own both the colony AND the
   *  agent (verified server-side against AgentManager). Returns true when
   *  membership was newly created (false on idempotent re-add). */
  async addMember(colonyId: string, agentId: string): Promise<boolean> {
    const wire = await this.transport.request<{ ok: boolean; added: boolean }>(
      `/v1/colonies/${encodeURIComponent(colonyId)}/agents`,
      { method: 'POST', body: { agent_id: agentId } },
    )
    return wire.added
  }

  /** Remove an agent from the colony. Returns true when a row was deleted
   *  (false on idempotent remove of a non-member). */
  async removeMember(colonyId: string, agentId: string): Promise<boolean> {
    const wire = await this.transport.request<{ ok: boolean; removed: boolean }>(
      `/v1/colonies/${encodeURIComponent(colonyId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' },
    )
    return wire.removed
  }
}
