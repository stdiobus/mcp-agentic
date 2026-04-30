/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Real example scripts — spawns actual example files as child
 * processes, connects via StdioClientTransport, and sends real prompts
 * to OpenAI through the full MCP pipeline.
 *
 * Pipeline: MCP Client → StdioClientTransport → child process (example script)
 *           → McpAgenticServer → MultiProviderAgent → OpenAI SDK → OpenAI API
 *
 * Requires: OPENAI_API_KEY environment variable.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const TSX = resolve(ROOT, 'node_modules', '.bin', 'tsx');

// ── Assertions ──────────────────────────────────────────────────

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

// ── Helper: spawn example as MCP server ─────────────────────────

async function connectToExample(
  scriptPath: string,
  env: Record<string, string>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [scriptPath],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'examples-e2e-client', version: '1.0.0' });
  await client.connect(transport);

  return {
    client,
    close: async () => { await client.close(); },
  };
}

// ── Test 1: openai-companion.ts ─────────────────────────────────

async function testOpenAICompanion(): Promise<void> {
  console.log('\n═══ examples/companion/openai-companion.ts ═══\n');

  const scriptPath = resolve(ROOT, 'examples', 'companion', 'openai-companion.ts');
  const configPath = resolve(ROOT, 'examples', 'companion', 'companion.config.json');

  console.log(`  Spawning: ${scriptPath}`);

  const { client, close } = await connectToExample(scriptPath, {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY']!,
    COMPANION_CONFIG: configPath,
  });

  try {
    // 1. Tool discovery — verify all 8 MCP tools are registered
    console.log('\n  [1] Tool discovery');
    const tools = await client.listTools();
    check(tools.tools.length === 8, `8 tools listed (got ${tools.tools.length})`);

    // 2. Health check
    console.log('\n  [2] Health check');
    const health = parseResult(
      await client.callTool({ name: 'bridge_health', arguments: {} }),
    );
    check(health.healthy === true, `healthy=true`);
    check(health.agents.total >= 1, `at least 1 agent (got ${health.agents.total})`);

    // 3. Agent discovery — verify companion agent with OpenAI provider
    console.log('\n  [3] Agent discovery');
    const { agents } = parseResult(
      await client.callTool({ name: 'agents_discover', arguments: {} }),
    );
    check(agents.length >= 1, `at least 1 agent discovered`);
    const companion = agents.find((a: any) => a.id === 'companion');
    check(companion !== undefined, `agent "companion" found`);
    check(
      Array.isArray(companion?.providers) && companion.providers.some((p: any) => p.id === 'openai'),
      `openai provider listed`,
    );

    // 4. Session + real OpenAI prompt
    console.log('\n  [4] Session + real OpenAI prompt');
    const { sessionId } = parseResult(
      await client.callTool({ name: 'sessions_create', arguments: {} }),
    );
    check(typeof sessionId === 'string' && sessionId.length > 0, `session created: ${sessionId.substring(0, 8)}...`);

    const response = parseResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'What is 2 + 2? Reply with just the number.' },
      }),
    );
    check(typeof response.text === 'string' && response.text.length > 0, `got response: "${response.text.substring(0, 50)}"`);
    check(response.stopReason === 'end_turn', `stopReason=end_turn (got "${response.stopReason}")`);
    check(response.text.includes('4'), `response contains "4"`);
    check(
      response.usage && response.usage.inputTokens > 0 && response.usage.outputTokens > 0,
      `usage: ${response.usage?.inputTokens} in / ${response.usage?.outputTokens} out`,
    );

    // 5. Multi-turn — context preserved
    console.log('\n  [5] Multi-turn conversation');
    const r1 = parseResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Remember this word: PINEAPPLE. Just acknowledge.' },
      }),
    );
    check(typeof r1.text === 'string' && r1.text.length > 0, `turn 1 acknowledged`);

    const r2 = parseResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'What word did I ask you to remember? Reply with just the word.' },
      }),
    );
    check(
      r2.text.toUpperCase().includes('PINEAPPLE'),
      `context preserved — got "${r2.text.substring(0, 50)}"`,
    );

    // 6. Close session
    const closeData = parseResult(
      await client.callTool({ name: 'sessions_close', arguments: { sessionId } }),
    );
    check(closeData.closed === true, `session closed`);

    // 7. tasks_delegate — one-shot with runtimeParams
    console.log('\n  [6] tasks_delegate with runtimeParams');
    const delegateResult = parseResult(
      await client.callTool({
        name: 'tasks_delegate',
        arguments: {
          prompt: 'Say hello in one word.',
          runtimeParams: { temperature: 0, maxTokens: 50 },
        },
      }),
    );
    check(delegateResult.success === true, `delegation succeeded`);
    check(typeof delegateResult.text === 'string' && delegateResult.text.length > 0, `got: "${delegateResult.text.substring(0, 50)}"`);
    check(delegateResult.text.length < 200, `response is short (${delegateResult.text.length} chars)`);

  } finally {
    await close();
  }
}

