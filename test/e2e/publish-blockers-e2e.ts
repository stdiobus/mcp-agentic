/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: publish-blockers-e2e — Regression tests for 5 publish-blocker bugs
 *
 * Pipeline: MCP Client → InMemoryTransport → Server → Real handler functions → Real error mapping
 *
 * Standalone script — no Jest, no mocks. Run with:
 *   npx tsx test/e2e/publish-blockers-e2e.ts
 *
 * Covers:
 * - Bug 2+3: No stack traces in MCP error responses (BridgeError + generic Error paths)
 * - Bug 4:   No duplicate agents in combined discover
 * - Bug 5:   Health error returns { error, code, data } not { healthy, error }
 * - Bug 6:   Clean shutdown with active sessions (reaper ordering)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AgentHandler, AgentResult } from '../../src/agent/AgentHandler.js';
import type { AgentExecutor } from '../../src/executor/AgentExecutor.js';
import type { AgentInfo, SessionEntry, HealthInfo } from '../../src/executor/types.js';
import { InProcessExecutor } from '../../src/executor/InProcessExecutor.js';
import { handleCombinedDiscover } from '../../src/mcp/tools/agents.js';
import { handleBridgeHealth } from '../../src/mcp/tools/health.js';
import { handleSessionsCreate, handleSessionsPrompt } from '../../src/mcp/tools/sessions.js';

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
  readonly capabilities = ['echo'];

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    return { text: `Echo: ${input}`, stopReason: 'end_turn' };
  }
}

class FailingAgent implements AgentHandler {
  readonly id = 'failing-agent';
  readonly capabilities = ['unreliable'];

  async prompt(): Promise<AgentResult> {
    throw new Error('Simulated agent failure with /Users/dev/src/secret/path.ts:42');
  }
}

// ─── Mock executor that throws on health() ──────────────────────

class FailingHealthExecutor implements AgentExecutor {
  async start(): Promise<void> { }
  async close(): Promise<void> { }
  isReady(): boolean { return true; }
  async discover(): Promise<AgentInfo[]> { return []; }
  async createSession(): Promise<SessionEntry> {
    throw new Error('not implemented');
  }
  async getSession(): Promise<SessionEntry> {
    throw new Error('not implemented');
  }
  async closeSession(): Promise<void> { }
  async prompt(): Promise<AgentResult> {
    throw new Error('not implemented');
  }
  async cancel(): Promise<void> { }
  async health(): Promise<HealthInfo> {
    throw new Error('Health check connection refused');
  }
}

// ─── Mock executor with configurable agents ─────────────────────

class MockAgentExecutor implements AgentExecutor {
  private agentList: AgentInfo[];

  constructor(agents: AgentInfo[]) {
    this.agentList = agents;
  }

  async start(): Promise<void> { }
  async close(): Promise<void> { }
  isReady(): boolean { return true; }

  async discover(capability?: string): Promise<AgentInfo[]> {
    if (capability) {
      return this.agentList.filter(a => a.capabilities.includes(capability));
    }
    return this.agentList;
  }

  async createSession(): Promise<SessionEntry> {
    throw new Error('not implemented');
  }
  async getSession(): Promise<SessionEntry> {
    throw new Error('not implemented');
  }
  async closeSession(): Promise<void> { }
  async prompt(): Promise<AgentResult> {
    throw new Error('not implemented');
  }
  async cancel(): Promise<void> { }
  async health(): Promise<HealthInfo> {
    return {
      healthy: true,
      agents: { total: this.agentList.length, ready: this.agentList.length },
      sessions: { active: 0, capacity: 100 },
      uptime: 1000,
    };
  }
}

// ─── Wire MCP Server for Bug 2+3 tests ──────────────────────────
//
// Uses real InProcessExecutor + real handler functions + real error mapping.
// This tests the full MCP JSON-RPC serialization pipeline.

function wireErrorTestServer(mcpServer: McpServer, executor: InProcessExecutor): void {
  mcpServer.registerTool('sessions_create', {
    description: 'Create session',
    inputSchema: { agentId: z.string().optional() },
  }, async (args) => {
    return await handleSessionsCreate(executor, args as any);
  });

  mcpServer.registerTool('sessions_prompt', {
    description: 'Prompt session',
    inputSchema: { sessionId: z.string(), prompt: z.string() },
  }, async (args) => {
    return await handleSessionsPrompt(executor, args as any);
  });
}

// ─── Wire MCP Server for Bug 4 tests ────────────────────────────
//
// Calls handleCombinedDiscover with two mock executors that have overlapping agent IDs.

