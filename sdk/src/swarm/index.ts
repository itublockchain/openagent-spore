/**
 * Managed-mode entry: pair `Spore` with `LangChainAgent` instances to run
 * multi-agent workflows on the Spore protocol with a single API key.
 * See ../examples/langchain.ts for a runnable end-to-end demo.
 */

export { Spore } from './Spore'
export type {
  SporeOptions,
  SporeLogger,
  SporeEvent,
  SporeEventHandler,
  RunOptions,
  RunResult,
  WebSocketCtor,
  WebSocketLike,
} from './Spore'

export { LangChainAgent } from './LangChainAgent'
export type {
  LangChainAgentOptions,
  LangChainRunnable,
  LangChainChatModel,
  PlanInput,
  PlanResult,
  ExecuteInput,
  ExecuteResult,
  JudgeInput,
  JudgeResult,
} from './LangChainAgent'

export type {
  SporeiseAgentInfo,
  SporeiseAgentSpec,
} from './types'
