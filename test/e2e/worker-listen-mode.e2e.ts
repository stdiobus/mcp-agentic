/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: worker-listen-mode.e2e.ts — Offline validation of worker transport config
 *
 * Verifies that McpAgenticServer accepts TCP / Unix-socket listen-mode configuration
 * without requiring a real external TCP or Unix-socket connection. Exercises the full
 * MCP tool pipeline through InMemoryTransport using an in-process agent — the
 * workerListenMode config is supplied to McpAgenticServer but no worker is actually
 * registered, so WorkerExecutor is never created (lazy construction).
 *
 * Three scenarios:
 *   1. TCP config  (workerListenMode: 'tcp',  workerTcpPort: 9200)
 *   2. Unix config (workerListenMode: 'unix', workerUnixPath: '/tmp/mcp-test.sock')
 *   3. No registerWorker() call — WorkerExecutor must NOT be created even when
 *      workerListenMode is present in config.
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → InProcessExecutor → AgentHandler
 *
 * Run with:
 *   npx tsx test/e2e/worker-listen-mode.e2e.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentHandler, AgentResult } from '../../src/agent/AgentHandler.js';
import { McpAgenticServer } from '../../src/server/McpAgenticServer.js';
import type { McpAgenticServerConfig } from '../../src/server/McpAgenticServer.js';

// ─── Counters ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${message}\n`);
  } else {
    failed++;
    process.stderr.write(`  ✗ ${message}\n`);
  }
}

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('Empty tool result');
  return JSON.parse(text);
}

// ─── Test agent ───────────────────────────────────────────────────

class EchoAgent implements AgentHandler {
  readonly id = 'echo-agent';
  readonly capabilities = ['echo'];

  async prompt(_sessionId: string, input: string): Promise<AgentResult> {
    return { text: `Echo: ${input}`, stopReason: 'end_turn' };
  }
}

// ─── Server factory ───────────────────────────────────────────────

/**
 * Start a McpAgenticServer with the given config, connect an in-memory
 * client, and return the client + a close function.
 *
 * The server registers only the in-process EchoAgent — no workers —
 * so the workerListenMode config is held but WorkerExecutor is never created.
 */
async function startServer(
  serverConfig: McpAgenticServerConfig,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpAgenticServer({ ...serverConfig, silent: true });
  server.register(new EchoAgent());

  // Access the internal McpServer instance to connect via InMemoryTransport
  // (same technique used in _helpers.ts and factory-api-e2e.ts)
  const mcpServer = (server as any).mcpServer;

  await (server as any).inProcess.start();
  await (server as any).populateAgentExecutorCache();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: 'worker-listen-mode-e2e-client', version: '1.0.0' });
  await client.connect(clientTransport);

  const close = async () => {
    await client.close();
    await server.close();
  };

  return { client, close };
}

// ─── Shared test suite ────────────────────────────────────────────

/**
 * Exercise the full MCP tool pipeline for a server that has a workerListenMode
 * config but only an in-process agent.
 */
async function runFullPipeline(client: Client, label: string): Promise<void> {
  // [a] bridge_health
  const healthResult = await client.callTool({ name: 'bridge_health', arguments: {} });
  const health = parseResult(healthResult);
  check(health.healthy === true, `${label}: bridge_health returns healthy=true`);
  check(health.agents.total === 1, `${label}: bridge_health reports 1 in-process agent (got ${health.agents.total})`);

  // [b] agents_discover
  const discoverResult = await client.callTool({ name: 'agents_discover', arguments: {} });
  const { agents } = parseResult(discoverResult);
  check(agents.length === 1, `${label}: agents_discover returns 1 agent (got ${agents.length})`);
  check(agents[0]?.id === 'echo-agent', `${label}: echo-agent discovered (got "${agents[0]?.id}")`);

  // [c] sessions_create
  const createResult = await client.callTool({
    name: 'sessions_create',
    arguments: { agentId: 'echo-agent' },
  });
  const { sessionId, agentId } = parseResult(createResult);
  check(typeof sessionId === 'string' && sessionId.length > 0, `${label}: sessionId is non-empty`);
  check(agentId === 'echo-agent', `${label}: agentId is echo-agent (got "${agentId}")`);

  // [d] sessions_prompt
  const promptResult = await client.callTool({
    name: 'sessions_prompt',
    arguments: { sessionId, prompt: 'hello world' },
  });
  const promptData = parseResult(promptResult);
  check(promptData.text === 'Echo: hello world', `${label}: echo response correct (got "${promptData.text}")`);
  check(promptData.stopReason === 'end_turn', `${label}: stopReason end_turn (got "${promptData.stopReason}")`);

  // [e] sessions_status
  const statusResult = await client.callTool({
    name: 'sessions_status',
    arguments: { sessionId },
  });
  const statusData = parseResult(statusResult);
  check(statusData.status === 'idle', `${label}: status is idle after prompt (got "${statusData.status}")`);

  // [f] tasks_delegate
  const delegateResult = await client.callTool({
    name: 'tasks_delegate',
    arguments: { prompt: 'delegate test', agentId: 'echo-agent' },
  });
  const delegateData = parseResult(delegateResult);
  check(delegateData.success === true, `${label}: tasks_delegate succeeded`);
  check(delegateData.text === 'Echo: delegate test', `${label}: tasks_delegate response correct (got "${delegateData.text}")`);

  // [g] sessions_close
  const closeResult = await client.callTool({
    name: 'sessions_close',
    arguments: { sessionId },
  });
  const closeData = parseResult(closeResult);
  check(closeData.closed === true, `${label}: session closed`);
}

