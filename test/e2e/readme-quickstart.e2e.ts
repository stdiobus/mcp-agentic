#!/usr/bin/env tsx

/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * README Quick Start — e2e validation
 *
 * Spawns the exact Quick Start code from README as a child process,
 * sends MCP JSON-RPC requests via stdin, reads responses from stdout.
 *
 * If this test fails, the README Quick Start snippet doesn't work.
 *
 * Run: tsx test/e2e/readme-quickstart.e2e.ts
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, 'fixtures', 'readme-quickstart-server.ts');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// ─── MCP JSON-RPC helpers ────────────────────────────────────────

let requestId = 0;

function mcpRequest(method: string, params: Record<string, unknown> = {}): string {
  requestId++;
  return JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n';
}

function parseResponses(data: string): Array<Record<string, unknown>> {
  return data
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null);
}

// ─── Test runner ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  README Quick Start — e2e Validation                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Spawn the README Quick Start server
  const child = spawn('npx', ['tsx', serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // ── Test 1: MCP Initialize ──────────────────────────────────
    console.log('[Test 1] MCP Initialize\n');

    child.stdin.write(mcpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'readme-test', version: '1.0.0' },
    }));

    await new Promise((resolve) => setTimeout(resolve, 500));

    const initResponses = parseResponses(stdout);
    assert(initResponses.length > 0, 'Got initialize response');

    const initResult = initResponses[0]?.result as Record<string, unknown> | undefined;
    assert(initResult !== undefined, 'Initialize has result');
    assert(
      (initResult?.serverInfo as Record<string, unknown>)?.name === 'mcp-agentic',
      `Server name is "mcp-agentic" (got "${(initResult?.serverInfo as Record<string, unknown>)?.name}")`,
    );

    // Send initialized notification
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ── Test 2: List Tools ──────────────────────────────────────
    console.log('\n[Test 2] List Tools\n');

    stdout = '';
    child.stdin.write(mcpRequest('tools/list', {}));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const toolsResponses = parseResponses(stdout);
    assert(toolsResponses.length > 0, 'Got tools/list response');

    const toolsResult = toolsResponses[0]?.result as Record<string, unknown> | undefined;
    const tools = (toolsResult?.tools ?? []) as Array<Record<string, unknown>>;
    assert(tools.length === 8, `8 tools registered (got ${tools.length})`);

    const toolNames = tools.map((t) => t.name);
    assert(toolNames.includes('bridge_health'), 'Has bridge_health');
    assert(toolNames.includes('agents_discover'), 'Has agents_discover');
    assert(toolNames.includes('sessions_create'), 'Has sessions_create');
    assert(toolNames.includes('sessions_prompt'), 'Has sessions_prompt');
    assert(toolNames.includes('tasks_delegate'), 'Has tasks_delegate');

    // ── Test 3: Bridge Health ───────────────────────────────────
    console.log('\n[Test 3] Bridge Health\n');

    stdout = '';
    child.stdin.write(mcpRequest('tools/call', {
      name: 'bridge_health',
      arguments: {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const healthResponses = parseResponses(stdout);
    assert(healthResponses.length > 0, 'Got bridge_health response');

    const healthResult = healthResponses[0]?.result as Record<string, unknown> | undefined;
    const healthContent = (healthResult?.content as Array<Record<string, unknown>>)?.[0];
    const healthData = JSON.parse((healthContent?.text as string) ?? '{}');
    assert(healthData.healthy === true, `healthy: true (got ${healthData.healthy})`);
    assert(healthData.agents?.total === 1, `1 agent total (got ${healthData.agents?.total})`);

    // ── Test 4: Agents Discover ─────────────────────────────────
    console.log('\n[Test 4] Agents Discover\n');

    stdout = '';
    child.stdin.write(mcpRequest('tools/call', {
      name: 'agents_discover',
      arguments: {},
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const discoverResponses = parseResponses(stdout);
    const discoverResult = discoverResponses[0]?.result as Record<string, unknown> | undefined;
    const discoverContent = (discoverResult?.content as Array<Record<string, unknown>>)?.[0];
    const discoverData = JSON.parse((discoverContent?.text as string) ?? '{}');
    assert(discoverData.agents?.length === 1, `1 agent discovered (got ${discoverData.agents?.length})`);
    assert(discoverData.agents?.[0]?.id === 'my-agent', `Agent id is "my-agent"`);
    assert(
      discoverData.agents?.[0]?.capabilities?.includes('code-analysis'),
      'Agent has "code-analysis" capability',
    );

    // ── Test 5: tasks_delegate (full round-trip) ────────────────
    console.log('\n[Test 5] tasks_delegate (full round-trip)\n');

    stdout = '';
    child.stdin.write(mcpRequest('tools/call', {
      name: 'tasks_delegate',
      arguments: {
        prompt: 'Hello from README test',
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const delegateResponses = parseResponses(stdout);
    const delegateResult = delegateResponses[0]?.result as Record<string, unknown> | undefined;
    const delegateContent = (delegateResult?.content as Array<Record<string, unknown>>)?.[0];
    const delegateData = JSON.parse((delegateContent?.text as string) ?? '{}');
    assert(delegateData.success === true, `tasks_delegate succeeded`);
    assert(delegateData.text === 'Analyzed: Hello from README test', `Agent returned correct text`);
    assert(delegateData.stopReason === 'end_turn', `stopReason is end_turn`);
    assert(delegateData.agentId === 'my-agent', `Routed to my-agent`);

    // ── Summary ─────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('══════════════════════════════════════════════════════════\n');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
