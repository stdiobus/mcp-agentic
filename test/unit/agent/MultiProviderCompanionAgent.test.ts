/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based and unit tests for MultiProviderCompanionAgent.
 *
 * Tests cover:
 * - Property 13: Provider selection (default vs session-level override)
 * - Property 14: Conversation history invariant (1 system + 2×N messages)
 * - Property 18: Unregistered provider rejection (CONFIG error)
 *
 * Validates: Requirements 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { MultiProviderCompanionAgent } from '../../../src/agent/MultiProviderCompanionAgent.js';
import { ProviderRegistry } from '../../../src/provider/ProviderRegistry.js';
import { BridgeError } from '../../../src/errors/BridgeError.js';
import type { AIProvider, AIProviderResult, ChatMessage, RuntimeParams } from '../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a mock AIProvider that tracks calls and returns configurable results. */
function createMockProvider(
  id: string,
  models: string[] = ['model-1'],
  result?: Partial<AIProviderResult>,
): AIProvider & { complete: jest.Mock<any> } {
  const defaultResult: AIProviderResult = {
    text: `response from ${id}`,
    stopReason: 'end_turn',
    ...result,
  };
  return {
    id,
    models: Object.freeze(models),
    complete: jest.fn<any>().mockResolvedValue(defaultResult),
  };
}

/** Create a registry with the given providers. */
function createRegistry(...providers: AIProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) {
    registry.register(provider);
  }
  return registry;
}

