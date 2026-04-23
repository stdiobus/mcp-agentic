/**
 * E2E Test: mcp-agentic-stdio-e2e — Real stdio child-process transport
 *
 * Pipeline: MCP Client → StdioClientTransport → child process → McpAgenticServer → AgentHandler
 *
 * This is the TRUE e2e test — real process boundaries, real pipe I/O, real JSON-RPC.
 * The server runs as a separate Node.js process communicating via stdin/stdout.
 *
 * Run with:
 *   tsx test/e2e/mcp-agentic-stdio-e2e.ts
 *
 * Requires: npm run build (or uses tsx for the fixture server)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ─── Tests ───────────────────────────────────────────────────────

async function testToolDiscovery(client: Client): Promise<void> {
  console.log('\n  [1] Tool discovery over real stdio');

  const result = await client.listTools();
  check(result.tools.length === 8, `8 tools listed (got ${result.tools.length})`);

  const names = result.tools.map(t => t.name);
  check(names.includes('bridge_health'), 'bridge_health present');
  check(names.includes('sessions_create'), 'sessions_create present');
  check(names.includes('sessions_prompt'), 'sessions_prompt present');
  check(names.includes('tasks_delegate'), 'tasks_delegate present');
}

async function testHealthCheck(client: Client): Promise<void> {
  console.log('\n  [2] Health check over real stdio');

  const result = await client.callTool({ name: 'bridge_health', arguments: {} });
  const health = parseResult(result);
  check(health.healthy === true, `healthy=true (got ${health.healthy})`);
  check(health.agents.total === 4, `4 agents total (got ${health.agents.total})`);
}

async function testSessionLifecycle(client: Client): Promise<void> {
  console.log('\n  [3] Full session lifecycle over real stdio');

  // Create
  const createResult = await client.callTool({
    name: 'sessions_create',
    arguments: { agentId: 'echo-agent' },
  });
  const { sessionId, agentId } = parseResult(createResult);
  check(typeof sessionId === 'string' && sessionId.length > 0, 'sessionId is non-empty');
  check(agentId === 'echo-agent', `agentId is echo-agent (got ${agentId})`);

  // Prompt
  const promptResult = await client.callTool({
    name: 'sessions_prompt',
    arguments: { sessionId, prompt: 'Hello over real stdio pipes' },
  });
  const promptData = parseResult(promptResult);
  check(promptData.text === 'Echo[1]: Hello over real stdio pipes', `echo response correct (got "${promptData.text}")`);
  check(promptData.stopReason === 'end_turn', `stopReason end_turn (got "${promptData.stopReason}")`);

  // Status
  const statusResult = await client.callTool({
    name: 'sessions_status',
    arguments: { sessionId },
  });
  const statusData = parseResult(statusResult);
  check(statusData.status === 'idle', `status is idle (got "${statusData.status}")`);

  // Close
  const closeResult = await client.callTool({
    name: 'sessions_close',
    arguments: { sessionId },
  });
  const closeData = parseResult(closeResult);
  check(closeData.closed === true, 'session closed');
}

async function testMultiTurn(client: Client): Promise<void> {
  console.log('\n  [4] Multi-turn conversation over real stdio');

  const { sessionId } = parseResult(
    await client.callTool({ name: 'sessions_create', arguments: { agentId: 'stateful-agent' } }),
  );

  const r1 = parseResult(
    await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'First message' } }),
  );
  check(r1.text.includes('turn 1'), `turn 1 (got "${r1.text}")`);

  const r2 = parseResult(
    await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Second message' } }),
  );
  check(r2.text.includes('Turn 2'), `turn 2 (got "${r2.text}")`);
  check(r2.text.includes('First message'), 'context preserved from turn 1');

  await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
}

async function testTasksDelegate(client: Client): Promise<void> {
  console.log('\n  [5] tasks_delegate over real stdio');

  const result = await client.callTool({
    name: 'tasks_delegate',
    arguments: { prompt: '5 * 8', agentId: 'math-agent' },
  });
  const data = parseResult(result);
  check(data.success === true, 'delegation succeeded');
  check(data.text.includes('Result: 40'), `math result correct (got "${data.text}")`);
}

async function testErrorHandling(client: Client): Promise<void> {
  console.log('\n  [6] Error handling over real stdio');

  // Unknown agent
  const unknownResult = await client.callTool({
    name: 'sessions_create',
    arguments: { agentId: 'nonexistent-agent' },
  });
  const unknownData = parseResult(unknownResult);
  check(unknownData.error !== undefined, 'error returned for unknown agent');

  // Agent that throws
  const { sessionId } = parseResult(
    await client.callTool({ name: 'sessions_create', arguments: { agentId: 'failing-agent' } }),
  );
  const failResult = await client.callTool({
    name: 'sessions_prompt',
    arguments: { sessionId, prompt: 'will fail' },
  });
  const failData = parseResult(failResult);
  check(failData.error !== undefined, 'error returned when agent throws');
}

async function testAgentDiscovery(client: Client): Promise<void> {
  console.log('\n  [7] Agent discovery over real stdio');

  const allResult = await client.callTool({ name: 'agents_discover', arguments: {} });
  const { agents } = parseResult(allResult);
  check(agents.length === 4, `4 agents discovered (got ${agents.length})`);

  const mathResult = await client.callTool({
    name: 'agents_discover',
    arguments: { capability: 'calculation' },
  });
  const { agents: mathAgents } = parseResult(mathResult);
  check(mathAgents.length === 1, `1 math agent (got ${mathAgents.length})`);
  check(mathAgents[0]?.id === 'math-agent', `math-agent found (got ${mathAgents[0]?.id})`);
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: mcp-agentic-stdio-e2e — Real stdio child-process transport\n');

  // The fixture server registers 4 agents and starts McpAgenticServer on stdio.
  // We use tsx to run it as a child process — no build step needed.
  const fixtureServer = resolve(__dirname, 'fixtures', 'stdio-test-server.ts');

  const tsxBin = resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

  console.log(`  Spawning server: ${fixtureServer}`);
  console.log(`  Runner: tsx`);

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [fixtureServer],
    stderr: 'pipe',
  });

  const client = new Client({ name: 'stdio-e2e-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('  Connected to server via stdio\n');

    await testToolDiscovery(client);
    await testHealthCheck(client);
    await testAgentDiscovery(client);
    await testSessionLifecycle(client);
    await testMultiTurn(client);
    await testTasksDelegate(client);
    await testErrorHandling(client);
  } finally {
    await client.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('E2E failed:', err); process.exit(1); });
