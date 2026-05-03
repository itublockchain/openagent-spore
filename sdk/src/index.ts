/**
 * @spore/sdk — official TypeScript client for the SPORE protocol HTTP API.
 *
 *   import { SporeClient } from '@spore/sdk'
 *
 *   const spore = new SporeClient({
 *     baseUrl: 'https://api.sporeprotocol.xyz',
 *     apiKey: process.env.SPORE_API_KEY!,
 *   })
 *
 *   const { taskId } = await spore.tasks.submit({
 *     spec: 'Research recent advances in agent swarms',
 *     budget: '5',
 *   })
 *   const { result } = await spore.tasks.waitForResult(taskId)
 *   console.log(result)
 */

export { SporeClient, type SporeClientOptions } from './client'
export { SporeAPIError, SporeTimeoutError } from './errors'
export type { FetchLike } from './transport'

// Managed mode — pair `Spore` with `LangChainAgent` to run multi-agent
// workflows on the Spore protocol with a single API key. See
// examples/langchain.ts for an end-to-end demo.
export {
  Spore,
  LangChainAgent,
} from './swarm'
export type {
  SporeOptions,
  SporeLogger,
  SporeEvent,
  SporeEventHandler,
  RunOptions,
  RunResult,
  WebSocketCtor,
  WebSocketLike,
  LangChainAgentOptions,
  LangChainRunnable,
  LangChainChatModel,
  PlanInput,
  PlanResult,
  ExecuteInput,
  ExecuteResult,
  JudgeInput,
  JudgeResult,
  SporeiseAgentInfo,
  SporeiseAgentSpec,
} from './swarm'

export type {
  // Tasks
  SubmitTaskInput,
  SubmitTaskResponse,
  Task,
  TaskStatus,
  TaskNodeResult,
  TaskResult,
  // Balance
  Balance,
  // Agents
  Agent,
  // Colonies
  Colony,
  ColonyDetail,
  ColonyMember,
  ColonyVisibility,
  ColonyTaskStats,
  CreateColonyInput,
  PublicColony,
} from './types'

export type { WaitForResultOptions } from './resources/tasks'
