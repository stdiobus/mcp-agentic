/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Template / reference CLI entry point for MCP Agentic.
 *
 * This server starts with **zero agents registered** and is intended as a
 * diagnostic / reference implementation only. Tools like `bridge_health` and
 * `agents_discover` will respond (healthy: false / empty list), but any
 * `tasks_delegate` or `sessions_create` call will fail because there are no
 * agents to handle work.
 *
 * To actually delegate work to agents, create your own entry point that
 * calls `server.register(agent)` before `server.startStdio()`.
 * See README.md for examples.
 *
 * Usage (diagnostics only):
 *   node dist/cli/server.js
 */

import { McpAgenticServer } from '../index.js';

const server = new McpAgenticServer();

// Install signal handlers before startup so shutdown is always clean.
const shutdown = async () => {
  try {
    await server.close();
  } catch {
    // Best-effort shutdown — don't crash on cleanup errors.
  }
  process.exitCode = 0;
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await server.startStdio();

  // Warn on stderr that this reference server has no agents.
  // stdout is the MCP wire — never write non-protocol data there.
  process.stderr.write(
    '[mcp-agentic] Warning: No agents registered. ' +
    'This CLI is a reference server for diagnostics only. ' +
    'To delegate work, create a custom entry point with server.register(). ' +
    'See README.md for examples.\n',
  );
} catch (error) {
  process.stderr.write(
    `[mcp-agentic] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