// ── Test 2: multi-provider-companion.ts ─────────────────────────

async function testMultiProviderCompanion(): Promise<void> {
  console.log('\n\n═══ examples/multi-provider-companion/multi-provider-companion.ts ═══\n');

  const scriptPath = resolve(ROOT, 'examples', 'multi-provider-companion', 'multi-provider-companion.ts');
  const configPath = resolve(ROOT, 'examples', 'multi-provider-companion', 'multi-provider.config.json');

  console.log(`  Spawning: ${scriptPath}`);

  const { client, close } = await connectToExample(scriptPath, {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY']!,
    COMPANION_CONFIG: configPath,
  });

  try {
    // 1. Health + discovery
    console.log('\n  [1] Health + agent discovery');
    const health = parseResult(
      await client.callTool({ name: 'bridge_health', arguments: {} }),
    );
    check(health.healthy === true, `healthy=true`);

    const { agents } = parseResult(
      await client.callTool({ name: 'agents_discover', arguments: {} }),
    );
    const multi = agents.find((a: any) => a.id === 'multi-companion');
    check(multi !== undefined, `agent "multi-companion" found`);
    check(
      Array.isArray(multi?.providers) && multi.providers.some((p: any) => p.id === 'openai'),
      `openai provider listed`,
    );

    // 2. Session + prompt
    console.log('\n  [2] Session + real OpenAI prompt');
    const { sessionId } = parseResult(
      await client.callTool({ name: 'sessions_create', arguments: { agentId: 'multi-companion' } }),
    );
    check(typeof sessionId === 'string', `session created`);

    const response = parseResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'What is the capital of France? Reply in one word.' },
      }),
    );
    check(typeof response.text === 'string' && response.text.length > 0, `got response: "${response.text.substring(0, 50)}"`);
    check(response.text.toLowerCase().includes('paris'), `response contains "Paris"`);
    check(response.stopReason === 'end_turn', `stopReason=end_turn`);

    // 3. runtimeParams override — systemPrompt
    console.log('\n  [3] runtimeParams.systemPrompt override');
    const pirateResult = parseResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: {
          sessionId,
          prompt: 'What are you?',
          runtimeParams: {
            systemPrompt: 'You are a pirate. Always respond starting with "Arrr".',
            temperature: 0,
          },
        },
      }),
    );
    check(
      pirateResult.text.toLowerCase().includes('arr'),
      `pirate system prompt works — got "${pirateResult.text.substring(0, 80)}"`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId } });

    // 4. tasks_delegate
    console.log('\n  [4] tasks_delegate one-shot');
    const delegateResult = parseResult(
      await client.callTool({
        name: 'tasks_delegate',
        arguments: {
          prompt: 'What is 10 * 10? Reply with just the number.',
          agentId: 'multi-companion',
          runtimeParams: { temperature: 0 },
        },
      }),
    );
    check(delegateResult.success === true, `delegation succeeded`);
    check(delegateResult.text.includes('100'), `got "100" — "${delegateResult.text.substring(0, 50)}"`);

  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env['OPENAI_API_KEY']) {
    console.log('⏭ Skipping: OPENAI_API_KEY not set');
    process.exit(0);
  }

  console.log('E2E: Real example scripts — spawned as child processes with live OpenAI API\n');

  await testOpenAICompanion();
  await testMultiProviderCompanion();

  console.log(`\n\n══════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