// ─── Test 1: TCP config ───────────────────────────────────────────

async function testTcpConfig(): Promise<void> {
  console.log('\n  [1] TCP config — server accepts workerListenMode: tcp without creating a WorkerExecutor');

  const { client, close } = await startServer({
    workerListenMode: 'tcp',
    workerTcpPort: 9200,
  });

  try {
    await runFullPipeline(client, 'tcp-config');
  } finally {
    await close();
  }
}

// ─── Test 2: TCP config with explicit host ────────────────────────

async function testTcpConfigWithHost(): Promise<void> {
  console.log('\n  [2] TCP config with host — workerListenMode: tcp + workerTcpHost + workerTcpPort');

  const { client, close } = await startServer({
    workerListenMode: 'tcp',
    workerTcpHost: '127.0.0.1',
    workerTcpPort: 9201,
  });

  try {
    await runFullPipeline(client, 'tcp-config-with-host');
  } finally {
    await close();
  }
}

// ─── Test 3: Unix socket config ───────────────────────────────────

async function testUnixConfig(): Promise<void> {
  console.log('\n  [3] Unix socket config — server accepts workerListenMode: unix without creating a WorkerExecutor');

  const { client, close } = await startServer({
    workerListenMode: 'unix',
    workerUnixPath: '/tmp/mcp-test.sock',
  });

  try {
    await runFullPipeline(client, 'unix-config');
  } finally {
    await close();
  }
}

// ─── Test 4: No registerWorker — WorkerExecutor is never created ──

async function testNoWorkerRegistered(): Promise<void> {
  console.log('\n  [4] No registerWorker() — WorkerExecutor not created even with workerListenMode in config');

  // Build a server with transport config but deliberately omit registerWorker().
  const server = new McpAgenticServer({
    silent: true,
    workerListenMode: 'tcp',
    workerTcpPort: 7777,
  });
  server.register(new EchoAgent());

  // Internal worker field must still be undefined (lazy construction)
  const workerField = (server as any).worker;
  check(workerField === undefined, 'worker field is undefined when registerWorker() was never called');

  // The server must still start and serve tools correctly
  const mcpServer = (server as any).mcpServer;
  await (server as any).inProcess.start();
  await (server as any).populateAgentExecutorCache();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: 'no-worker-e2e-client', version: '1.0.0' });
  await client.connect(clientTransport);

  try {
    const healthResult = await client.callTool({ name: 'bridge_health', arguments: {} });
    const health = parseResult(healthResult);
    // Healthy because in-process executor is up and has agents
    check(health.healthy === true, 'bridge_health returns healthy=true with only in-process executor');

    const discoverResult = await client.callTool({ name: 'agents_discover', arguments: {} });
    const { agents } = parseResult(discoverResult);
    check(agents.length === 1, `agents_discover returns 1 in-process agent (got ${agents.length})`);
    check(agents[0]?.id === 'echo-agent', `echo-agent is discoverable (got "${agents[0]?.id}")`);
  } finally {
    await client.close();
    await server.close();
  }
}

// ─── Test 5: No listenMode config at all ─────────────────────────

async function testNoListenModeConfig(): Promise<void> {
  console.log('\n  [5] No workerListenMode in config — server works with pure defaults');

  const { client, close } = await startServer({});

  try {
    await runFullPipeline(client, 'no-listen-mode-config');
  } finally {
    await close();
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: worker-listen-mode.e2e.ts — Offline worker transport config validation\n');

  await testTcpConfig();
  await testTcpConfigWithHost();
  await testUnixConfig();
  await testNoWorkerRegistered();
  await testNoListenModeConfig();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