function wireDiscoverTestServer(
  mcpServer: McpServer,
  inProcessExecutor: AgentExecutor,
  workerExecutor: AgentExecutor,
): void {
  mcpServer.registerTool('agents_discover', {
    description: 'Discover agents',
    inputSchema: { capability: z.string().optional() },
  }, async (args) => {
    return await handleCombinedDiscover(inProcessExecutor, workerExecutor, args as any);
  });
}

// ─── Wire MCP Server for Bug 5 tests ────────────────────────────
//
// Calls handleBridgeHealth with an executor whose health() throws.

function wireHealthTestServer(
  mcpServer: McpServer,
  executor: AgentExecutor,
): void {
  mcpServer.registerTool('bridge_health', {
    description: 'Health check',
  }, async () => {
    return await handleBridgeHealth(executor);
  });
}

// ─── Helper: deep-search JSON for forbidden patterns ─────────────

const PATH_PATTERNS = /\/Users\/|\/home\/|\/app\/|\.ts:|\.js:/;

function deepSearchForStack(obj: unknown, path = ''): string[] {
  const findings: string[] = [];
  if (obj === null || obj === undefined) return findings;

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'stack') {
        findings.push(`Found "stack" key at ${path}.${key}`);
      }
      if (typeof value === 'string' && PATH_PATTERNS.test(value)) {
        findings.push(`Found file path in ${path}.${key}: "${value.substring(0, 80)}..."`);
      }
      findings.push(...deepSearchForStack(value, `${path}.${key}`));
    }
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...deepSearchForStack(obj[i], `${path}[${i}]`));
    }
  }

  return findings;
}

// ─── Tests ───────────────────────────────────────────────────────

async function testBug2And3_NoStackTracesInErrors(): Promise<void> {
  console.log('\n  [Bug 2+3] No stack traces in MCP error responses');

  // Setup: real InProcessExecutor with a FailingAgent
  const executor = new InProcessExecutor({ silent: true });
  executor.register(new EchoAgent());
  executor.register(new FailingAgent());
  await executor.start();

  const mcpServer = new McpServer(
    { name: 'bug23-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  wireErrorTestServer(mcpServer, executor);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bug23-client', version: '1.0.0' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // Test 1: Agent that throws → error response should have no stack traces
    console.log('    Subtest: Agent throws error → no stack in response');

    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'failing-agent' },
    });
    const { sessionId } = parseResult(createResult);
    check(typeof sessionId === 'string', 'Session created for failing-agent');

    const promptResult = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId, prompt: 'trigger failure' },
    });
    const promptData = parseResult(promptResult);

    // Deep-search the ENTIRE response for "stack" keys
    const stackFindings = deepSearchForStack(promptData);
    check(stackFindings.length === 0, `No "stack" key in error response (findings: ${stackFindings.join('; ') || 'none'})`);

    // Check for file system paths in the entire serialized response
    const serialized = JSON.stringify(promptData);
    const hasFilePaths = PATH_PATTERNS.test(serialized);
    check(!hasFilePaths, `No file system paths in error response`);

    // Verify the error response has the expected structure
    check(promptData.error !== undefined, 'Error field present in response');
    check(typeof promptData.code === 'number', `Error code is a number (got ${promptData.code})`);

    // Test 2: Unknown agent → BridgeError path, also no stack traces
    console.log('    Subtest: Unknown agent → BridgeError path, no stack');

    const unknownResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'nonexistent-agent-xyz' },
    });
    const unknownData = parseResult(unknownResult);

    const unknownStackFindings = deepSearchForStack(unknownData);
    check(unknownStackFindings.length === 0, `No "stack" key in BridgeError response (findings: ${unknownStackFindings.join('; ') || 'none'})`);

    const unknownSerialized = JSON.stringify(unknownData);
    const unknownHasFilePaths = PATH_PATTERNS.test(unknownSerialized);
    check(!unknownHasFilePaths, `No file system paths in BridgeError response`);

    check(unknownData.error !== undefined, 'Error field present in BridgeError response');
    check(typeof unknownData.code === 'number', `Error code is a number in BridgeError response (got ${unknownData.code})`);

  } finally {
    await client.close();
    await mcpServer.close();
    await executor.close();
  }
}

