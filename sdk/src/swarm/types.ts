/**
 * Wire types shared between the SDK (browser/Node user process) and the
 * Spore API (`/v1/sporeise/*`). snake_case on the wire, camelCase via the
 * resource layer. Kept in one file so both sides import the same shapes
 * — the SDK ships them; the API mirrors them in its route handlers.
 */

// ─── Registration ────────────────────────────────────────────────────

export interface SporeiseAgentSpec {
  /** Stable id supplied by the SDK user — used in events, logs, and as the
   *  on-chain agent label (keccak256'd into bytes32). */
  id: string
  /** Free-form one-line description of what this agent does. Stored
   *  on-chain as the AgentRegistry `name` field. */
  description?: string
  /** Optional model label for human-readable display. */
  model?: string
}

export interface SporeiseRegisterRequest {
  agents: SporeiseAgentSpec[]
}

export interface SporeiseAgentInfo {
  id: string
  agent_label: string
  agent_address: string
  description: string | null
  model: string | null
  registered_at: string
}

export interface SporeiseRegisterResponse {
  agents: SporeiseAgentInfo[]
  /** USDC base units (6 decimals) deducted from Treasury for the on-chain
   *  registration of all newly-registered agents. Existing agents are
   *  no-ops and don't bill. */
  gas_charged: string
  balance_remaining: string
}

// ─── Run / Task lifecycle ────────────────────────────────────────────

export interface SporeiseRunRequest {
  spec: string
  /** Optional per-run override of validation policy. Defaults to "next
   *  worker validates" (option A from the design discussion). */
  validation?: 'next-worker'
  /** Hard cap on total wall time before the API gives up. Default 5min. */
  timeout_ms?: number
  /** SDK-side filter: only schedule plan/execute/judge invocations on
   *  agents whose `agent_label` is in this list. Critical when the user's
   *  Treasury has accumulated agents across multiple SDK processes /
   *  test runs — without it, the runner would pick the oldest registered
   *  agent as planner and the local SDK map wouldn't have it ("Unknown
   *  agent id" error).
   *
   *  Omit / empty list → use all the user's registered agents (legacy
   *  behaviour, fine for a single long-lived SDK instance). */
  agent_ids?: string[]
}

export interface SporeiseRunResponse {
  /** Server-issued task id. Same value the SDK uses to correlate WS
   *  invocations with the run() promise. */
  task_id: string
  task_id_bytes32: string
  /** Acceptance is async — clients consume WS events for progress and
   *  resolve `run()` on `task_completed`. */
  status: 'accepted'
}

// ─── WebSocket channel ───────────────────────────────────────────────
//
// Bidirectional. The API pushes `invoke` requests (planner / worker /
// judge calls) to the SDK; the SDK responds with `result` messages
// keyed by `correlation_id`. The API also emits read-only `event`
// messages for the run() promise to resolve and for telemetry.

export type SporeiseInvocationKind = 'plan' | 'execute' | 'judge'

export interface SporeiseInvokeMessage {
  type: 'invoke'
  correlation_id: string
  task_id: string
  /** SDK-known agent id. The SDK looks this up in its local
   *  `LangChainAgent` map and routes the call. */
  agent_id: string
  kind: SporeiseInvocationKind
  /** Free-form payload — shape depends on `kind`. Documented in
   *  WireInvocationPayload below. */
  payload: WireInvocationPayload
}

export type WireInvocationPayload =
  | { kind: 'plan'; spec: string }
  | { kind: 'execute'; subtask: string; context: string | null; node_id: string }
  | { kind: 'judge'; subtask: string; output: string; node_id: string }

export interface SporeiseResultMessage {
  type: 'result'
  correlation_id: string
  /** Mirror of the request kind so the API doesn't need a side table. */
  kind: SporeiseInvocationKind
  payload: WireResultPayload
}

export type WireResultPayload =
  | { kind: 'plan'; subtasks: Array<{ id: string; spec: string }> }
  | { kind: 'execute'; output: string }
  | { kind: 'judge'; valid: boolean; reason?: string }

export interface SporeiseErrorMessage {
  type: 'error'
  /** Set when the error is a response to an `invoke`; absent for
   *  general transport errors. */
  correlation_id?: string
  message: string
  /** Stable code for SDK error handling. */
  code?: string
}

/** Per-node on-chain proof — surfaced in `task_completed` so the user
 *  can verify each subtask landed on the public DAGRegistry + 0G
 *  Storage. The output_hash is the deterministic merkle root of the
 *  worker's structured output payload (subtask + final answer + agent
 *  id) — readable via `Indexer.download(output_hash)` on 0G Storage,
 *  cross-checkable against `DAGRegistry.nodes(node_id_bytes32).outputHash`
 *  on 0G Galileo (chainId 16602). */
export interface SporeiseNodeReceipt {
  /** Server-internal node id (`<taskId>:node-N`). */
  node_id: string
  /** keccak256 of `node_id` — what `DAGRegistry.nodes(...)` is keyed on. */
  node_id_bytes32: string
  /** Label of the agent that claimed + executed this node. */
  agent_id: string
  /** On-chain wallet address of the agent — same as
   *  `DAGRegistry.nodes(...).claimedBy`. */
  agent_address: string
  /** 0G Storage merkle root of the output payload. */
  output_hash: string
  subtask: string
}

/** Server-pushed lifecycle event. Consumed by `run()` for completion +
 *  emitted on the public event stream for SDK consumers. */
export interface SporeiseEventMessage {
  type: 'event'
  task_id: string
  event:
    | { kind: 'task_started'; planner_id: string }
    | { kind: 'dag_ready'; nodes: Array<{ id: string; subtask: string }> }
    | { kind: 'subtask_claimed'; node_id: string; agent_id: string }
    | { kind: 'subtask_done'; node_id: string; agent_id: string; output_hash: string }
    | { kind: 'subtask_validated'; node_id: string; valid: boolean; reason?: string }
    | { kind: 'subtask_retrying'; node_id: string; reason: string; next_agent_id: string }
    | {
        kind: 'task_completed'
        result: string
        /** USDC actually debited from the user's Treasury balance. */
        gas_charged: string
        /** USDC the user would have been charged had operator config
         *  been correct. Equals gas_charged on a healthy deployment;
         *  greater when the operator is currently absorbing gas
         *  (Treasury operator mismatch — see API logs). Surfaced so
         *  users can audit billing pre-rotation. */
        gas_would_have_been: string
        balance_remaining: string
        /** Bytes32 task id on-chain — keccak256(specHash). Use to look
         *  up the task on `DAGRegistry.getTaskNodes(...)`. */
        task_id_bytes32: string
        /** Per-node on-chain receipts — provides everything needed to
         *  independently verify the output went to chain + storage. */
        nodes: SporeiseNodeReceipt[]
      }
    | { kind: 'task_failed'; reason: string; phase: string }
}

export type SporeiseClientMessage = SporeiseResultMessage | SporeiseErrorMessage
export type SporeiseServerMessage = SporeiseInvokeMessage | SporeiseEventMessage | SporeiseErrorMessage
