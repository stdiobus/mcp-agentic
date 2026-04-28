/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * README Quick Start — EXACT copy of the code from README.md
 *
 * This file must be identical to the Quick Start snippet in README.md.
 * If this file doesn't compile or run, the README is lying.
 *
 * DO NOT modify this file without updating README.md to match.
 */

import { McpAgenticServer } from '../../../src/index.js';

const server = new McpAgenticServer({ defaultAgentId: 'my-agent' })
  .register({
    id: 'my-agent',
    capabilities: ['code-analysis'],
    async prompt(sessionId, input) {
      return { text: `Analyzed: ${input}`, stopReason: 'end_turn' };
    },
  });

await server.startStdio();
