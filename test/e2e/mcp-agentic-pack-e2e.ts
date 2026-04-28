/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: npm pack — verify published package works as MCP server
 *
 * Pipeline:
 *   1. npm pack → creates local tarball
 *   2. Install tarball in temp directory
 *   3. Run installed binary (mcp-agentic)
 *   4. Connect via StdioClientTransport
 *   5. Verify tools work
 *
 * This is the release gate — proves the published package works.
 *
 * Run with:
 *   tsx test/e2e/mcp-agentic-pack-e2e.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
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

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: npm pack — verify published package works as MCP server\n');

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
    execSync('npm init -y', { cwd: tempDir, stdio: 'pipe' });
    execSync(`npm install "${tarballPath}"`, { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

    // Verify binary exists
    const binPath = resolve(tempDir, 'node_modules', '.bin', 'mcp-agentic');
    const binExists = readdirSync(resolve(tempDir, 'node_modules', '.bin')).includes('mcp-agentic');
    check(binExists, `Binary installed at node_modules/.bin/mcp-agentic`);

    // Step 4: Start server from installed package
    console.log('\n  [4] Starting MCP server from installed package...');

    const transport = new StdioClientTransport({
      command: binPath,
      args: [],
      stderr: 'pipe',
    });

    // Capture stderr for debugging
    transport.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`  [server stderr] ${data.toString()}`);
    });

    const client = new Client({ name: 'pack-e2e-client', version: '1.0.0' });
    await client.connect(transport);
    console.log('  ✓ Connected to server via stdio\n');

    // Step 5: Verify tools
    console.log('  [5] Verifying MCP tools...');

    const tools = await client.listTools();
    check(tools.tools.length === 8, `8 tools listed (got ${tools.tools.length})`);

    const toolNames = tools.tools.map(t => t.name);
    check(toolNames.includes('bridge_health'), 'bridge_health present');
    check(toolNames.includes('sessions_create'), 'sessions_create present');
    check(toolNames.includes('tasks_delegate'), 'tasks_delegate present');

    // Health check
    const health = await client.callTool({ name: 'bridge_health', arguments: {} });
    const healthData = parseResult(health);
    check(healthData.healthy === false, `healthy=false (no agents registered — expected for bare server)`);
    check(healthData.agents.total === 0, `0 agents (bare server)`);

    await client.close();
    console.log('\n  ✓ Server closed cleanly');

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
