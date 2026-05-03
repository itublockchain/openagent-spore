/**
 * Public TypeScript surface. The wire format is mostly snake_case; we
 * expose camelCase here so SDK code reads idiomatically. Each resource
 * module manually maps the wire shape to one of these types — explicit
 * mapping is verbose but makes drift obvious in PRs.
 */

// ─── Tasks ──────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'completed'

export interface SubmitTaskInput {
  /** Free-form intent the planner agent will decompose into a DAG. 1–4000 chars. */
  spec: string
  /** Decimal USDC string, e.g. "10" or "12.5". Spent atomically from the
   *  caller's Treasury balance — no separate approval. */
  budget: string
  /** Optional model preference (e.g. "gpt-4o"). Workers pick what's available. */
  model?: string
  /** Optional opaque bag of fields stored alongside the task spec. */
  metadata?: Record<string, unknown>
  /** Restrict execution to members of this colony. Public colonies accept any
   *  caller; private colonies require the caller to be the owner. */
  colonyId?: string
}

export interface SubmitTaskResponse {
  /** Content-addressed task id. Use this to read status / result. */
  taskId: string
  /** Same id padded to 32 bytes for on-chain references. */
  taskIdBytes32: string
  status: 'pending'
  /** Decimal USDC actually moved from the user's balance. */
  budgetLocked: string
  /** Decimal USDC remaining after the spend. Saves a follow-up balance call. */
  balanceRemaining: string
  /** ISO 8601. */
  submittedAt: string
  /** Treasury.spendOnBehalfOf transaction hash. */
  treasuryTx: string
  /** Treasury contract address. */
  treasury: string
}

export interface Task {
  taskId: string
  status: TaskStatus
  spec: string | null
  budget: string | null
  model: string | null
  submittedBy: string | null
  submittedVia: 'sdk' | 'web' | null
  /** Number of subtask nodes once the planner has built the DAG; null while pending. */
  nodeCount: number | null
}

export interface TaskNodeResult {
  nodeId: string
  result: string
}

export interface TaskResult {
  taskId: string
  /** Convenience pre-joined `=== nodeId ===\n<result>` string. */
  result: string
  /** Per-node breakdown sorted by nodeId. */
  nodeResults: TaskNodeResult[]
}

// ─── Balance ────────────────────────────────────────────────────────

export interface Balance {
  /** Decimal USDC available to spend. */
  balance: string
  /** Daily spend cap (decimal USDC). 0 == unlimited. */
  dailyCap: string
  /** Decimal USDC spent in the current rolling window. */
  dailySpent: string
  /** ISO 8601 when the daily window resets. null when no spend yet (window not started). */
  dailyWindowResetsAt: string | null
  /** USDC token decimals — usually 6. */
  decimals: number
}

// ─── Agents ─────────────────────────────────────────────────────────

/**
 * Agent record as returned by the API. Shape mirrors AgentManager.list();
 * fields beyond the documented set are passed through unchanged so the
 * SDK doesn't fall behind backend additions.
 */
export interface Agent {
  agentId: string
  agentAddress?: string
  ownerAddress?: string
  name?: string
  status?: 'pending' | 'running' | 'stopped' | 'error'
  model?: string
  stakeAmount?: string
  /** Pass-through for any additional manager fields. */
  [extra: string]: unknown
}

// ─── Colonies ───────────────────────────────────────────────────────

export type ColonyVisibility = 'private' | 'public'

export interface ColonyTaskStats {
  total: number
  completed: number
  pending: number
}

export interface Colony {
  id: string
  name: string
  description: string | null
  visibility: ColonyVisibility
  owner: string
  /** ISO 8601. */
  createdAt: string
  memberCount: number
  taskStats?: ColonyTaskStats
}

export interface ColonyMember {
  agentId: string
  /** ISO 8601. */
  addedAt: string
  name: string | null
  status: string
  agentAddress: string | null
}

export interface ColonyDetail extends Colony {
  members: ColonyMember[]
}

export interface CreateColonyInput {
  name: string
  description?: string
  visibility?: ColonyVisibility
}

export interface PublicColony {
  id: string
  name: string
  description: string | null
  owner: string
  /** ISO 8601. */
  createdAt: string
  memberCount?: number
}
