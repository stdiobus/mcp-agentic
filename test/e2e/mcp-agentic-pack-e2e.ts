/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: npm pack — verify published package works as a real consumer would use it.
 *
 * This is the **release gate** — it proves the published package works when
 * installed via npm, not just when imported from source.
 *
 * Pipeline:
 *   1. npm run build → full build (esbuild + tsc)
 *   2. npm pack → creates local tarball
 *   3. Install tarball in a temp directory (simulates `npm install @stdiobus/mcp-agentic`)
 *   4. Run consumer scripts that import from the installed package
 *   5. Verify:
 *      a. CLI binary works (mcp-agentic starts, tools respond)
 *      b. ALL value exports resolve without MODULE_NOT_FOUND
 *      c. Type declarations (.d.ts) exist for all public exports
 *      d. Provider factories (openAI, anthropic, gemini) can be called
 *         (SDK peer deps missing → BridgeError CONFIG, not MODULE_NOT_FOUND)
 *      e. defineProvider creates working factories
 *      f. createMultiProviderAgent creates working agents
 *      g. McpAgenticServer can register agents and start
 *      h. mapParameters, mergeRuntimeParams, ProviderRegistry work
 *      i. BridgeError class and error categories work
 *
 * Why this test exists:
 *   esbuild bundles all internal modules into a single file. If any internal
 *   module is loaded via dynamic require with a relative path (e.g.,
 *   `createRequire(import.meta.url)('../providers/OpenAIProvider.js')`),
 *   the path breaks in the bundle because the file doesn't exist on disk.
 *   This test catches such issues by running code from the actual bundle.
 *
 * Run with:
 *   npx tsx test/e2e/mcp-agentic-pack-e2e.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

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

// ─── Consumer script generator ───────────────────────────────────

/**
 * Generate a Node.js ESM script that imports from the installed package
 * and exercises the specified functionality. The script outputs JSON
 * results to stdout for verification.
 */
