/**
 * @stdiobus/mcp-agentic — esbuild build configuration
 *
 * Two bundled outputs:
 *   src/index.ts     → out/dist/index.js     (library)
 *   src/cli/server.ts → out/dist/cli/server.js (CLI binary with shebang)
 *
 * All internal modules bundled. External deps resolved at runtime.
 * tsc handles .d.ts separately via tsconfig.types.json.
 */

import { build } from 'esbuild';
import { builtinModules } from 'node:module';

// ─── Externals ──────────────────────────────────────────────────

const nodeBuiltins = builtinModules.flatMap(m => [m, `node:${m}`]);

const runtimeExternals = [
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/server/index.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  '@modelcontextprotocol/sdk/types.js',
  '@stdiobus/node',
  'zod',
];

const external = [...nodeBuiltins, ...runtimeExternals];

// ─── Shared config ──────────────────────────────────────────────

const shared = {
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'esm',
  treeShaking: true,
  minify: true,
  sourcemap: false,
  external,
  loader: { '.json': 'json' },
  logLevel: 'info',
};

// ─── Build targets ──────────────────────────────────────────────

const targets = [
  {
    label: 'Library (ESM)',
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'out/dist/index.js',
  },
  {
    label: 'CLI Binary',
    ...shared,
    entryPoints: ['src/cli/server.ts'],
    outfile: 'out/dist/cli/server.js',
    banner: { js: '#!/usr/bin/env node' },
  },
];

// ─── Runner ─────────────────────────────────────────────────────

for (const { label, ...buildConfig } of targets) {
  const startMs = Date.now();
  await build(buildConfig);
  const elapsed = Date.now() - startMs;
  console.log(`  ✓ ${label} → ${buildConfig.outfile} (${elapsed}ms)`);
}

console.log('\nesbuild: build complete');
