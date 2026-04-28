/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Developer Sandbox: Multi-Agent MCP Power Setup
 *
 * This example demonstrates how a developer would set up a local
 * multi-agent system using McpAgenticServer.
 *
 * Run with:
 *   node --loader ts-node/esm examples/sandbox-multi-agent.ts
 *
 * Scenarios covered:
 * - Multiple agents with different capabilities
 * - Agent routing by capability discovery
 * - Multi-turn conversation with context
 * - tasks_delegate fire-and-forget pattern
 * - Session lifecycle management
 * - Error handling
 */

import { McpAgenticServer } from '../src/index.js';
import type { AgentHandler, AgentResult } from '../src/index.js';

// ─── Step 1: Implement your agents ──────────────────────────────

/**
 * Code review agent — analyzes code snippets.
 * In production, this would call an LLM API.
 */
const codeReviewAgent: AgentHandler = {
  id: 'code-reviewer',
  capabilities: ['code-review', 'analysis'],

  async prompt(_sessionId: string, input: string): Promise<AgentResult> {
    // Simulate code review
    const lines = input.split('\n').length;
    const hasFunction = input.includes('function') || input.includes('=>');
    const hasTypes = input.includes(':') && (input.includes('string') || input.includes('number'));

    const feedback = [
      `Reviewed ${lines} lines of code.`,
      hasFunction ? '✓ Contains function definitions.' : '⚠ No functions found.',
      hasTypes ? '✓ TypeScript types detected.' : '⚠ Consider adding type annotations.',
    ];

    return {
      text: feedback.join('\n'),
      stopReason: 'end_turn',
      usage: { inputTokens: input.length, outputTokens: feedback.join('\n').length },
    };
  },
};

/**
 * Documentation agent — generates docs from code.
 */
const docsAgent: AgentHandler = {
  id: 'docs-writer',
  capabilities: ['documentation', 'writing'],

  async prompt(_sessionId: string, input: string): Promise<AgentResult> {
    return {
      text: `## Documentation\n\nGenerated documentation for:\n\`\`\`\n${input.slice(0, 100)}...\n\`\`\`\n\nThis module provides functionality as described above.`,
      stopReason: 'end_turn',
    };
  },
};

/**
 * Chat agent — general conversation with memory.
 */
class ChatAgent implements AgentHandler {
  readonly id = 'chat-assistant';
  readonly capabilities = ['chat', 'conversation'];
  private history = new Map<string, string[]>();

  async onSessionCreate(sessionId: string): Promise<void> {
    this.history.set(sessionId, []);
    console.log(`  [chat] Session ${sessionId.slice(0, 8)}... created`);
  }

  async onSessionClose(sessionId: string): Promise<void> {
    const turns = this.history.get(sessionId)?.length ?? 0;
    this.history.delete(sessionId);
    console.log(`  [chat] Session ${sessionId.slice(0, 8)}... closed after ${turns} turns`);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const hist = this.history.get(sessionId) ?? [];
    hist.push(input);
    this.history.set(sessionId, hist);

    const response = hist.length === 1
      ? `Hello! You said: "${input}". How can I help?`
      : `Got it (turn ${hist.length}). You previously said: "${hist[hist.length - 2]}". Now: "${input}".`;

    return { text: response, stopReason: 'end_turn' };
  }
}

// ─── Step 2: Create and configure server ─────────────────────────

async function main(): Promise<void> {
  console.log('Developer Sandbox: Multi-Agent McpAgenticServer\n');

  const server = new McpAgenticServer()
    .register(codeReviewAgent)
    .register(docsAgent)
    .register(new ChatAgent());

  // Note: In a real setup, you'd call server.startStdio() to serve MCP.
  // For this sandbox, we test the executor directly.

  // Access the internal executor for demonstration
  // (In production, MCP clients would call tools through the protocol)
  const executor = (server as any).inProcess as import('../src/executor/InProcessExecutor.js').InProcessExecutor;
  await executor.start();

  try {
    // ─── Scenario 1: Discover agents by capability ─────────────
    console.log('  [Scenario 1] Agent discovery');

    const allAgents = await executor.discover();
    console.log(`  Found ${allAgents.length} agents: ${allAgents.map(a => a.id).join(', ')}`);

    const codeAgents = await executor.discover('code-review');
    console.log(`  Code review agents: ${codeAgents.map(a => a.id).join(', ')}`);

    const chatAgents = await executor.discover('chat');
    console.log(`  Chat agents: ${chatAgents.map(a => a.id).join(', ')}`);

    // ─── Scenario 2: Code review delegation ────────────────────
    console.log('\n  [Scenario 2] Code review — tasks_delegate pattern');

    const session1 = await executor.createSession('code-reviewer');
    const review = await executor.prompt(session1.sessionId, 'function add(a: number, b: number): number {\n  return a + b;\n}');
    console.log(`  Review result:\n    ${review.text.split('\n').join('\n    ')}`);
    await executor.closeSession(session1.sessionId, 'review-complete');

    // ─── Scenario 3: Multi-turn chat ───────────────────────────
    console.log('\n  [Scenario 3] Multi-turn chat conversation');

    const chatSession = await executor.createSession('chat-assistant');
    const sid = chatSession.sessionId;

    const r1 = await executor.prompt(sid, 'Hi, I need help with TypeScript');
    console.log(`  Turn 1: ${r1.text}`);

    const r2 = await executor.prompt(sid, 'How do I define an interface?');
    console.log(`  Turn 2: ${r2.text}`);

    const r3 = await executor.prompt(sid, 'Thanks, that helps!');
    console.log(`  Turn 3: ${r3.text}`);

    await executor.closeSession(sid, 'conversation-done');

    // ─── Scenario 4: Error handling ────────────────────────────
    console.log('\n  [Scenario 4] Error handling');

    try {
      await executor.createSession('nonexistent-agent');
      console.log('  ✗ Should have thrown');
    } catch (err: any) {
      console.log(`  ✓ Correctly rejected unknown agent: ${err.message}`);
    }

    // ─── Scenario 5: Health check ──────────────────────────────
    console.log('\n  [Scenario 5] Health check');

    const health = await executor.health();
    console.log(`  Healthy: ${health.healthy}`);
    console.log(`  Agents: ${health.agents.total} total, ${health.agents.ready} ready`);
    console.log(`  Sessions: ${health.sessions.active} active / ${health.sessions.capacity} capacity`);

    console.log('\n  All scenarios completed successfully.');
  } finally {
    await executor.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