function consumerScript(code: string): string {
  return `
import { createRequire } from 'node:module';
const results = [];
function ok(label) { results.push({ label, pass: true }); }
function fail(label, err) { results.push({ label, pass: false, error: String(err) }); }

async function main() {
  try {
${code}
  } catch (err) {
    fail('FATAL', err);
  }
  console.log(JSON.stringify(results));
}
main();
`;
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: npm pack — verify published package works as MCP server & library\n');

  // Step 1: Build
  console.log('  [1] Building project...');
  execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
  console.log('  ✓ Build succeeded\n');

  // Step 2: Pack
  console.log('  [2] Creating tarball with npm pack...');
  const packOutput = execSync('npm pack --json', { cwd: projectRoot, encoding: 'utf-8' });
  const packInfo = JSON.parse(packOutput);
  const tarballName = packInfo[0]?.filename;
  check(typeof tarballName === 'string' && tarballName.endsWith('.tgz'), `Tarball created: ${tarballName}`);

  const tarballPath = resolve(projectRoot, tarballName);

  // Step 3: Install in temp directory
  const tempDir = mkdtempSync(join(tmpdir(), 'mcp-agentic-e2e-'));
  console.log(`\n  [3] Installing in temp dir: ${tempDir}`);

  try {
    // Initialize a minimal ESM package
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'pack-e2e-consumer',
      version: '1.0.0',
      type: 'module',
      private: true,
    }));

    execSync(`npm install "${tarballPath}"`, { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

    // Also install zod (needed by defineProvider consumer code)
    execSync('npm install zod', { cwd: tempDir, stdio: 'pipe', timeout: 30_000 });

    // Verify binary exists
    const binExists = readdirSync(resolve(tempDir, 'node_modules', '.bin')).includes('mcp-agentic');
    check(binExists, 'Binary installed at node_modules/.bin/mcp-agentic');

    // ─── Phase A: CLI binary test ──────────────────────────────

    console.log('\n  [4] Phase A: CLI binary — start server, connect, verify tools...');

    const binPath = resolve(tempDir, 'node_modules', '.bin', 'mcp-agentic');

    const transport = new StdioClientTransport({
      command: binPath,
      args: [],
      stderr: 'pipe',
    });

    transport.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`  [server stderr] ${data.toString()}`);
    });

    const client = new Client({ name: 'pack-e2e-client', version: '1.0.0' });
    await client.connect(transport);
    console.log('  ✓ Connected to server via stdio\n');

    const tools = await client.listTools();
    check(tools.tools.length === 8, `8 tools listed (got ${tools.tools.length})`);

    const toolNames = tools.tools.map(t => t.name);
    check(toolNames.includes('bridge_health'), 'bridge_health present');
    check(toolNames.includes('agents_discover'), 'agents_discover present');
    check(toolNames.includes('sessions_create'), 'sessions_create present');
    check(toolNames.includes('sessions_prompt'), 'sessions_prompt present');
    check(toolNames.includes('sessions_status'), 'sessions_status present');
    check(toolNames.includes('sessions_close'), 'sessions_close present');
    check(toolNames.includes('sessions_cancel'), 'sessions_cancel present');
    check(toolNames.includes('tasks_delegate'), 'tasks_delegate present');

    // Health check
    const health = await client.callTool({ name: 'bridge_health', arguments: {} });
    const healthData = parseResult(health);
    check(healthData.healthy === false, 'healthy=false (no agents registered — expected for bare server)');
    check(healthData.agents.total === 0, '0 agents (bare server)');

    await client.close();
    console.log('  ✓ CLI binary phase complete\n');

    // ─── Phase B: Library value exports resolve ────────────────

    console.log('  [5] Phase B: All value exports resolve from installed package...');

    const exportTestScript = consumerScript(`
    // Test ALL value exports from @stdiobus/mcp-agentic
    const pkg = await import('@stdiobus/mcp-agentic');

    // Server
    if (typeof pkg.McpAgenticServer === 'function') ok('McpAgenticServer');
    else fail('McpAgenticServer', 'not a function');

    // Provider classes
    if (typeof pkg.OpenAIProvider === 'function') ok('OpenAIProvider');
    else fail('OpenAIProvider', 'not a function');

    if (typeof pkg.AnthropicProvider === 'function') ok('AnthropicProvider');
    else fail('AnthropicProvider', 'not a function');

    if (typeof pkg.GoogleGeminiProvider === 'function') ok('GoogleGeminiProvider');
    else fail('GoogleGeminiProvider', 'not a function');

    // Provider utilities
    if (typeof pkg.ProviderRegistry === 'function') ok('ProviderRegistry');
    else fail('ProviderRegistry', 'not a function');

    if (typeof pkg.mergeRuntimeParams === 'function') ok('mergeRuntimeParams');
    else fail('mergeRuntimeParams', 'not a function');

    if (typeof pkg.mapParameters === 'function') ok('mapParameters');
    else fail('mapParameters', 'not a function');

    if (typeof pkg.getMaxTokensParamName === 'function') ok('getMaxTokensParamName');
    else fail('getMaxTokensParamName', 'not a function');

    // Multi-provider agent
    if (typeof pkg.MultiProviderAgent === 'function') ok('MultiProviderAgent');
    else fail('MultiProviderAgent', 'not a function');

    // Factory API
    if (typeof pkg.defineProvider === 'function') ok('defineProvider');
    else fail('defineProvider', 'not a function');

    if (typeof pkg.openAI === 'function') ok('openAI');
    else fail('openAI', 'not a function');

    if (typeof pkg.anthropic === 'function') ok('anthropic');
    else fail('anthropic', 'not a function');

    if (typeof pkg.gemini === 'function') ok('gemini');
    else fail('gemini', 'not a function');

    if (typeof pkg.createMultiProviderAgent === 'function') ok('createMultiProviderAgent');
    else fail('createMultiProviderAgent', 'not a function');
    `);

    writeFileSync(join(tempDir, 'test-exports.mjs'), exportTestScript);
    const exportResults = JSON.parse(
      execSync('node test-exports.mjs', { cwd: tempDir, encoding: 'utf-8', timeout: 15_000 }),
    );

    for (const r of exportResults) {
      check(r.pass, `export: ${r.label}${r.pass ? '' : ` — ${r.error}`}`);
    }

    // ─── Phase C: Provider factories — SDK missing → BridgeError CONFIG ─

    console.log('\n  [6] Phase C: Provider factories — SDK missing → BridgeError CONFIG (not MODULE_NOT_FOUND)...');

    const factoryTestScript = consumerScript(`
    const { openAI, anthropic, gemini } = await import('@stdiobus/mcp-agentic');

    // openAI — SDK not installed → should throw BridgeError CONFIG
    try {
      openAI({ apiKey: 'test-key', models: ['gpt-4o'] });
      fail('openAI-no-sdk', 'expected error but none thrown');
    } catch (err) {
      if (err.type === 'CONFIG' && err.message.includes('openai')) {
        ok('openAI-no-sdk: BridgeError CONFIG');
      } else if (err.code === 'MODULE_NOT_FOUND') {
        fail('openAI-no-sdk', 'MODULE_NOT_FOUND — internal module not bundled: ' + err.message);
      } else {
        fail('openAI-no-sdk', err.type + ': ' + err.message);
      }
    }

    // anthropic — SDK not installed → should throw BridgeError CONFIG
    try {
      anthropic({ apiKey: 'test-key', models: ['claude-sonnet-4-20250514'] });
      fail('anthropic-no-sdk', 'expected error but none thrown');
    } catch (err) {
      if (err.type === 'CONFIG' && err.message.includes('anthropic')) {
        ok('anthropic-no-sdk: BridgeError CONFIG');
      } else if (err.code === 'MODULE_NOT_FOUND') {
        fail('anthropic-no-sdk', 'MODULE_NOT_FOUND — internal module not bundled: ' + err.message);
      } else {
        fail('anthropic-no-sdk', err.type + ': ' + err.message);
      }
    }

    // gemini — SDK not installed → should throw BridgeError CONFIG
    try {
      gemini({ apiKey: 'test-key', models: ['gemini-2.0-flash'] });
      fail('gemini-no-sdk', 'expected error but none thrown');
    } catch (err) {
      if (err.type === 'CONFIG' && err.message.includes('generative-ai')) {
        ok('gemini-no-sdk: BridgeError CONFIG');
      } else if (err.code === 'MODULE_NOT_FOUND') {
        fail('gemini-no-sdk', 'MODULE_NOT_FOUND — internal module not bundled: ' + err.message);
      } else {
        fail('gemini-no-sdk', err.type + ': ' + err.message);
      }
    }

    // Zod validation — empty apiKey → BridgeError CONFIG
    try {
      openAI({ apiKey: '', models: ['gpt-4o'] });
      fail('openAI-empty-apiKey', 'expected error but none thrown');
    } catch (err) {
      if (err.type === 'CONFIG' && err.message.includes('apiKey')) {
        ok('openAI-empty-apiKey: BridgeError CONFIG (Zod)');
      } else {
        fail('openAI-empty-apiKey', err.type + ': ' + err.message);
      }
    }

    // Zod validation — empty models → BridgeError CONFIG
    try {
      anthropic({ apiKey: 'key', models: [] });
      fail('anthropic-empty-models', 'expected error but none thrown');
    } catch (err) {
      if (err.type === 'CONFIG' && err.message.includes('models')) {
        ok('anthropic-empty-models: BridgeError CONFIG (Zod)');
      } else {
        fail('anthropic-empty-models', err.type + ': ' + err.message);
      }
    }
    `);

    writeFileSync(join(tempDir, 'test-factories.mjs'), factoryTestScript);
    const factoryResults = JSON.parse(
      execSync('node test-factories.mjs', { cwd: tempDir, encoding: 'utf-8', timeout: 15_000 }),
    );

    for (const r of factoryResults) {
      check(r.pass, `factory: ${r.label}${r.pass ? '' : ` — ${r.error}`}`);
    }

    // ─── Phase D: defineProvider + createMultiProviderAgent ─────

    console.log('\n  [7] Phase D: defineProvider + createMultiProviderAgent from installed package...');

    const agentTestScript = consumerScript(`
    const { defineProvider, createMultiProviderAgent, McpAgenticServer, mergeRuntimeParams, mapParameters, ProviderRegistry } = await import('@stdiobus/mcp-agentic');
    const { z } = await import('zod');

    // 1. defineProvider — create a custom mock provider
    const mockFactory = defineProvider({
      id: 'mock-llm',
      kind: 'llm',
      displayName: 'Mock LLM',
      description: 'A mock provider for pack e2e testing',
      schema: z.object({
        token: z.string().min(1),
        models: z.array(z.string()).nonempty(),
      }),
      capabilities: { streaming: true, tools: false, vision: false, jsonMode: false },
      create: (opts) => ({
        id: 'mock-llm',
        models: opts.models,
        async complete(messages, params) {
          const last = messages[messages.length - 1];
          return { text: 'MOCK: ' + (last?.content ?? ''), stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } };
        },
      }),
    });

    // Verify factory metadata
    if (mockFactory.id === 'mock-llm') ok('defineProvider: factory.id');
    else fail('defineProvider: factory.id', mockFactory.id);

    if (mockFactory.kind === 'llm') ok('defineProvider: factory.kind');
    else fail('defineProvider: factory.kind', mockFactory.kind);

    if (mockFactory.displayName === 'Mock LLM') ok('defineProvider: factory.displayName');
    else fail('defineProvider: factory.displayName', mockFactory.displayName);

    // Call the factory
    const provider = mockFactory({ token: 'test-token', models: ['mock-v1', 'mock-v2'] });
    if (provider.id === 'mock-llm') ok('defineProvider: provider.id');
    else fail('defineProvider: provider.id', provider.id);

    if (provider.models.length === 2) ok('defineProvider: provider.models.length');
    else fail('defineProvider: provider.models.length', provider.models.length);

    // Test complete()
    const result = await provider.complete([{ role: 'user', content: 'hello' }], {});
    if (result.text === 'MOCK: hello') ok('defineProvider: provider.complete()');
    else fail('defineProvider: provider.complete()', result.text);

    // 2. createMultiProviderAgent — create agent with mock provider
    const agent = createMultiProviderAgent({
      id: 'pack-test-agent',
      providers: [provider],
      defaultProviderId: 'mock-llm',
      capabilities: ['test'],
      systemPrompt: 'You are a test agent.',
    });

    if (agent.id === 'pack-test-agent') ok('createMultiProviderAgent: agent.id');
    else fail('createMultiProviderAgent: agent.id', agent.id);

    // 3. McpAgenticServer — register agent and verify it works
    const server = new McpAgenticServer({ silent: true, agents: [agent] });

    // Access internal executor to test without starting stdio
    const inProcess = server['inProcess'] ?? server['inProcessExecutor'];
    if (inProcess) {
      await inProcess.start();
      const agents = await inProcess.discover();
      if (agents.length === 1 && agents[0].id === 'pack-test-agent') ok('McpAgenticServer: agent registered');
      else fail('McpAgenticServer: agent registered', JSON.stringify(agents));

      // Create session, prompt, close
      const session = await inProcess.createSession('pack-test-agent');
      if (session.sessionId) ok('McpAgenticServer: session created');
      else fail('McpAgenticServer: session created', 'no sessionId');

      const promptResult = await inProcess.prompt(session.sessionId, 'pack test input');
      if (promptResult.text.includes('MOCK')) ok('McpAgenticServer: prompt through agent works');
      else fail('McpAgenticServer: prompt through agent works', promptResult.text);

      await inProcess.closeSession(session.sessionId);
      ok('McpAgenticServer: session closed');

      await inProcess.close();
    } else {
      fail('McpAgenticServer: internal executor access', 'could not access inProcess executor');
    }

    // 4. mergeRuntimeParams — utility function works
    const merged = mergeRuntimeParams(
      { model: 'default-model', temperature: 0.5 },
      { temperature: 0.7 },
      { maxTokens: 100 },
    );
    if (merged.model === 'default-model' && merged.temperature === 0.7 && merged.maxTokens === 100) {
      ok('mergeRuntimeParams: three-level merge');
    } else {
      fail('mergeRuntimeParams: three-level merge', JSON.stringify(merged));
    }

    // 5. mapParameters — utility function works
    const mapped = mapParameters(
      [{ match: 'default', renames: { maxTokens: 'max_tokens', topP: 'top_p' } }],
      'any-model',
      { maxTokens: 100, topP: 0.9, temperature: 0.5 },
    );
    if (mapped.max_tokens === 100 && mapped.top_p === 0.9 && mapped.temperature === 0.5) {
      ok('mapParameters: rename + passthrough');
    } else {
      fail('mapParameters: rename + passthrough', JSON.stringify(mapped));
    }

    // 6. ProviderRegistry — works standalone
    const registry = new ProviderRegistry();
    registry.register(provider);
    const listed = registry.list();
    if (listed.length === 1 && listed[0].id === 'mock-llm') ok('ProviderRegistry: register + list');
    else fail('ProviderRegistry: register + list', JSON.stringify(listed));

    const retrieved = registry.get('mock-llm');
    if (retrieved.id === 'mock-llm') ok('ProviderRegistry: get');
    else fail('ProviderRegistry: get', retrieved?.id);

    // 7. Error validation — createMultiProviderAgent with empty providers
    try {
      createMultiProviderAgent({ id: 'bad', providers: [], defaultProviderId: 'x' });
      fail('createMultiProviderAgent-empty', 'expected error');
    } catch (err) {
      if (err.type === 'CONFIG') ok('createMultiProviderAgent: empty providers → CONFIG');
      else fail('createMultiProviderAgent: empty providers → CONFIG', err.type + ': ' + err.message);
    }

    // 8. Error validation — createMultiProviderAgent with bad default
    try {
      createMultiProviderAgent({ id: 'bad', providers: [provider], defaultProviderId: 'nonexistent' });
      fail('createMultiProviderAgent-bad-default', 'expected error');
    } catch (err) {
      if (err.type === 'CONFIG') ok('createMultiProviderAgent: bad default → CONFIG');
      else fail('createMultiProviderAgent: bad default → CONFIG', err.type + ': ' + err.message);
    }
    `);

    writeFileSync(join(tempDir, 'test-agent.mjs'), agentTestScript);
    const agentResults = JSON.parse(
      execSync('node test-agent.mjs', { cwd: tempDir, encoding: 'utf-8', timeout: 15_000 }),
    );

    for (const r of agentResults) {
      check(r.pass, `agent: ${r.label}${r.pass ? '' : ` — ${r.error}`}`);
    }

    // ─── Phase E: Type declarations exist ──────────────────────

    console.log('\n  [8] Phase E: Type declarations (.d.ts) exist...');

    const dtsPath = resolve(tempDir, 'node_modules', '@stdiobus', 'mcp-agentic', 'out', 'tsc', 'index.d.ts');
    check(existsSync(dtsPath), 'index.d.ts exists in installed package');

    // Verify key type declaration files
    const tscBase = resolve(tempDir, 'node_modules', '@stdiobus', 'mcp-agentic', 'out', 'tsc');
    const expectedDts = [
      'index.d.ts',
      'server/McpAgenticServer.d.ts',
      'agent/AgentHandler.d.ts',
      'agent/MultiProviderAgent.d.ts',
      'provider/AIProvider.d.ts',
      'provider/ProviderRegistry.d.ts',
      'provider/ParameterMapper.d.ts',
      'provider/defineProvider.d.ts',
      'provider/factories/openai.d.ts',
      'provider/factories/anthropic.d.ts',
      'provider/factories/gemini.d.ts',
      'provider/factories/createMultiProviderAgent.d.ts',
      'errors/BridgeError.d.ts',
    ];

    for (const dts of expectedDts) {
      const fullPath = resolve(tscBase, dts);
      check(existsSync(fullPath), `d.ts: ${dts}`);
    }

    // ─── Phase F: Bundle integrity — no broken internal requires ─

    console.log('\n  [9] Phase F: Bundle integrity — no broken internal requires...');

    const bundleCheckScript = consumerScript(`
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Read the actual bundle file
    const bundlePath = path.resolve('node_modules', '@stdiobus', 'mcp-agentic', 'out', 'dist', 'index.js');
    const content = fs.readFileSync(bundlePath, 'utf-8');

    // Check for broken relative requires to internal modules
    // These patterns indicate esbuild failed to bundle an internal module
    const brokenPatterns = [
      /require\\(['"]\\.\\.?\\/providers\\//,
      /require\\(['"]\\.\\.?\\/factories\\//,
      /require\\(['"]\\.\\.?\\/executor\\//,
      /require\\(['"]\\.\\.?\\/server\\//,
      /require\\(['"]\\.\\.?\\/agent\\//,
      /require\\(['"]\\.\\.?\\/errors\\//,
      /require\\(['"]\\.\\.?\\/observability\\//,
      /require\\(['"]\\.\\.?\\/mcp\\//,
    ];

    let foundBroken = false;
    for (const pattern of brokenPatterns) {
      if (pattern.test(content)) {
        fail('bundle-integrity: ' + pattern.source, 'found broken internal require in bundle');
        foundBroken = true;
      }
    }

    if (!foundBroken) {
      ok('bundle-integrity: no broken internal requires');
    }

    // Verify expected external requires ARE present (these are correct)
    const expectedExternals = ['@modelcontextprotocol/sdk', 'zod'];
    for (const ext of expectedExternals) {
      // In minified ESM, externals appear as import statements
      if (content.includes(ext)) {
        ok('bundle-externals: ' + ext + ' referenced');
      } else {
        fail('bundle-externals: ' + ext + ' referenced', 'not found in bundle');
      }
    }
    `);

    writeFileSync(join(tempDir, 'test-bundle.mjs'), bundleCheckScript);
    const bundleResults = JSON.parse(
      execSync('node test-bundle.mjs', { cwd: tempDir, encoding: 'utf-8', timeout: 15_000 }),
    );

    for (const r of bundleResults) {
      check(r.pass, `bundle: ${r.label}${r.pass ? '' : ` — ${r.error}`}`);
    }

    // Cleanup tarball
    rmSync(tarballPath, { force: true });

  } finally {
    // Cleanup temp dir
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('E2E failed:', err); process.exit(1); });
