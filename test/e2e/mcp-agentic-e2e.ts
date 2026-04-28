/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: mcp-agentic-e2e — McpAgenticServer through real MCP protocol
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → InProcessExecutor → AgentHandler
 *
 * Standalone script — no Jest, no mocks. Run with:
 *   node --loader ts-node/esm test/e2e/mcp-agentic-e2e.ts
 *
 * Covers:
 * - Server lifecycle (start, close)
 * - Tool discovery (8 tools)
 * - Agent discovery (all, filtered by capability)
 * - Health check
 * - Full session lifecycle (create → prompt → status → close)
 * - Multi-turn conversation with context preservation
 * - Concurrent session isolation
 * - tasks_delegate fire-and-forget
 * - Default agent routing
 * - Error handling (unknown agent, unknown session, agent throws)
 * - Lifecycle hooks (onSessionCreate, onSessionClose)
 * - Usage metadata
 */

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
  AgentsDiscoverArgsSchema,
  TasksDelegateArgsSchema,
} from '../../src/types.js';

// ─── Assertions ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log('  ✓', message);
  } else {
    failed++;
    console.error('  ✗', message);
  }
}

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('Empty tool result');
  return JSON.parse(text);
}

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

// ─── Wire MCP Server ─────────────────────────────────────────────

function wireServer(mcpServer: Server, executor: InProcessExecutor): void {
  const TOOLS = [
    { name: 'bridge_health', description: 'Health check', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'agents_discover', description: 'Discover agents', inputSchema: { type: 'object' as const, properties: { capability: { type: 'string' } } } },
    { name: 'sessions_create', description: 'Create session', inputSchema: { type: 'object' as const, properties: { agentId: { type: 'string' } } } },
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
          const result = await executor.prompt(parsed.sessionId, parsed.prompt);
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

// ─── Tests ───────────────────────────────────────────────────────

async function testToolDiscovery(client: Client): Promise<void> {
  console.log('\n  [1] Tool discovery — 8 MCP tools');

  const result = await client.listTools();
  check(result.tools.length === 8, `8 tools listed (got ${result.tools.length})`);

  const names = result.tools.map(t => t.name);
  check(names.includes('bridge_health'), 'bridge_health present');
  check(names.includes('sessions_create'), 'sessions_create present');
  check(names.includes('tasks_delegate'), 'tasks_delegate present');
}

async function testHealthCheck(client: Client): Promise<void> {
  console.log('\n  [2] Health check — 4 agents healthy');

  const result = await client.callTool({ name: 'bridge_health', arguments: {} });
  const health = parseResult(result);
  check(health.healthy === true, `healthy=true (got ${health.healthy})`);
  check(health.agents.total === 4, `4 agents total (got ${health.agents.total})`);
}

async function testAgentDiscovery(client: Client): Promise<void> {
  console.log('\n  [3] Agent discovery — all + filtered');

  const allResult = await client.callTool({ name: 'agents_discover', arguments: {} });
  const { agents: allAgents } = parseResult(allResult);
  check(allAgents.length === 4, `4 agents discovered (got ${allAgents.length})`);

  const mathResult = await client.callTool({ name: 'agents_discover', arguments: { capability: 'math' } });
  const { agents: mathAgents } = parseResult(mathResult);
  check(mathAgents.length === 1, `1 math agent (got ${mathAgents.length})`);
  check(mathAgents[0].id === 'math-agent', `math-agent found (got ${mathAgents[0]?.id})`);
}

async function testSessionLifecycle(client: Client): Promise<void> {
  console.log('\n  [4] Session lifecycle — create → prompt → status → close');

  const createResult = await client.callTool({ name: 'sessions_create', arguments: { agentId: 'echo-agent' } });
  const { sessionId, agentId } = parseResult(createResult);
  check(typeof sessionId === 'string' && sessionId.length > 0, `sessionId is non-empty string`);
  check(agentId === 'echo-agent', `agentId is echo-agent (got ${agentId})`);

  const promptResult = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Hello MCP' } });
  const promptData = parseResult(promptResult);
  check(promptData.text === 'Echo[1]: Hello MCP', `echo response (got "${promptData.text}")`);
  check(promptData.stopReason === 'end_turn', `stopReason end_turn (got "${promptData.stopReason}")`);

  const statusResult = await client.callTool({ name: 'sessions_status', arguments: { sessionId } });
  const statusData = parseResult(statusResult);
  check(statusData.status === 'idle', `status is idle (got "${statusData.status}")`);

  const closeResult = await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  const closeData = parseResult(closeResult);
  check(closeData.closed === true, 'session closed');
}

async function testMultiTurn(client: Client, statefulAgent: StatefulAgent): Promise<void> {
  console.log('\n  [5] Multi-turn conversation — context preserved');

  const { sessionId } = parseResult(
    await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
  );

  const r1 = parseResult(await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'First' } }));
  check(r1.text.includes('turn 1'), `turn 1 (got "${r1.text}")`);

  const r2 = parseResult(await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Second' } }));
  check(r2.text.includes('Turn 2'), `turn 2 (got "${r2.text}")`);
  check(r2.text.includes('First'), 'context preserved from turn 1');

  check(statefulAgent.getTurnCount(sessionId) === 2, `2 turns tracked (got ${statefulAgent.getTurnCount(sessionId)})`);

  await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
}

