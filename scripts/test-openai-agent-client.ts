/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test client for openai-agent MCP server.
 * Connects via real stdio, runs tool calls, exits.
 *
 * Usage: tsx scripts/test-openai-agent-client.ts
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
  console.log('Connecting to openai-agent MCP server via stdio...\n');

  const serverScript = resolve(__dirname, 'run-openai-agent-server.ts');
  const tsxBin = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [serverScript],
    stderr: 'pipe',
  });

  const client = new Client({ name: 'openai-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('Connected.\n');

    // 1. Health
    const health = await client.callTool({ name: 'bridge_health', arguments: {} });
    console.log('Health:', parseResult(health), '\n');

    // 2. Discover
    const agents = await client.callTool({ name: 'agents_discover', arguments: {} });
    console.log('Agents:', parseResult(agents), '\n');

    // 3. Create session
    const session = await client.callTool({ name: 'sessions_create', arguments: {} });
    const sessionData = parseResult(session);
    console.log('Session:', sessionData, '\n');

    // 4. Prompt — real OpenAI call
    console.log('Sending prompt to OpenAI...');
    const prompt = await client.callTool({
      name: 'sessions_prompt',
      arguments: {
        sessionId: sessionData.sessionId,
        prompt: 'What is the capital of France? Answer in one sentence.',
      },
    });
    const promptData = parseResult(prompt);
    console.log('Response:', promptData.text, '\n');
    console.log('Usage:', promptData.usage, '\n');

    // 5. Close
    await client.callTool({ name: 'sessions_close', arguments: { sessionId: sessionData.sessionId } });
    console.log('Session closed.\n');

    console.log('OpenAI agent MCP server verified.');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.close();
  }

  process.exit(0);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
