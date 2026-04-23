/**
 * E2E: In-Process Flow — McpAgenticServer with real MCP protocol via InMemoryTransport.
 *
 * Tests the full MCP tool call round-trip without child processes:
 *   MCP Client ←→ InMemoryTransport ←→ McpAgenticServer ←→ InProcessExecutor ←→ AgentHandler
 *
 * This validates the complete integration from MCP JSON-RPC to agent execution.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentHandler, AgentResult, PromptOpts } from '../../src/agent/AgentHandler.js';
import { InProcessExecutor } from '../../src/executor/InProcessExecutor.js';
import { mapErrorToMCP } from '../../src/errors/error-mapper.js';
import {
  SessionsCreateArgsSchema,
  SessionsPromptArgsSchema,
  SessionsStatusArgsSchema,
  SessionsCloseArgsSchema,
  SessionsCancelArgsSchema,
  AgentsDiscoverArgsSchema,
  TasksDelegateArgsSchema,
} from '../../src/types.js';

// ─── Test Agents ─────────────────────────────────────────────────

class EchoAgent implements AgentHandler {
  readonly id = 'echo-agent';
  readonly capabilities = ['echo', 'text-processing'];
  private sessions = new Map<string, string[]>();

  async onSessionCreate(sessionId: string): Promise<void> {
    this.sessions.set(sessionId, []);
  }

  async onSessionClose(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const history = this.sessions.get(sessionId) ?? [];
    history.push(input);
    this.sessions.set(sessionId, history);
    return {
      text: `Echo[${history.length}]: ${input}`,
      stopReason: 'end_turn',
      requestId: `req-${sessionId}-${history.length}`,
    };
  }

  getHistoryLength(sessionId: string): number {
    return this.sessions.get(sessionId)?.length ?? 0;
  }
}

class StatefulAgent implements AgentHandler {
  readonly id = 'stateful-agent';
  readonly capabilities = ['conversation', 'context-aware'];
  private contexts = new Map<string, { turns: number; lastInput: string }>();

  async onSessionCreate(sessionId: string): Promise<void> {
    this.contexts.set(sessionId, { turns: 0, lastInput: '' });
  }

  async onSessionClose(sessionId: string): Promise<void> {
    this.contexts.delete(sessionId);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const ctx = this.contexts.get(sessionId) ?? { turns: 0, lastInput: '' };
    const previousInput = ctx.lastInput;
    ctx.turns++;
    ctx.lastInput = input;
    this.contexts.set(sessionId, ctx);

    const response = ctx.turns === 1
      ? `Hello! You said: "${input}". This is turn ${ctx.turns}.`
      : `Turn ${ctx.turns}. Previously: "${previousInput}". Now: "${input}".`;

    return {
      text: response,
      stopReason: 'end_turn',
      usage: { inputTokens: input.length, outputTokens: response.length },
    };
  }

  getTurnCount(sessionId: string): number {
    return this.contexts.get(sessionId)?.turns ?? 0;
  }
}

class MathAgent implements AgentHandler {
  readonly id = 'math-agent';
  readonly capabilities = ['math', 'calculation'];

  async prompt(_sessionId: string, input: string): Promise<AgentResult> {
    const cleaned = input.replace(/[^0-9+\-*/().  ]/g, '');
    try {
      const result = Function(`"use strict"; return (${cleaned})`)();
      return { text: `Result: ${result}`, stopReason: 'end_turn' };
    } catch {
      return { text: `Error: cannot evaluate "${input}"`, stopReason: 'end_turn' };
    }
  }
}

class FailingAgent implements AgentHandler {
  readonly id = 'failing-agent';
  readonly capabilities = ['unreliable'];

  async prompt(): Promise<AgentResult> {
    throw new Error('Simulated agent failure');
  }
}

// ─── Helper: wire MCP Server with executor ───────────────────────

