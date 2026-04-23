import type { AgentInfo, SessionEntry, HealthInfo } from './types.js';
import type { AgentResult, PromptOpts } from '../agent/AgentHandler.js';

export interface AgentExecutor {
  start(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  discover(capability?: string): Promise<AgentInfo[]>;
  createSession(agentId?: string, metadata?: Record<string, unknown>): Promise<SessionEntry>;
  getSession(sessionId: string): Promise<SessionEntry>;
  closeSession(sessionId: string, reason?: string): Promise<void>;
  prompt(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;
  cancel(sessionId: string, requestId?: string): Promise<void>;
  health(): Promise<HealthInfo>;
}