async function testConcurrentSessions(client: Client, statefulAgent: StatefulAgent): Promise<void> {
  console.log('\n  [6] Concurrent sessions — isolation');

  const s1 = parseResult(await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } })).sessionId;
  const s2 = parseResult(await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } })).sessionId;

  check(s1 !== s2, `different session IDs (${s1} vs ${s2})`);

  await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: s1, prompt: 'S1-A' } });
  await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: s1, prompt: 'S1-B' } });
  await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: s2, prompt: 'S2-A' } });

  check(statefulAgent.getTurnCount(s1) === 2, `session 1 has 2 turns (got ${statefulAgent.getTurnCount(s1)})`);
  check(statefulAgent.getTurnCount(s2) === 1, `session 2 has 1 turn (got ${statefulAgent.getTurnCount(s2)})`);

  await client.callTool({ name: 'sessions_close', arguments: { sessionId: s1 } });
  await client.callTool({ name: 'sessions_close', arguments: { sessionId: s2 } });
}

async function testTasksDelegate(client: Client): Promise<void> {
  console.log('\n  [7] tasks_delegate — fire-and-forget');

  const result = await client.callTool({ name: 'tasks_delegate', arguments: { prompt: '3 + 7', agentId: 'math-agent' } });
  const data = parseResult(result);
  check(data.success === true, 'delegation succeeded');
  check(data.text.includes('Result: 10'), `math result (got "${data.text}")`);
}

async function testDefaultAgent(client: Client): Promise<void> {
  console.log('\n  [8] Default agent — first registered used when agentId omitted');

  const result = await client.callTool({ name: 'tasks_delegate', arguments: { prompt: 'Hello default' } });
  const data = parseResult(result);
  check(data.success === true, 'delegation succeeded');
  check(data.text.includes('Echo[1]: Hello default'), `echo agent used as default (got "${data.text}")`);
}

async function testErrorUnknownAgent(client: Client): Promise<void> {
  console.log('\n  [9] Error — unknown agent');

  const result = await client.callTool({ name: 'sessions_create', arguments: { agentId: 'nonexistent' } });
  const data = parseResult(result);
  check(data.error !== undefined, 'error returned');
  check(data.error.includes('not found') || data.error.includes('Agent'), `error mentions agent (got "${data.error}")`);
}

async function testErrorUnknownSession(client: Client): Promise<void> {
  console.log('\n  [10] Error — unknown session');

  const result = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId: 'nonexistent', prompt: 'hello' } });
  const data = parseResult(result);
  check(data.error !== undefined, 'error returned');
  check(data.error.includes('Session') || data.error.includes('not found'), `error mentions session (got "${data.error}")`);
}

async function testErrorAgentThrows(client: Client): Promise<void> {
  console.log('\n  [11] Error — agent throws');

  const { sessionId } = parseResult(
    await client.callTool({ name: 'sessions_create', arguments: { agentId: 'failing-agent' } }),
  );

  const result = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'will fail' } });
  const data = parseResult(result);
  check(data.error !== undefined, 'error returned');
  check(data.error.includes('failing-agent') || data.error.includes('failed'), `error mentions agent (got "${data.error}")`);
}

async function testLifecycleHooks(client: Client, echoAgent: EchoAgent): Promise<void> {
  console.log('\n  [12] Lifecycle hooks — onSessionCreate + onSessionClose');

  const { sessionId } = parseResult(
    await client.callTool({ name: 'sessions_create', arguments: { agentId: 'echo-agent' } }),
  );

  check(echoAgent.getHistoryLength(sessionId) === 0, 'onSessionCreate initialized history');

  await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'test' } });
  check(echoAgent.getHistoryLength(sessionId) === 1, 'history has 1 entry after prompt');

  await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  check(echoAgent.getHistoryLength(sessionId) === 0, 'onSessionClose cleaned up history');
}

async function testUsageMetadata(client: Client): Promise<void> {
  console.log('\n  [13] Usage metadata — returned when agent provides it');

  const { sessionId } = parseResult(
    await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
  );

  const result = parseResult(
    await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Count tokens' } }),
  );

  check(result.usage !== undefined, 'usage present');
  check(result.usage.inputTokens > 0, `inputTokens > 0 (got ${result.usage?.inputTokens})`);
  check(result.usage.outputTokens > 0, `outputTokens > 0 (got ${result.usage?.outputTokens})`);

  await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: mcp-agentic-e2e — McpAgenticServer through real MCP protocol\n');

  // Setup
  const echoAgent = new EchoAgent();
  const statefulAgent = new StatefulAgent();
  const mathAgent = new MathAgent();
  const failingAgent = new FailingAgent();

  const executor = new InProcessExecutor({ silent: true });
  executor.register(echoAgent);
  executor.register(statefulAgent);
  executor.register(mathAgent);
  executor.register(failingAgent);
  await executor.start();

  const mcpServer = new Server(
    { name: 'mcp-agentic-e2e-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  wireServer(mcpServer, executor);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  // Run tests
  await testToolDiscovery(client);
  await testHealthCheck(client);
  await testAgentDiscovery(client);
  await testSessionLifecycle(client);
  await testMultiTurn(client, statefulAgent);
  await testConcurrentSessions(client, statefulAgent);
  await testTasksDelegate(client);
  await testDefaultAgent(client);
  await testErrorUnknownAgent(client);
  await testErrorUnknownSession(client);
  await testErrorAgentThrows(client);
  await testLifecycleHooks(client, echoAgent);
  await testUsageMetadata(client);

  // Cleanup
  await client.close();
  await mcpServer.close();
  await executor.close();

  // Report
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