function wireServerWithExecutor(mcpServer: Server, executor: InProcessExecutor): void {
  const TOOLS = [
    { name: 'bridge_health', description: 'Health check', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'agents_discover', description: 'Discover agents', inputSchema: { type: 'object' as const, properties: { capability: { type: 'string' } } } },
    { name: 'sessions_create', description: 'Create session', inputSchema: { type: 'object' as const, properties: { agentId: { type: 'string' } }, required: [] as string[] } },
    { name: 'sessions_prompt', description: 'Prompt session', inputSchema: { type: 'object' as const, properties: { sessionId: { type: 'string' }, prompt: { type: 'string' } }, required: ['sessionId', 'prompt'] } },
    { name: 'sessions_status', description: 'Session status', inputSchema: { type: 'object' as const, properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
    { name: 'sessions_close', description: 'Close session', inputSchema: { type: 'object' as const, properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
    { name: 'sessions_cancel', description: 'Cancel request', inputSchema: { type: 'object' as const, properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
    { name: 'tasks_delegate', description: 'Delegate task', inputSchema: { type: 'object' as const, properties: { prompt: { type: 'string' }, agentId: { type: 'string' } }, required: ['prompt'] } },
  ];

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case 'bridge_health': {
          const h = await executor.health();
          return { content: [{ type: 'text' as const, text: JSON.stringify(h) }] };
        }
        case 'agents_discover': {
          const parsed = AgentsDiscoverArgsSchema.parse(input);
          const agents = await executor.discover(parsed.capability);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ agents }) }] };
        }
        case 'sessions_create': {
          const parsed = SessionsCreateArgsSchema.parse(input);
          const session = await executor.createSession(parsed.agentId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: session.sessionId, agentId: session.agentId, status: session.status }) }] };
        }
        case 'sessions_prompt': {
          const parsed = SessionsPromptArgsSchema.parse(input);
          const result = await executor.prompt(parsed.sessionId, parsed.prompt, parsed.timeout ? { timeout: parsed.timeout } : undefined);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }
        case 'sessions_status': {
          const parsed = SessionsStatusArgsSchema.parse(input);
          const session = await executor.getSession(parsed.sessionId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: session.sessionId, status: session.status }) }] };
        }
        case 'sessions_close': {
          const parsed = SessionsCloseArgsSchema.parse(input);
          await executor.closeSession(parsed.sessionId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ closed: true }) }] };
        }
        case 'sessions_cancel': {
          const parsed = SessionsCancelArgsSchema.parse(input);
          await executor.cancel(parsed.sessionId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ cancelled: true }) }] };
        }
        case 'tasks_delegate': {
          const parsed = TasksDelegateArgsSchema.parse(input);
          const session = await executor.createSession(parsed.agentId);
          const result = await executor.prompt(session.sessionId, parsed.prompt);
          await executor.closeSession(session.sessionId, 'task-complete');
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }) }] };
        }
        default:
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
      }
    } catch (error) {
      const mcpError = mapErrorToMCP(error);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: mcpError.message, code: mcpError.code }) }], isError: true };
    }
  });
}

// ─── Helper: parse tool result ───────────────────────────────────

function parseToolResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('Empty tool result');
  return JSON.parse(text);
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('E2E: In-Process MCP Flow', () => {
  let client: Client;
  let mcpServer: Server;
  let executor: InProcessExecutor;
  let echoAgent: EchoAgent;
  let statefulAgent: StatefulAgent;
  let clientTransport: InstanceType<typeof InMemoryTransport>;
  let serverTransport: InstanceType<typeof InMemoryTransport>;

  beforeAll(async () => {
    echoAgent = new EchoAgent();
    statefulAgent = new StatefulAgent();
    const mathAgent = new MathAgent();
    const failingAgent = new FailingAgent();

    executor = new InProcessExecutor({ silent: true });
    executor.register(echoAgent);
    executor.register(statefulAgent);
    executor.register(mathAgent);
    executor.register(failingAgent);
    await executor.start();

    mcpServer = new Server(
      { name: 'mcp-agentic-test-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    wireServerWithExecutor(mcpServer, executor);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await mcpServer.close();
    await executor.close();
  });

  // ─── Tool Discovery ────────────────────────────────────────────

  describe('tool discovery', () => {
    it('lists all 8 MCP tools', async () => {
      const result = await client.listTools();
      expect(result.tools.length).toBe(8);
      const names = result.tools.map(t => t.name);
      expect(names).toContain('bridge_health');
      expect(names).toContain('agents_discover');
      expect(names).toContain('sessions_create');
      expect(names).toContain('sessions_prompt');
      expect(names).toContain('sessions_status');
      expect(names).toContain('sessions_close');
      expect(names).toContain('sessions_cancel');
      expect(names).toContain('tasks_delegate');
    });
  });

  // ─── Health ────────────────────────────────────────────────────

  describe('bridge_health', () => {
    it('reports healthy with 4 agents', async () => {
      const result = await client.callTool({ name: 'bridge_health', arguments: {} });
      const health = parseToolResult(result);
      expect(health.healthy).toBe(true);
      expect(health.agents.total).toBe(4);
      expect(health.agents.ready).toBe(4);
    });
  });

  // ─── Agent Discovery ──────────────────────────────────────────

  describe('agents_discover', () => {
    it('lists all agents', async () => {
      const result = await client.callTool({ name: 'agents_discover', arguments: {} });
      const { agents } = parseToolResult(result);
      expect(agents.length).toBe(4);
    });

    it('filters by capability', async () => {
      const result = await client.callTool({ name: 'agents_discover', arguments: { capability: 'math' } });
      const { agents } = parseToolResult(result);
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('math-agent');
    });
  });

  // ─── Full Session Lifecycle ────────────────────────────────────

  describe('session lifecycle', () => {
    it('create → prompt → status → close', async () => {
      // Create
      const createResult = await client.callTool({ name: 'sessions_create', arguments: { agentId: 'echo-agent' } });
      const { sessionId, agentId } = parseToolResult(createResult);
      expect(sessionId).toBeTruthy();
      expect(agentId).toBe('echo-agent');

      // Prompt
      const promptResult = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Hello MCP' } });
      const promptData = parseToolResult(promptResult);
      expect(promptData.text).toBe('Echo[1]: Hello MCP');
      expect(promptData.stopReason).toBe('end_turn');

      // Status
      const statusResult = await client.callTool({ name: 'sessions_status', arguments: { sessionId } });
      const statusData = parseToolResult(statusResult);
      expect(statusData.status).toBe('idle');

      // Close
      const closeResult = await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
      const closeData = parseToolResult(closeResult);
      expect(closeData.closed).toBe(true);
    });
  });

  // ─── Multi-Turn Conversation ───────────────────────────────────

  describe('multi-turn conversation', () => {
    it('maintains context across turns', async () => {
      const { sessionId } = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
      );

      const r1 = parseToolResult(
        await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'First' } }),
      );
      expect(r1.text).toContain('turn 1');

      const r2 = parseToolResult(
        await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Second' } }),
      );
      expect(r2.text).toContain('Turn 2');
      expect(r2.text).toContain('First');

      await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
    });
  });

  // ─── Concurrent Sessions ───────────────────────────────────────

  describe('concurrent sessions', () => {
    it('independent sessions do not interfere', async () => {
      const s1 = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
      ).sessionId;
      const s2 = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
      ).sessionId;

      expect(s1).not.toBe(s2);

      await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: s1, prompt: 'S1-A' } });
      await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: s1, prompt: 'S1-B' } });
      await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: s2, prompt: 'S2-A' } });

      expect(statefulAgent.getTurnCount(s1)).toBe(2);
      expect(statefulAgent.getTurnCount(s2)).toBe(1);

      await client.callTool({ name: 'sessions_close', arguments: { sessionId: s1 } });
      await client.callTool({ name: 'sessions_close', arguments: { sessionId: s2 } });
    });
  });

  // ─── tasks_delegate ────────────────────────────────────────────

  describe('tasks_delegate', () => {
    it('fire-and-forget delegation', async () => {
      const result = await client.callTool({
        name: 'tasks_delegate',
        arguments: { prompt: 'Calculate 2+2', agentId: 'math-agent' },
      });
      const data = parseToolResult(result);
      expect(data.success).toBe(true);
      expect(data.text).toContain('Result: 4');
    });

    it('uses default agent when agentId omitted', async () => {
      const result = await client.callTool({
        name: 'tasks_delegate',
        arguments: { prompt: 'Hello default' },
      });
      const data = parseToolResult(result);
      expect(data.success).toBe(true);
      expect(data.text).toContain('Echo[1]: Hello default');
    });
  });

  // ─── Error Handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('returns error for unknown session', async () => {
      const result = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId: 'nonexistent', prompt: 'hello' },
      });
      expect(result.isError).toBe(true);
      const data = parseToolResult(result);
      expect(data.error).toContain('Session not found');
    });

    it('returns error for unknown agent', async () => {
      const result = await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'nonexistent-agent' },
      });
      expect(result.isError).toBe(true);
      const data = parseToolResult(result);
      expect(data.error).toContain('Agent not found');
    });

    it('returns error when agent throws', async () => {
      const { sessionId } = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'failing-agent' } }),
      );

      const result = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'will fail' },
      });
      expect(result.isError).toBe(true);
      const data = parseToolResult(result);
      expect(data.error).toContain('failing-agent');
    });
  });

  // ─── Lifecycle Hooks ───────────────────────────────────────────

  describe('lifecycle hooks', () => {
    it('onSessionCreate and onSessionClose are called', async () => {
      const { sessionId } = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'echo-agent' } }),
      );

      // onSessionCreate was called — history initialized
      expect(echoAgent.getHistoryLength(sessionId)).toBe(0);

      await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'test' } });
      expect(echoAgent.getHistoryLength(sessionId)).toBe(1);

      await client.callTool({ name: 'sessions_close', arguments: { sessionId } });

      // onSessionClose was called — history cleaned up
      expect(echoAgent.getHistoryLength(sessionId)).toBe(0);
    });
  });

  // ─── Usage Metadata ────────────────────────────────────────────

  describe('usage metadata', () => {
    it('returns usage when agent provides it', async () => {
      const { sessionId } = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
      );

      const result = parseToolResult(
        await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Count tokens' } }),
      );

      expect(result.usage).toBeDefined();
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);

      await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
    });
  });
});
