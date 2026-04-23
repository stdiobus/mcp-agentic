export interface AgentInfo {
  id: string;
  capabilities: string[];
  status: 'ready' | 'busy' | 'unavailable';
}

export interface SessionEntry {
  sessionId: string;
  agentId: string;
  status: 'active' | 'idle' | 'busy' | 'closed' | 'failed';
  createdAt: number;
  lastActivityAt: number;
  metadata?: Record<string, unknown>;
}

export interface HealthInfo {
  healthy: boolean;
  agents: { total: number; ready: number };
  sessions: { active: number; capacity: number };
  uptime: number;
}

export interface WorkerConfig {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  capabilities?: string[];
}