async function testBug4_NoDuplicateAgentsInDiscover(): Promise<void> {
  console.log('\n  [Bug 4] No duplicate agents in combined discover');

  // Setup: two executors with overlapping agent IDs
  const inProcessExecutor = new MockAgentExecutor([
    { id: 'shared-agent', capabilities: ['in-process-cap'], status: 'ready' },
    { id: 'in-process-only', capabilities: ['local'], status: 'ready' },
  ]);

  const workerExecutor = new MockAgentExecutor([
    { id: 'shared-agent', capabilities: ['worker-cap'], status: 'ready' },
    { id: 'worker-only', capabilities: ['remote'], status: 'ready' },
  ]);

  const mcpServer = new McpServer(
    { name: 'bug4-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  wireDiscoverTestServer(mcpServer, inProcessExecutor, workerExecutor);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bug4-client', version: '1.0.0' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const data = parseResult(result);
    const agents: AgentInfo[] = data.agents;

    // All agent IDs should be unique
    const ids = agents.map(a => a.id);
    const uniqueIds = new Set(ids);
    check(uniqueIds.size === ids.length, `All agent IDs are unique (${ids.length} agents, ${uniqueIds.size} unique)`);

    // Should have exactly 3 agents: shared-agent, in-process-only, worker-only
    check(agents.length === 3, `3 agents total after dedup (got ${agents.length})`);

    // In-process agent takes precedence for the shared ID
    const sharedAgent = agents.find(a => a.id === 'shared-agent');
    check(sharedAgent !== undefined, 'shared-agent present in results');
    check(
      sharedAgent?.capabilities.includes('in-process-cap') === true,
      `shared-agent has in-process capabilities (precedence) — got ${JSON.stringify(sharedAgent?.capabilities)}`,
    );

    // Both unique agents are present
    check(agents.some(a => a.id === 'in-process-only'), 'in-process-only agent present');
    check(agents.some(a => a.id === 'worker-only'), 'worker-only agent present');

  } finally {
    await client.close();
    await mcpServer.close();
  }
}

async function testBug5_HealthErrorShape(): Promise<void> {
  console.log('\n  [Bug 5] Health error returns { error, code, data } not { healthy, error }');

  const failingExecutor = new FailingHealthExecutor();

  const mcpServer = new McpServer(
    { name: 'bug5-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  wireHealthTestServer(mcpServer, failingExecutor);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bug5-client', version: '1.0.0' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: 'bridge_health',
      arguments: {},
    });
    const data = parseResult(result);

    // Should have { error, code, data } shape
    check(data.error !== undefined, 'Response has "error" key');
    check(data.code !== undefined, 'Response has "code" key');
    check(data.data !== undefined, 'Response has "data" key');

    // Should NOT have { healthy } key (old broken shape)
    check(data.healthy === undefined, `Response does NOT have "healthy" key (got ${JSON.stringify(data.healthy)})`);

    // code should be a number (JSON-RPC error code)
    check(typeof data.code === 'number', `"code" is a number (got ${typeof data.code}: ${data.code})`);

    // data.type should be 'INTERNAL'
    check(data.data?.type === 'INTERNAL', `data.type is "INTERNAL" (got "${data.data?.type}")`);

    // No stack traces in the health error response either
    const stackFindings = deepSearchForStack(data);
    check(stackFindings.length === 0, `No "stack" key in health error response (findings: ${stackFindings.join('; ') || 'none'})`);

  } finally {
    await client.close();
    await mcpServer.close();
  }
}

async function testBug6_CleanShutdownWithActiveSessions(): Promise<void> {
  console.log('\n  [Bug 6] Clean shutdown with active sessions');

  // Setup: real InProcessExecutor with agents and active sessions
  const executor = new InProcessExecutor({ silent: false });
  executor.register(new EchoAgent());
  await executor.start();

  // Create multiple sessions
  const session1 = await executor.createSession('echo-agent');
  const session2 = await executor.createSession('echo-agent');
  const session3 = await executor.createSession('echo-agent');

  check(session1.sessionId !== session2.sessionId, 'Sessions have unique IDs');
  check(session2.sessionId !== session3.sessionId, 'All sessions have unique IDs');

  // Capture stderr to verify session count logging
  const originalStderrWrite = process.stderr.write;
  let stderrOutput = '';
  process.stderr.write = function (chunk: any, ...args: any[]): boolean {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    stderrOutput += str;
    return originalStderrWrite.call(process.stderr, chunk, ...args);
  } as any;

  try {
    // close() should not throw even with active sessions
    let closeError: Error | undefined;
    try {
      await executor.close();
    } catch (err) {
      closeError = err instanceof Error ? err : new Error(String(err));
    }

    check(closeError === undefined, `close() did not throw (error: ${closeError?.message ?? 'none'})`);

    // stderr should mention session count
    check(stderrOutput.includes('3'), `stderr mentions session count (output: "${stderrOutput.trim()}")`);

  } finally {
    // Restore stderr
    process.stderr.write = originalStderrWrite;
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: publish-blockers-e2e — Regression tests for publish-blocker bugs\n');

  await testBug2And3_NoStackTracesInErrors();
  await testBug4_NoDuplicateAgentsInDiscover();
  await testBug5_HealthErrorShape();
  await testBug6_CleanShutdownWithActiveSessions();

  // Report
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