/** Create an agent with a registry containing the given providers. */
function createAgent(
  providers: AIProvider[],
  defaultProviderId: string,
  options?: { systemPrompt?: string; defaults?: RuntimeParams },
): MultiProviderCompanionAgent {
  const registry = createRegistry(...providers);
  return new MultiProviderCompanionAgent({
    id: 'test-agent',
    defaultProviderId,
    registry,
    systemPrompt: options?.systemPrompt,
    defaults: options?.defaults,
  });
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Arbitrary for valid provider IDs. */
const arbProviderId = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

/** Arbitrary for unique provider ID pairs (default + override). */
const arbProviderIdPair = fc.tuple(arbProviderId, arbProviderId).filter(
  ([a, b]) => a !== b,
);

/** Arbitrary for user prompt strings. */
const arbPrompt = fc.string({ minLength: 1, maxLength: 100 });

/** Arbitrary for session IDs. */
const arbSessionId = fc.stringMatching(/^[a-z0-9-]{1,20}$/);

// ── Property 13: Provider selection ─────────────────────────────

describe('MultiProviderCompanionAgent', () => {
  describe('Property 13: Provider selection', () => {
    // Feature: multi-provider-agents, Property 13: Provider selection
    it('property: uses default provider when no override is specified in session metadata', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderId,
          arbSessionId,
          arbPrompt,
          async (providerId, sessionId, input) => {
            const provider = createMockProvider(providerId);
            const agent = createAgent([provider], providerId);

            await agent.onSessionCreate(sessionId);
            await agent.prompt(sessionId, input);

            // Default provider should have been called
            expect(provider.complete).toHaveBeenCalledTimes(1);
            const [messages] = provider.complete.mock.calls[0]!;
            // Last message should be the user input
            const lastMsg = messages[messages.length - 1] as ChatMessage;
            return lastMsg.role === 'user' && lastMsg.content === input;
          },
        ),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 13: Provider selection
    it('property: uses session-level provider when metadata.provider is specified', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderIdPair,
          arbSessionId,
          arbPrompt,
          async ([defaultId, overrideId], sessionId, input) => {
            const defaultProvider = createMockProvider(defaultId);
            const overrideProvider = createMockProvider(overrideId);
            const registry = createRegistry(defaultProvider, overrideProvider);

            const agent = new MultiProviderCompanionAgent({
              id: 'test-agent',
              defaultProviderId: defaultId,
              registry,
            });

            await agent.onSessionCreate(sessionId, { provider: overrideId });
            await agent.prompt(sessionId, input);

            // Override provider should be called, not the default
            expect(overrideProvider.complete).toHaveBeenCalledTimes(1);
            expect(defaultProvider.complete).not.toHaveBeenCalled();
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should use default provider for session without metadata', async () => {
      const openai = createMockProvider('openai');
      const anthropic = createMockProvider('anthropic');
      const agent = createAgent([openai, anthropic], 'openai');

      await agent.onSessionCreate('s1');
      await agent.prompt('s1', 'hello');

      expect(openai.complete).toHaveBeenCalledTimes(1);
      expect(anthropic.complete).not.toHaveBeenCalled();
    });

    it('should use session-level provider override for all prompts in session', async () => {
      const openai = createMockProvider('openai');
      const anthropic = createMockProvider('anthropic');
      const agent = createAgent([openai, anthropic], 'openai');

      await agent.onSessionCreate('s1', { provider: 'anthropic' });
      await agent.prompt('s1', 'first');
      await agent.prompt('s1', 'second');

      expect(anthropic.complete).toHaveBeenCalledTimes(2);
      expect(openai.complete).not.toHaveBeenCalled();
    });
  });

  // ── Property 14: Conversation history invariant ─────────────────

  describe('Property 14: Conversation history invariant', () => {
    // Feature: multi-provider-agents, Property 14: Conversation history invariant
    it('property: after N prompts, messages passed to provider contain system + history + current (1 + 2*(N-1) + 1 messages)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderId,
          arbSessionId,
          fc.array(arbPrompt, { minLength: 1, maxLength: 10 }),
          async (providerId, sessionId, prompts) => {
            const provider = createMockProvider(providerId);
            const agent = createAgent([provider], providerId, {
              systemPrompt: 'You are helpful.',
            });

            await agent.onSessionCreate(sessionId);

            for (let i = 0; i < prompts.length; i++) {
              await agent.prompt(sessionId, prompts[i]!);

              // After the i-th prompt (0-indexed), the provider should receive:
              // 1 system message + 2*i history messages + 1 current user message
              const call = provider.complete.mock.calls[i]!;
              const messages = call[0] as ChatMessage[];
              const expectedLength = 1 + 2 * i + 1; // system + history + current

              if (messages.length !== expectedLength) return false;

              // First message is always system
              if (messages[0]!.role !== 'system') return false;

              // Last message is always the current user input
              const lastMsg = messages[messages.length - 1]!;
              if (lastMsg.role !== 'user' || lastMsg.content !== prompts[i]) return false;

              // History alternates user/assistant
              for (let j = 1; j < messages.length - 1; j++) {
                const expectedRole = j % 2 === 1 ? 'user' : 'assistant';
                if (messages[j]!.role !== expectedRole) return false;
              }
            }

            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 14: Conversation history invariant
    it('property: without system prompt, after N prompts messages contain 2*(N-1) + 1 messages', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderId,
          arbSessionId,
          fc.array(arbPrompt, { minLength: 1, maxLength: 10 }),
          async (providerId, sessionId, prompts) => {
            const provider = createMockProvider(providerId);
            const agent = createAgent([provider], providerId);

            await agent.onSessionCreate(sessionId);

            for (let i = 0; i < prompts.length; i++) {
              await agent.prompt(sessionId, prompts[i]!);

              const call = provider.complete.mock.calls[i]!;
              const messages = call[0] as ChatMessage[];
              // No system message: 2*i history messages + 1 current user message
              const expectedLength = 2 * i + 1;

              if (messages.length !== expectedLength) return false;

              // Last message is always the current user input
              const lastMsg = messages[messages.length - 1]!;
              if (lastMsg.role !== 'user' || lastMsg.content !== prompts[i]) return false;
            }

            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should maintain correct history across multiple prompts', async () => {
      const provider = createMockProvider('openai', ['gpt-4'], { text: 'reply' });
      const agent = createAgent([provider], 'openai', { systemPrompt: 'Be helpful.' });

      await agent.onSessionCreate('s1');

      await agent.prompt('s1', 'hello');
      expect(provider.complete).toHaveBeenCalledTimes(1);
      const firstCall = provider.complete.mock.calls[0]![0] as ChatMessage[];
      expect(firstCall).toHaveLength(2); // system + user
      expect(firstCall[0]).toEqual({ role: 'system', content: 'Be helpful.' });
      expect(firstCall[1]).toEqual({ role: 'user', content: 'hello' });

      await agent.prompt('s1', 'world');
      const secondCall = provider.complete.mock.calls[1]![0] as ChatMessage[];
      expect(secondCall).toHaveLength(4); // system + user + assistant + user
      expect(secondCall[0]).toEqual({ role: 'system', content: 'Be helpful.' });
      expect(secondCall[1]).toEqual({ role: 'user', content: 'hello' });
      expect(secondCall[2]).toEqual({ role: 'assistant', content: 'reply' });
      expect(secondCall[3]).toEqual({ role: 'user', content: 'world' });
    });
  });

  // ── Property 18: Unregistered provider rejection ────────────────

  describe('Property 18: Unregistered provider rejection', () => {
    // Feature: multi-provider-agents, Property 18: Unregistered provider rejection
    it('property: onSessionCreate with unregistered provider throws CONFIG BridgeError', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderIdPair,
          arbSessionId,
          async ([registeredId, unregisteredId], sessionId) => {
            const provider = createMockProvider(registeredId);
            const agent = createAgent([provider], registeredId);

            try {
              await agent.onSessionCreate(sessionId, { provider: unregisteredId });
              return false; // Should have thrown
            } catch (err) {
              return (
                err instanceof BridgeError &&
                err.type === 'CONFIG' &&
                err.message.includes(unregisteredId)
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 18: Unregistered provider rejection
    it('property: constructing agent with unregistered default provider throws CONFIG BridgeError', () => {
      fc.assert(
        fc.property(
          arbProviderIdPair,
          ([registeredId, unregisteredDefaultId]) => {
            const provider = createMockProvider(registeredId);
            const registry = createRegistry(provider);

            try {
              new MultiProviderCompanionAgent({
                id: 'test-agent',
                defaultProviderId: unregisteredDefaultId,
                registry,
              });
              return false; // Should have thrown
            } catch (err) {
              return (
                err instanceof BridgeError &&
                err.type === 'CONFIG' &&
                err.message.includes(unregisteredDefaultId)
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should throw CONFIG BridgeError when session metadata specifies unregistered provider', async () => {
      const openai = createMockProvider('openai');
      const agent = createAgent([openai], 'openai');

      await expect(
        agent.onSessionCreate('s1', { provider: 'nonexistent' }),
      ).rejects.toThrow(BridgeError);

      try {
        await agent.onSessionCreate('s2', { provider: 'nonexistent' });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('nonexistent');
      }
    });

    it('should throw CONFIG BridgeError when constructing with unregistered default provider', () => {
      const openai = createMockProvider('openai');
      const registry = createRegistry(openai);

      expect(() => new MultiProviderCompanionAgent({
        id: 'test-agent',
        defaultProviderId: 'nonexistent',
        registry,
      })).toThrow(BridgeError);

      try {
        new MultiProviderCompanionAgent({
          id: 'test-agent',
          defaultProviderId: 'nonexistent',
          registry,
        });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('nonexistent');
      }
    });
  });

  // ── Additional unit tests ───────────────────────────────────────

  describe('setPromptRuntimeParams', () => {
    it('should apply prompt-level params to the next prompt call', async () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai', {
        defaults: { temperature: 0.5 },
      });

      await agent.onSessionCreate('s1');
      agent.setPromptRuntimeParams('s1', { temperature: 0.9, model: 'gpt-4' });
      await agent.prompt('s1', 'hello');

      const [, params] = provider.complete.mock.calls[0]!;
      expect((params as RuntimeParams).temperature).toBe(0.9);
      expect((params as RuntimeParams).model).toBe('gpt-4');
    });

    it('should clear prompt-level params after consumption', async () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai', {
        defaults: { temperature: 0.5 },
      });

      await agent.onSessionCreate('s1');
      agent.setPromptRuntimeParams('s1', { temperature: 0.9 });
      await agent.prompt('s1', 'first');
      await agent.prompt('s1', 'second');

      // Second call should use config defaults, not prompt params
      const [, secondParams] = provider.complete.mock.calls[1]!;
      expect((secondParams as RuntimeParams).temperature).toBe(0.5);
    });

    it('should throw CONFIG BridgeError for non-existent session', () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai');

      expect(() => agent.setPromptRuntimeParams('nonexistent', { temperature: 0.5 }))
        .toThrow(BridgeError);
    });
  });

  describe('getProviderRegistry', () => {
    it('should return the registry instance', () => {
      const provider = createMockProvider('openai');
      const registry = createRegistry(provider);
      const agent = new MultiProviderCompanionAgent({
        id: 'test-agent',
        defaultProviderId: 'openai',
        registry,
      });

      expect(agent.getProviderRegistry()).toBe(registry);
    });
  });

  describe('onSessionClose', () => {
    it('should clean up session state', async () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai');

      await agent.onSessionCreate('s1');
      await agent.onSessionClose('s1');

      // Prompt should fail after session is closed
      await expect(agent.prompt('s1', 'hello')).rejects.toThrow(BridgeError);
    });

    it('should not throw for non-existent session', async () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai');

      // Should not throw
      await agent.onSessionClose('nonexistent');
    });
  });

  describe('prompt with non-existent session', () => {
    it('should throw CONFIG BridgeError', async () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai');

      await expect(agent.prompt('nonexistent', 'hello')).rejects.toThrow(BridgeError);

      try {
        await agent.prompt('nonexistent', 'hello');
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('nonexistent');
      }
    });
  });

  describe('RuntimeParams merge priority', () => {
    it('should merge config < session < prompt params correctly', async () => {
      const provider = createMockProvider('openai');
      const agent = createAgent([provider], 'openai', {
        defaults: { temperature: 0.3, maxTokens: 100, model: 'gpt-3.5-turbo' },
      });

      await agent.onSessionCreate('s1', {
        runtimeParams: { temperature: 0.7, model: 'gpt-4' },
      });
      agent.setPromptRuntimeParams('s1', { temperature: 1.0 });
      await agent.prompt('s1', 'hello');

      const [, params] = provider.complete.mock.calls[0]!;
      const rp = params as RuntimeParams;
      // prompt-level temperature wins
      expect(rp.temperature).toBe(1.0);
      // session-level model wins over config
      expect(rp.model).toBe('gpt-4');
      // config-level maxTokens is preserved
      expect(rp.maxTokens).toBe(100);
    });
  });
});
