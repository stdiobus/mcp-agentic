/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Agentic — OpenAI Agent Server
 *
 * Real MCP server with an agent that calls OpenAI API directly.
 * No templates, no mocks — real LLM responses.
 *
 * Requires: OPENAI_API_KEY environment variable
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... tsx scripts/run-openai-agent-server.ts
 *
 * MCP config:
 *   {
 *     "command": "npx",
 *     "args": ["tsx", "mcp-agentic/scripts/run-openai-agent-server.ts"],
 *     "env": { "OPENAI_API_KEY": "sk-..." }
 *   }
 */

import { McpAgenticServer } from '../src/index.js';
import type { AgentHandler, AgentResult } from '../src/index.js';

// ─── OpenAI HTTP Client (minimal, no SDK dependency) ─────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function callOpenAI(
  messages: ChatMessage[],
  apiKey: string,
  model = 'gpt-4o-mini',
): Promise<OpenAIResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<OpenAIResponse>;
}

// ─── OpenAI Agent ────────────────────────────────────────────────

class OpenAIAgent implements AgentHandler {
  readonly id = 'openai-agent';
  readonly capabilities = ['code-review', 'architecture', 'debugging', 'conversation', 'analysis'];

  private apiKey: string;
  private model: string;
  private sessions = new Map<string, {
    messages: ChatMessage[];
    metadata?: Record<string, unknown>;
  }>();

  constructor(apiKey: string, model = 'gpt-4o-mini') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async onSessionCreate(sessionId: string, metadata?: Record<string, unknown>): Promise<void> {
    this.sessions.set(sessionId, {
      messages: [
        {
          role: 'system',
          content: 'You are a senior software engineer companion. You help with code review, architecture decisions, debugging, and general development questions. Be concise and practical.',
        },
      ],
      metadata,
    });
  }

  async onSessionClose(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        text: 'Error: session not initialized. Call onSessionCreate first.',
        stopReason: 'end_turn',
      };
    }

    session.messages.push({ role: 'user', content: input });

    const response = await callOpenAI(session.messages, this.apiKey, this.model);

    const assistantMessage = response.choices[0]?.message.content ?? 'No response';
    const finishReason = response.choices[0]?.finish_reason ?? 'stop';

    session.messages.push({ role: 'assistant', content: assistantMessage });

    return {
      text: assistantMessage,
      stopReason: finishReason === 'stop' ? 'end_turn' : finishReason,
      usage: response.usage
        ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        }
        : undefined,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    // OpenAI doesn't support request cancellation — best effort
    void sessionId;
  }
}

// ─── Start Server ────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadApiKey(): string {
  // 1. Try environment variable first
  const envKey = process.env['OPENAI_API_KEY'];
  if (envKey && envKey !== '${OPENAI_API_KEY}') return envKey;

  // 2. Try api-keys.json from project root
  try {
    const keysPath = resolve(__dirname, '..', '..', '..', 'api-keys.json');
    const keys = JSON.parse(readFileSync(keysPath, 'utf-8'));
    const key = keys?.agents?.['codex-acp']?.apiKey;
    if (key && key.length > 0) return key;
  } catch { /* file not found or parse error */ }

  process.stderr.write('[openai-agent-server] Error: OPENAI_API_KEY not set and api-keys.json not found\n');
  process.exit(1);
}

const apiKey = loadApiKey();

const model = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';

const server = new McpAgenticServer({ defaultAgentId: 'openai-agent' })
  .register(new OpenAIAgent(apiKey, model));

const shutdown = async (): Promise<void> => {
  try { await server.close(); } catch { /* best-effort */ }
  process.exitCode = 0;
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await server.startStdio();
  process.stderr.write(`[openai-agent-server] Started on stdio (model: ${model})\n`);
} catch (error) {
  process.stderr.write(`[openai-agent-server] Failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
