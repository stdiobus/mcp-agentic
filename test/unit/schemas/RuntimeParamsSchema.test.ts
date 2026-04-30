/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RuntimeParamsSchema and its integration with
 * SessionsPromptArgsSchema and TasksDelegateArgsSchema.
 *
 * Validates: Requirements 1.5, 6.2, 6.3
 */

import { describe, it, expect } from '@jest/globals';
import {
  RuntimeParamsSchema,
  SessionsPromptArgsSchema,
  TasksDelegateArgsSchema,
} from '../../../src/types.js';

// ── RuntimeParamsSchema ─────────────────────────────────────────

describe('RuntimeParamsSchema', () => {
  describe('valid inputs', () => {
    it('accepts an empty object', () => {
      const result = RuntimeParamsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts all fields with valid values', () => {
      const result = RuntimeParamsSchema.safeParse({
        model: 'gpt-4',
        temperature: 1.0,
        maxTokens: 2048,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END', 'STOP'],
        systemPrompt: 'You are a helpful assistant.',
        providerSpecific: { frequency_penalty: 0.5, logprobs: true },
      });
      expect(result.success).toBe(true);
    });

    it('accepts temperature at boundary 0', () => {
      const result = RuntimeParamsSchema.safeParse({ temperature: 0 });
      expect(result.success).toBe(true);
    });

    it('accepts temperature at boundary 2', () => {
      const result = RuntimeParamsSchema.safeParse({ temperature: 2 });
      expect(result.success).toBe(true);
    });

    it('accepts topP at boundary 0', () => {
      const result = RuntimeParamsSchema.safeParse({ topP: 0 });
      expect(result.success).toBe(true);
    });

    it('accepts topP at boundary 1', () => {
      const result = RuntimeParamsSchema.safeParse({ topP: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts maxTokens = 1 (minimum positive int)', () => {
      const result = RuntimeParamsSchema.safeParse({ maxTokens: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts topK = 1 (minimum positive int)', () => {
      const result = RuntimeParamsSchema.safeParse({ topK: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts empty stopSequences array', () => {
      const result = RuntimeParamsSchema.safeParse({ stopSequences: [] });
      expect(result.success).toBe(true);
    });

    it('accepts empty providerSpecific record', () => {
      const result = RuntimeParamsSchema.safeParse({ providerSpecific: {} });
      expect(result.success).toBe(true);
    });

    it('accepts only model field', () => {
      const result = RuntimeParamsSchema.safeParse({ model: 'claude-sonnet-4-20250514' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.model).toBe('claude-sonnet-4-20250514');
      }
    });
  });

  describe('invalid inputs', () => {
    it('rejects temperature below 0', () => {
      const result = RuntimeParamsSchema.safeParse({ temperature: -0.1 });
      expect(result.success).toBe(false);
    });

    it('rejects temperature above 2', () => {
      const result = RuntimeParamsSchema.safeParse({ temperature: 2.1 });
      expect(result.success).toBe(false);
    });

    it('rejects topP below 0', () => {
      const result = RuntimeParamsSchema.safeParse({ topP: -0.01 });
      expect(result.success).toBe(false);
    });

    it('rejects topP above 1', () => {
      const result = RuntimeParamsSchema.safeParse({ topP: 1.01 });
      expect(result.success).toBe(false);
    });

    it('rejects maxTokens = 0', () => {
      const result = RuntimeParamsSchema.safeParse({ maxTokens: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects negative maxTokens', () => {
      const result = RuntimeParamsSchema.safeParse({ maxTokens: -100 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer maxTokens', () => {
      const result = RuntimeParamsSchema.safeParse({ maxTokens: 1.5 });
      expect(result.success).toBe(false);
    });

    it('rejects topK = 0', () => {
      const result = RuntimeParamsSchema.safeParse({ topK: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects negative topK', () => {
      const result = RuntimeParamsSchema.safeParse({ topK: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer topK', () => {
      const result = RuntimeParamsSchema.safeParse({ topK: 3.7 });
      expect(result.success).toBe(false);
    });

    it('rejects unknown fields (strict mode)', () => {
      const result = RuntimeParamsSchema.safeParse({
        model: 'gpt-4',
        unknownField: 'should fail',
      });
      expect(result.success).toBe(false);
    });

    it('rejects multiple unknown fields (strict mode)', () => {
      const result = RuntimeParamsSchema.safeParse({
        foo: 'bar',
        baz: 123,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-string model', () => {
      const result = RuntimeParamsSchema.safeParse({ model: 123 });
      expect(result.success).toBe(false);
    });

    it('rejects non-array stopSequences', () => {
      const result = RuntimeParamsSchema.safeParse({ stopSequences: 'STOP' });
      expect(result.success).toBe(false);
    });

    it('rejects stopSequences with non-string elements', () => {
      const result = RuntimeParamsSchema.safeParse({ stopSequences: [1, 2, 3] });
      expect(result.success).toBe(false);
    });

    it('rejects non-string systemPrompt', () => {
      const result = RuntimeParamsSchema.safeParse({ systemPrompt: 42 });
      expect(result.success).toBe(false);
    });

    it('rejects non-object providerSpecific', () => {
      const result = RuntimeParamsSchema.safeParse({ providerSpecific: 'not-an-object' });
      expect(result.success).toBe(false);
    });
  });
});

// ── SessionsPromptArgsSchema with runtimeParams ─────────────────

describe('SessionsPromptArgsSchema with runtimeParams', () => {
  it('accepts valid prompt without runtimeParams', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      sessionId: 'sess-123',
      prompt: 'Hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid prompt with runtimeParams', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      sessionId: 'sess-123',
      prompt: 'Hello',
      runtimeParams: {
        model: 'gpt-4',
        temperature: 0.8,
        maxTokens: 1000,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimeParams).toEqual({
        model: 'gpt-4',
        temperature: 0.8,
        maxTokens: 1000,
      });
    }
  });

  it('accepts valid prompt with empty runtimeParams', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      sessionId: 'sess-123',
      prompt: 'Hello',
      runtimeParams: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid prompt with full runtimeParams', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      sessionId: 'sess-123',
      prompt: 'Hello',
      timeout: 30000,
      runtimeParams: {
        model: 'claude-sonnet-4-20250514',
        temperature: 1.5,
        maxTokens: 4096,
        topP: 0.95,
        topK: 50,
        stopSequences: ['END'],
        systemPrompt: 'Be concise.',
        providerSpecific: { stream: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects prompt with invalid runtimeParams (temperature out of range)', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      sessionId: 'sess-123',
      prompt: 'Hello',
      runtimeParams: { temperature: 3.0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects prompt with invalid runtimeParams (unknown field in strict schema)', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      sessionId: 'sess-123',
      prompt: 'Hello',
      runtimeParams: { unknownParam: 'value' },
    });
    expect(result.success).toBe(false);
  });

  it('still requires sessionId and prompt', () => {
    const result = SessionsPromptArgsSchema.safeParse({
      runtimeParams: { model: 'gpt-4' },
    });
    expect(result.success).toBe(false);
  });
});

// ── TasksDelegateArgsSchema with runtimeParams ──────────────────

describe('TasksDelegateArgsSchema with runtimeParams', () => {
  it('accepts valid delegation without runtimeParams', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      prompt: 'Summarize this document',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid delegation with runtimeParams', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      prompt: 'Summarize this document',
      agentId: 'summarizer',
      runtimeParams: {
        model: 'gpt-4-turbo',
        temperature: 0.3,
        maxTokens: 500,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimeParams).toEqual({
        model: 'gpt-4-turbo',
        temperature: 0.3,
        maxTokens: 500,
      });
    }
  });

  it('accepts valid delegation with empty runtimeParams', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      prompt: 'Do something',
      runtimeParams: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid delegation with all fields', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      prompt: 'Analyze code',
      agentId: 'code-reviewer',
      timeout: 60000,
      metadata: { source: 'pr-review' },
      runtimeParams: {
        model: 'claude-sonnet-4-20250514',
        temperature: 0.2,
        maxTokens: 8192,
        topP: 0.9,
        topK: 20,
        stopSequences: ['---'],
        systemPrompt: 'You are a code reviewer.',
        providerSpecific: { extended_thinking: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects delegation with invalid runtimeParams (negative maxTokens)', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      prompt: 'Do something',
      runtimeParams: { maxTokens: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects delegation with invalid runtimeParams (unknown field in strict schema)', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      prompt: 'Do something',
      runtimeParams: { badField: true },
    });
    expect(result.success).toBe(false);
  });

  it('still requires prompt', () => {
    const result = TasksDelegateArgsSchema.safeParse({
      agentId: 'agent-1',
      runtimeParams: { model: 'gpt-4' },
    });
    expect(result.success).toBe(false);
  });
});
