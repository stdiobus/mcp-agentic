/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Agentic — codex-acp agent server
 *
 * Real MCP server with a codex-acp companion agent.
 * Communicates via stdio (stdin/stdout) using MCP JSON-RPC protocol.
 *
 * Usage:
 *   tsx scripts/run-codex-acp-server.ts
 *
 * Or via MCP config:
 *   { "command": "npx", "args": ["tsx", "scripts/run-codex-acp-server.ts"] }
 */

import { McpAgenticServer } from '../src/index.js';
import type { AgentHandler, AgentResult } from '../src/index.js';

// ─── codex-acp Agent ─────────────────────────────────────────────

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

class CodexAcpAgent implements AgentHandler {
  readonly id = 'codex-acp';
  readonly capabilities = ['code-review', 'architecture', 'debugging', 'conversation'];

  private sessions = new Map<string, {
    history: ConversationTurn[];
    metadata?: Record<string, unknown>;
  }>();

  async onSessionCreate(sessionId: string, metadata?: Record<string, unknown>): Promise<void> {
    this.sessions.set(sessionId, { history: [], metadata });
  }

  async onSessionClose(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        text: 'Error: session not found. Create a session first.',
        stopReason: 'end_turn',
      };
    }

    session.history.push({ role: 'user', content: input });

    const response = this.generateResponse(input, session.history);

    session.history.push({ role: 'assistant', content: response });

    return {
      text: response,
      stopReason: 'end_turn',
      requestId: `codex-${sessionId}-${session.history.length}`,
      usage: {
        inputTokens: input.length,
        outputTokens: response.length,
      },
    };
  }

  async cancel(sessionId: string): Promise<void> {
    // Best-effort cancel — nothing to abort in deterministic mode
    void sessionId;
  }

  private generateResponse(input: string, history: ConversationTurn[]): string {
    const lower = input.toLowerCase();
    const turnCount = Math.floor(history.length / 2);

    // Context-aware responses based on conversation history
    if (turnCount > 1) {
      const previousUserMessage = history[history.length - 3]?.content ?? '';
      return `[codex-acp turn ${turnCount}] Continuing from your previous point about "${previousUserMessage.slice(0, 50)}...".\n\nRegarding "${input.slice(0, 100)}": I can help with that. What specific aspect would you like to explore?`;
    }

    // Topic-based routing
    if (lower.includes('review') || lower.includes('code')) {
      return `[codex-acp] Code review analysis:\n\nI'll review the code you've shared. Key observations:\n1. Structure looks reasonable\n2. Consider adding error handling for edge cases\n3. Type annotations could be more specific\n\nWould you like me to focus on any particular aspect?`;
    }

    if (lower.includes('architect') || lower.includes('design') || lower.includes('pattern')) {
      return `[codex-acp] Architecture discussion:\n\nBased on your description, I'd recommend:\n1. Separate concerns into distinct modules\n2. Use dependency injection for testability\n3. Define clear interfaces between layers\n\nWhat constraints are you working with?`;
    }

    if (lower.includes('debug') || lower.includes('error') || lower.includes('fix') || lower.includes('bug')) {
      return `[codex-acp] Debugging assistance:\n\nTo help debug this issue:\n1. What's the expected behavior vs actual behavior?\n2. Can you reproduce it consistently?\n3. What have you already tried?\n\nShare the error output and I'll analyze it.`;
    }

    if (lower.includes('help') || lower.includes('what can')) {
      return `[codex-acp] I'm a code companion agent. I can help with:\n- Code review and analysis\n- Architecture and design discussions\n- Debugging assistance\n- General development questions\n\nJust describe what you need!`;
    }

    // Default conversational response
    return `[codex-acp] Understood: "${input.slice(0, 80)}${input.length > 80 ? '...' : ''}"\n\nI'm ready to help. Could you provide more context about what you're working on?`;
  }
}

// ─── Start Server ────────────────────────────────────────────────

const server = new McpAgenticServer({ defaultAgentId: 'codex-acp' })
  .register(new CodexAcpAgent());

const shutdown = async (): Promise<void> => {
  try { await server.close(); } catch { /* best-effort */ }
  process.exitCode = 0;
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await server.startStdio();
  process.stderr.write('[codex-acp-server] Started on stdio\n');
} catch (error) {
  process.stderr.write(`[codex-acp-server] Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
