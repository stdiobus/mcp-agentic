/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Quick test client for codex-acp MCP server.
 * Connects via real stdio, runs a few tool calls, exits.
 *
 * Usage: tsx scripts/test-codex-acp-client.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

async function main(): Promise<void> {
  console.log('Connecting to codex-acp MCP server via stdio...\n');

  const serverScript = resolve(__dirname, 'run-codex-acp-server.ts');
  const tsxBin = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [serverScript],
    stderr: 'pipe',
  });

  const client = new Client({ name: 'codex-acp-test-client', version: '1.0.0' });
  await client.connect(transport);

  // 1. List tools
  const tools = await client.listTools();
  console.log(`Tools (${tools.tools.length}): ${tools.tools.map(t => t.name).join(', ')}\n`);

  // 2. Health check
  const health = await client.callTool({ name: 'bridge_health', arguments: {} });
  console.log('Health:', parseResult(health), '\n');

  // 3. Discover agents
  const agents = await client.callTool({ name: 'agents_discover', arguments: {} });
  console.log('Agents:', parseResult(agents), '\n');

  // 4. Create session
  const session = await client.callTool({ name: 'sessions_create', arguments: { agentId: 'codex-acp' } });
  const { sessionId } = parseResult(session);
  console.log(`Session created: ${sessionId}\n`);

  // 5. Multi-turn conversation
  const r1 = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Help me review this TypeScript code' } });
  console.log('Turn 1:', parseResult(r1).text, '\n');

  const r2 = await client.callTool({ name: 'sessions_prompt', arguments: { sessionId, prompt: 'Focus on error handling patterns' } });
  console.log('Turn 2:', parseResult(r2).text, '\n');

  // 6. Close session
  await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  console.log('Session closed.\n');

  // 7. tasks_delegate (fire-and-forget)
  const delegate = await client.callTool({ name: 'tasks_delegate', arguments: { prompt: 'What architecture pattern should I use for a plugin system?' } });
  console.log('Delegate result:', parseResult(delegate), '\n');

  await client.close();
  console.log('Done. Real MCP stdio protocol verified.');
  process.exit(0);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
