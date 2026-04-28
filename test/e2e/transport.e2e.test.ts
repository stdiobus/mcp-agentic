/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Real MCP Stdio Transport — child process + JSON-RPC over pipes.
 *
 * This is the true transport-level e2e test:
 *   1. Spawns test fixture server as a child process
 *   2. Connects via StdioClientTransport (real stdin/stdout pipes)
 *   3. Sends MCP tool calls as JSON-RPC messages
 *   4. Verifies full round-trip through real transport
 *
 * The test fixture (test/e2e/fixtures/stdio-test-server.mjs) registers
 * 4 deterministic agents: echo-agent, stateful-agent, math-agent, failing-agent.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helper ──────────────────────────────────────────────────────

function parseToolResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('Empty tool result');
  return JSON.parse(text);
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('E2E: Real MCP Stdio Transport', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    const fixtureServer = resolve(
      __dirname,
      'fixtures',
      'stdio-test-server.ts',
    );

    const tsxBin = resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

    transport = new StdioClientTransport({
      command: tsxBin,
      args: [fixtureServer],
      stderr: 'pipe',
    });

    client = new Client(
      { name: 'e2e-test-client', version: '1.0.0' },
    );

    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    await client.close();
  });

  // ─── Tool Discovery ────────────────────────────────────────────

  describe('tool discovery over stdio', () => {
    it('lists all 8 MCP tools', async () => {
      const result = await client.listTools();
      expect(result.tools.length).toBe(8);
      const names = result.tools.map(t => t.name);
      expect(names).toContain('bridge_health');
      expect(names).toContain('sessions_create');
      expect(names).toContain('tasks_delegate');
    });
  });

  // ─── Health ────────────────────────────────────────────────────

  describe('bridge_health over stdio', () => {
    it('reports healthy', async () => {
      const result = await client.callTool({ name: 'bridge_health', arguments: {} });
      const health = parseToolResult(result);
      expect(health.healthy).toBe(true);
      expect(health.agents.total).toBe(4);
    });
  });

  // ─── Agent Discovery ──────────────────────────────────────────

  describe('agents_discover over stdio', () => {
    it('discovers all agents', async () => {
      const result = await client.callTool({ name: 'agents_discover', arguments: {} });
      const { agents } = parseToolResult(result);
      expect(agents.length).toBe(4);
      const ids = agents.map((a: any) => a.id);
      expect(ids).toContain('echo-agent');
      expect(ids).toContain('stateful-agent');
      expect(ids).toContain('math-agent');
      expect(ids).toContain('failing-agent');
    });

    it('filters by capability', async () => {
      const result = await client.callTool({ name: 'agents_discover', arguments: { capability: 'calculation' } });
      const { agents } = parseToolResult(result);
      expect(agents.length).toBe(1);
      expect(agents[0].id).toBe('math-agent');
    });
  });

  // ─── Full Session Lifecycle ────────────────────────────────────

  describe('session lifecycle over stdio', () => {
    it('create → prompt → close round-trip', async () => {
      // Create session
      const createResult = await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'echo-agent' },
      });
      const { sessionId, agentId } = parseToolResult(createResult);
      expect(sessionId).toBeTruthy();
      expect(agentId).toBe('echo-agent');

      // Prompt
      const promptResult = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Hello over stdio' },
      });
      const promptData = parseToolResult(promptResult);
      expect(promptData.text).toBe('Echo[1]: Hello over stdio');
      expect(promptData.stopReason).toBe('end_turn');

      // Close
      const closeResult = await client.callTool({
        name: 'sessions_close',
        arguments: { sessionId },
      });
      const closeData = parseToolResult(closeResult);
      expect(closeData.closed).toBe(true);
    });
  });

  // ─── Multi-Turn ────────────────────────────────────────────────

  describe('multi-turn over stdio', () => {
    it('stateful agent preserves context', async () => {
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

  // ─── tasks_delegate ────────────────────────────────────────────

  describe('tasks_delegate over stdio', () => {
    it('fire-and-forget with math agent', async () => {
      const result = await client.callTool({
        name: 'tasks_delegate',
        arguments: { prompt: '3 + 7', agentId: 'math-agent' },
      });
      const data = parseToolResult(result);
      expect(data.success).toBe(true);
      expect(data.text).toContain('Result: 10');
    });
  });

  // ─── Error Handling ────────────────────────────────────────────

  describe('error handling over stdio', () => {
    it('returns error for unknown agent', async () => {
      const result = await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'nonexistent' },
      });
      const data = parseToolResult(result);
      expect(data.error).toBeDefined();
    });

    it('returns error when agent throws', async () => {
      const { sessionId } = parseToolResult(
        await client.callTool({ name: 'sessions_create', arguments: { agentId: 'failing-agent' } }),
      );

      const result = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'will fail' },
      });
      const data = parseToolResult(result);
      expect(data.error).toBeDefined();
    });
  });
});
