import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fc from 'fast-check';
import { InProcessExecutor, type InProcessExecutorConfig } from '../../../src/executor/InProcessExecutor.js';
import type { AgentHandler, AgentResult } from '../../../src/agent/AgentHandler.js';
import { BridgeError } from '../../../src/errors/BridgeError.js';

/** Helper to create an InProcessExecutor with silent: true to suppress stderr noise in tests. */
function createSilentExecutor(config?: Omit<InProcessExecutorConfig, 'silent'>): InProcessExecutor {
  return new InProcessExecutor({ ...config, silent: true });
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Create a minimal AgentHandler with configurable hooks and prompt behavior. */
function createMockAgent(
  id: string,
  capabilities: string[] = [],
  overrides: {
    prompt?: AgentHandler['prompt'];
    onSessionCreate?: AgentHandler['onSessionCreate'];
    onSessionClose?: AgentHandler['onSessionClose'];
    cancel?: AgentHandler['cancel'];
  } = {},
): AgentHandler {
  return {
    id,
    capabilities,
    prompt: overrides.prompt ?? jest.fn().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    ...(overrides.onSessionCreate !== undefined ? { onSessionCreate: overrides.onSessionCreate } : {}),
    ...(overrides.onSessionClose !== undefined ? { onSessionClose: overrides.onSessionClose } : {}),
    ...(overrides.cancel !== undefined ? { cancel: overrides.cancel } : {}),
  };
}

/** Arbitrary for non-empty printable strings (agent IDs, inputs, etc.). */
const arbNonEmptyString = fc.string({ minLength: 1, maxLength: 64 }).filter(s => s.trim().length > 0);

/** Arbitrary for capability arrays. */
const arbCapabilities = fc.array(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 0, maxLength: 10 });

/** Arbitrary for a valid AgentResult. */
const arbAgentResult: fc.Arbitrary<AgentResult> = fc.record({
  text: fc.string(),
  stopReason: fc.oneof(
    fc.constant('end_turn' as const),
    fc.constant('max_turns' as const),
    fc.constant('cancelled' as const),
  ),
});

// ─── Property Tests ───────────────────────────────────────────────

describe('InProcessExecutor — Property Tests', () => {
  // ── Property 1 ──────────────────────────────────────────────────
  it('Property 1: Agent registration round-trip — discover returns matching id and capabilities', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyString,
        arbCapabilities,
        async (agentId, capabilities) => {
          const executor = createSilentExecutor();
          await executor.start();

          const agent = createMockAgent(agentId, capabilities);
          executor.register(agent);

          const discovered = await executor.discover();

          const match = discovered.find(a => a.id === agentId);
          expect(match).toBeDefined();
          expect(match!.id).toBe(agentId);
          expect(match!.capabilities).toEqual(capabilities);

          await executor.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 2 ──────────────────────────────────────────────────
  it('Property 2: Session lifecycle round-trip — create, prompt, close completes without errors and result matches', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyString,
        arbNonEmptyString,
        arbAgentResult,
        async (agentId, promptInput, expectedResult) => {
          const executor = createSilentExecutor();
          await executor.start();

          const promptFn = jest.fn().mockResolvedValue(expectedResult);
          const agent = createMockAgent(agentId, [], { prompt: promptFn });
          executor.register(agent);

          const session = await executor.createSession(agentId);
          expect(session.sessionId).toBeTruthy();
          expect(session.agentId).toBe(agentId);

          const result = await executor.prompt(session.sessionId, promptInput);
          expect(result).toEqual(expectedResult);

          // Verify prompt was called with correct args
          expect(promptFn).toHaveBeenCalledWith(session.sessionId, promptInput, undefined);

          await executor.closeSession(session.sessionId);

          await executor.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 3 ──────────────────────────────────────────────────
  it('Property 3: Lifecycle hooks invocation — onSessionCreate, onSessionClose, cancel called with correct sessionId', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyString,
        async (agentId) => {
          const executor = createSilentExecutor();
          await executor.start();

          const onSessionCreate = jest.fn().mockResolvedValue(undefined);
          const onSessionClose = jest.fn().mockResolvedValue(undefined);
          const cancelFn = jest.fn().mockResolvedValue(undefined);

          const agent = createMockAgent(agentId, [], {
            onSessionCreate,
            onSessionClose,
            cancel: cancelFn,
          });
          executor.register(agent);

          const session = await executor.createSession(agentId);
          const sid = session.sessionId;

          // onSessionCreate called with correct sessionId
          expect(onSessionCreate).toHaveBeenCalledTimes(1);
          expect(onSessionCreate).toHaveBeenCalledWith(sid, undefined);

          // cancel called with correct sessionId
          await executor.cancel(sid);
          expect(cancelFn).toHaveBeenCalledTimes(1);
          expect(cancelFn).toHaveBeenCalledWith(sid, undefined);

          // onSessionClose called with correct sessionId
          await executor.closeSession(sid);
          expect(onSessionClose).toHaveBeenCalledTimes(1);
          expect(onSessionClose).toHaveBeenCalledWith(sid, undefined);

          await executor.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 4 ──────────────────────────────────────────────────
  it('Property 4: Non-existent agent rejection — createSession with unregistered ID throws BridgeError', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyString,
        arbNonEmptyString,
        async (registeredId, requestedId) => {
          // Ensure the requested ID is different from the registered one
          fc.pre(registeredId !== requestedId);

          const executor = createSilentExecutor();
          await executor.start();

          const agent = createMockAgent(registeredId);
          executor.register(agent);

          await expect(executor.createSession(requestedId)).rejects.toThrow(BridgeError);

          await executor.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 5 ──────────────────────────────────────────────────
  it('Property 5: Session capacity enforcement — after maxSessions, next createSession throws BridgeError', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        async (maxSessions) => {
          const executor = createSilentExecutor({ maxSessions });
          await executor.start();

          const agent = createMockAgent('cap-agent');
          executor.register(agent);

          // Fill up to capacity
          for (let i = 0; i < maxSessions; i++) {
            await executor.createSession('cap-agent');
          }

          // Next one should throw
          await expect(executor.createSession('cap-agent')).rejects.toThrow(BridgeError);

          await executor.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 10 ─────────────────────────────────────────────────
  it('Property 10: Error wrapping — unexpected agent prompt errors wrapped in BridgeError.upstream with cause', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyString,
        fc.string({ minLength: 1 }),
        async (agentId, errorMessage) => {
          const executor = createSilentExecutor();
          await executor.start();

          const originalError = new Error(errorMessage);
          const failingPrompt = jest.fn().mockRejectedValue(originalError);
          const agent = createMockAgent(agentId, [], { prompt: failingPrompt });
          executor.register(agent);

          const session = await executor.createSession(agentId);

          try {
            await executor.prompt(session.sessionId, 'test input');
            // Should not reach here
            expect(true).toBe(false);
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            const bridgeErr = err as BridgeError;
            expect(bridgeErr.type).toBe('UPSTREAM');
            expect(bridgeErr.cause).toBe(originalError);
            expect(bridgeErr.cause?.message).toBe(errorMessage);
          }

          await executor.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Unit Tests ───────────────────────────────────────────────────

describe('InProcessExecutor — Unit Tests', () => {
  // ── 1. Session lifecycle ────────────────────────────────────────
  it('session lifecycle — create session, prompt, close session with specific values', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const expectedResult: AgentResult = { text: 'Hello world', stopReason: 'end_turn' };
    const promptFn = jest.fn().mockResolvedValue(expectedResult);
    const onSessionCreate = jest.fn().mockResolvedValue(undefined);
    const onSessionClose = jest.fn().mockResolvedValue(undefined);

    const agent = createMockAgent('test-agent', ['chat'], {
      prompt: promptFn,
      onSessionCreate,
      onSessionClose,
    });
    executor.register(agent);

    // Create session
    const session = await executor.createSession('test-agent', { user: 'alice' });
    expect(session.sessionId).toBeTruthy();
    expect(session.agentId).toBe('test-agent');
    expect(session.status).toBe('active');
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.lastActivityAt).toBeGreaterThan(0);
    expect(onSessionCreate).toHaveBeenCalledWith(session.sessionId, { user: 'alice' });

    // Prompt
    const result = await executor.prompt(session.sessionId, 'Say hello');
    expect(result).toEqual(expectedResult);
    expect(promptFn).toHaveBeenCalledWith(session.sessionId, 'Say hello', undefined);

    // Close session
    await executor.closeSession(session.sessionId, 'done');
    expect(onSessionClose).toHaveBeenCalledWith(session.sessionId, 'done');

    // Session should no longer exist
    await expect(executor.getSession(session.sessionId)).rejects.toThrow(BridgeError);

    await executor.close();
  });

  // ── 2. Agent discovery with capability filter ───────────────────
  it('agent discovery with capability filter — returns only matching agents', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const agentA = createMockAgent('agent-a', ['chat', 'code']);
    const agentB = createMockAgent('agent-b', ['code']);
    const agentC = createMockAgent('agent-c', ['search']);

    executor.register(agentA);
    executor.register(agentB);
    executor.register(agentC);

    const chatAgents = await executor.discover('chat');
    expect(chatAgents).toHaveLength(1);
    expect(chatAgents[0]!.id).toBe('agent-a');

    const codeAgents = await executor.discover('code');
    expect(codeAgents).toHaveLength(2);
    const codeIds = codeAgents.map(a => a.id).sort();
    expect(codeIds).toEqual(['agent-a', 'agent-b']);

    const searchAgents = await executor.discover('search');
    expect(searchAgents).toHaveLength(1);
    expect(searchAgents[0]!.id).toBe('agent-c');

    const noMatch = await executor.discover('nonexistent');
    expect(noMatch).toHaveLength(0);

    await executor.close();
  });

  // ── 3. Agent discovery without filter ───────────────────────────
  it('agent discovery without filter — returns all agents', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const agentA = createMockAgent('agent-x', ['chat']);
    const agentB = createMockAgent('agent-y', []);
    const agentC = createMockAgent('agent-z', ['code', 'search']);

    executor.register(agentA);
    executor.register(agentB);
    executor.register(agentC);

    const allAgents = await executor.discover();
    expect(allAgents).toHaveLength(3);

    const ids = allAgents.map(a => a.id).sort();
    expect(ids).toEqual(['agent-x', 'agent-y', 'agent-z']);

    // Verify capabilities are preserved
    const agentZ = allAgents.find(a => a.id === 'agent-z');
    expect(agentZ!.capabilities).toEqual(['code', 'search']);

    await executor.close();
  });

  // ── 4. Default agent selection ──────────────────────────────────
  it('default agent selection — createSession without agentId uses first registered agent', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const firstAgent = createMockAgent('first-agent', ['chat']);
    const secondAgent = createMockAgent('second-agent', ['code']);

    executor.register(firstAgent);
    executor.register(secondAgent);

    const session = await executor.createSession();
    expect(session.agentId).toBe('first-agent');

    await executor.close();
  });

  // ── 5. Error on unknown session ─────────────────────────────────
  it('error on unknown session — getSession/prompt/closeSession/cancel with unknown sessionId throws BridgeError', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const agent = createMockAgent('some-agent');
    executor.register(agent);

    const unknownId = 'nonexistent-session-id';

    await expect(executor.getSession(unknownId)).rejects.toThrow(BridgeError);
    await expect(executor.prompt(unknownId, 'hello')).rejects.toThrow(BridgeError);
    // closeSession is idempotent — does not throw on unknown session
    await expect(executor.closeSession(unknownId)).resolves.toBeUndefined();
    await expect(executor.cancel(unknownId)).rejects.toThrow(BridgeError);

    // Verify the error messages contain the session ID
    try {
      await executor.getSession(unknownId);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).message).toContain(unknownId);
      expect((err as BridgeError).type).toBe('UPSTREAM');
    }

    await executor.close();
  });

  // ── 6. Health reporting ─────────────────────────────────────────
  it('health reporting — health() returns correct counts before and after registering agents and creating sessions', async () => {
    const executor = createSilentExecutor({ maxSessions: 50 });
    await executor.start();

    // Before registering agents
    const healthEmpty = await executor.health();
    expect(healthEmpty.healthy).toBe(false); // no agents → not healthy
    expect(healthEmpty.agents.total).toBe(0);
    expect(healthEmpty.agents.ready).toBe(0);
    expect(healthEmpty.sessions.active).toBe(0);
    expect(healthEmpty.sessions.capacity).toBe(50);
    expect(healthEmpty.uptime).toBeGreaterThanOrEqual(0);

    // After registering agents
    executor.register(createMockAgent('agent-1'));
    executor.register(createMockAgent('agent-2'));

    const healthWithAgents = await executor.health();
    expect(healthWithAgents.healthy).toBe(true);
    expect(healthWithAgents.agents.total).toBe(2);
    expect(healthWithAgents.agents.ready).toBe(2);
    expect(healthWithAgents.sessions.active).toBe(0);

    // After creating sessions
    await executor.createSession('agent-1');
    await executor.createSession('agent-2');

    const healthWithSessions = await executor.health();
    expect(healthWithSessions.sessions.active).toBe(2);
    expect(healthWithSessions.agents.total).toBe(2);

    await executor.close();
  });

  // ── 7. Not started error ────────────────────────────────────────
  it('not started error — calling methods before start() throws BridgeError.internal', async () => {
    const executor = createSilentExecutor();

    // Register is allowed before start (no assertReady check)
    const agent = createMockAgent('agent-pre');
    executor.register(agent);

    // All executor interface methods that require readiness should throw
    await expect(executor.discover()).rejects.toThrow(BridgeError);
    await expect(executor.createSession('agent-pre')).rejects.toThrow(BridgeError);
    await expect(executor.getSession('any-id')).rejects.toThrow(BridgeError);
    await expect(executor.closeSession('any-id')).rejects.toThrow(BridgeError);
    await expect(executor.prompt('any-id', 'hello')).rejects.toThrow(BridgeError);
    await expect(executor.cancel('any-id')).rejects.toThrow(BridgeError);

    // Verify the error type is INTERNAL
    try {
      await executor.discover();
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).type).toBe('INTERNAL');
      expect((err as BridgeError).message).toContain('not started');
    }
  });
});

// ─── Bug Fix Regression Tests ─────────────────────────────────────

describe('InProcessExecutor — Bug Fix Regression Tests', () => {
  // Bug 1: Concurrent prompt guard
  it('rejects concurrent prompt on busy session', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    // Agent that takes time to respond
    let resolvePrompt: ((value: AgentResult) => void) | undefined;
    const slowAgent = createMockAgent('slow-agent', [], {
      prompt: jest.fn<any>().mockImplementation(() => {
        return new Promise<AgentResult>((resolve) => {
          resolvePrompt = resolve;
        });
      }),
    });
    executor.register(slowAgent);

    const session = await executor.createSession('slow-agent');

    // First prompt — starts but doesn't resolve yet
    const firstPrompt = executor.prompt(session.sessionId, 'first');

    // Wait a tick for the first prompt to set status to busy
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second prompt — should be rejected because session is busy
    await expect(executor.prompt(session.sessionId, 'second')).rejects.toThrow(BridgeError);

    try {
      await expect(executor.prompt(session.sessionId, 'second')).rejects.toThrow(/busy/);
    } catch {
      // Already tested above
    }

    // Resolve the first prompt so it completes
    resolvePrompt!({ text: 'done', stopReason: 'end_turn' });
    const result = await firstPrompt;
    expect(result.text).toBe('done');

    await executor.close();
  });

  // Bug 2: BridgeError passthrough (no double wrapping)
  it('preserves BridgeError type from agent without re-wrapping', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const configError = BridgeError.config('Agent config is invalid');
    const agent = createMockAgent('error-agent', [], {
      prompt: jest.fn<any>().mockRejectedValue(configError),
    });
    executor.register(agent);

    const session = await executor.createSession('error-agent');

    try {
      await executor.prompt(session.sessionId, 'test');
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      const bridgeErr = err as BridgeError;
      // Must preserve original type — NOT re-wrapped as UPSTREAM
      expect(bridgeErr.type).toBe('CONFIG');
      expect(bridgeErr.message).toBe('Agent config is invalid');
      expect(bridgeErr).toBe(configError); // same object reference
    }

    await executor.close();
  });

  // Bug 3: closeSession idempotency
  it('closeSession on unknown session does not throw', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const agent = createMockAgent('some-agent');
    executor.register(agent);

    // Should not throw
    await expect(executor.closeSession('nonexistent-session')).resolves.toBeUndefined();

    await executor.close();
  });

  // Bug 4: AbortSignal pre-check
  it('rejects prompt with already-aborted signal', async () => {
    const executor = createSilentExecutor();
    await executor.start();

    const agent = createMockAgent('signal-agent');
    executor.register(agent);

    const session = await executor.createSession('signal-agent');

    const controller = new AbortController();
    controller.abort(); // abort before calling prompt

    await expect(
      executor.prompt(session.sessionId, 'test', { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);

    // Agent's prompt should NOT have been called
    expect(agent.prompt).not.toHaveBeenCalled();

    await executor.close();
  });
});


// ─── Session TTL and Idle Expiry Tests ────────────────────────────

describe('InProcessExecutor — Session TTL and Idle Expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── 1. Session expires after TTL ────────────────────────────────
  it('session expires after TTL even if recently active', async () => {
    const sessionTtlMs = 5000;   // 5 seconds TTL
    const sessionIdleMs = 60000; // 60 seconds idle (won't trigger)
    const reaperIntervalMs = 1000;

    const onSessionClose = jest.fn<(sessionId: string, reason?: string) => Promise<void>>()
      .mockResolvedValue(undefined);

    const executor = createSilentExecutor({ sessionTtlMs, sessionIdleMs, reaperIntervalMs });
    const agent = createMockAgent('ttl-agent', [], { onSessionClose });
    executor.register(agent);
    await executor.start();

    const session = await executor.createSession('ttl-agent');

    // Session should exist
    const found = await executor.getSession(session.sessionId);
    expect(found.sessionId).toBe(session.sessionId);

    // Advance time past TTL + one reaper interval to trigger the reap
    await jest.advanceTimersByTimeAsync(sessionTtlMs + reaperIntervalMs + 1);

    // Session should be reaped
    await expect(executor.getSession(session.sessionId)).rejects.toThrow(BridgeError);

    await executor.close();
  });

  // ── 2. Session expires after idle timeout ───────────────────────
  it('session expires after idle timeout', async () => {
    const sessionTtlMs = 60000;  // 60 seconds TTL (won't trigger)
    const sessionIdleMs = 3000;  // 3 seconds idle
    const reaperIntervalMs = 1000;

    const onSessionClose = jest.fn<(sessionId: string, reason?: string) => Promise<void>>()
      .mockResolvedValue(undefined);

    const executor = createSilentExecutor({ sessionTtlMs, sessionIdleMs, reaperIntervalMs });
    const agent = createMockAgent('idle-agent', [], { onSessionClose });
    executor.register(agent);
    await executor.start();

    const session = await executor.createSession('idle-agent');

    // Session should exist
    const found = await executor.getSession(session.sessionId);
    expect(found.sessionId).toBe(session.sessionId);

    // Advance time past idle timeout + one reaper interval
    await jest.advanceTimersByTimeAsync(sessionIdleMs + reaperIntervalMs + 1);

    // Session should be reaped
    await expect(executor.getSession(session.sessionId)).rejects.toThrow(BridgeError);

    await executor.close();
  });

  // ── 3. Reaper does not touch active sessions ────────────────────
  it('reaper does not remove sessions that are within TTL and idle limits', async () => {
    const sessionTtlMs = 60000;  // 60 seconds TTL
    const sessionIdleMs = 30000; // 30 seconds idle
    const reaperIntervalMs = 1000;

    const executor = createSilentExecutor({ sessionTtlMs, sessionIdleMs, reaperIntervalMs });
    const agent = createMockAgent('active-agent', []);
    executor.register(agent);
    await executor.start();

    const session = await executor.createSession('active-agent');

    // Advance time by one reaper interval — session is still fresh
    await jest.advanceTimersByTimeAsync(reaperIntervalMs + 1);

    // Session should still exist
    const found = await executor.getSession(session.sessionId);
    expect(found.sessionId).toBe(session.sessionId);

    await executor.close();
  });

  // ── 4. Reaper calls onSessionClose with reason 'expired' ───────
  it('reaper calls onSessionClose with reason "expired" for each reaped session', async () => {
    const sessionTtlMs = 10000;
    const sessionIdleMs = 2000;
    const reaperIntervalMs = 1000;

    const onSessionClose = jest.fn<(sessionId: string, reason?: string) => Promise<void>>()
      .mockResolvedValue(undefined);

    const executor = createSilentExecutor({ sessionTtlMs, sessionIdleMs, reaperIntervalMs });
    const agent = createMockAgent('expire-agent', [], { onSessionClose });
    executor.register(agent);
    await executor.start();

    const session1 = await executor.createSession('expire-agent');
    const session2 = await executor.createSession('expire-agent');

    // Advance time past idle timeout + one reaper interval
    await jest.advanceTimersByTimeAsync(sessionIdleMs + reaperIntervalMs + 1);

    // onSessionClose should have been called for both sessions with 'expired'
    expect(onSessionClose).toHaveBeenCalledWith(session1.sessionId, 'expired');
    expect(onSessionClose).toHaveBeenCalledWith(session2.sessionId, 'expired');

    // Both sessions should be gone
    await expect(executor.getSession(session1.sessionId)).rejects.toThrow(BridgeError);
    await expect(executor.getSession(session2.sessionId)).rejects.toThrow(BridgeError);

    await executor.close();
  });

  // ── 5. Reaper interval is cleared on close ──────────────────────
  it('close() stops the reaper interval', async () => {
    const reaperIntervalMs = 500;

    const executor = createSilentExecutor({ reaperIntervalMs });
    const agent = createMockAgent('close-agent', []);
    executor.register(agent);
    await executor.start();

    // Close the executor — this should clear the reaper interval
    await executor.close();

    // Advance time — no errors should occur (reaper is stopped)
    await jest.advanceTimersByTimeAsync(reaperIntervalMs * 5);

    // Executor is closed, no sessions to check — just verify no errors thrown
  });

  // ── 6. Reaper handles onSessionClose errors gracefully ──────────
  it('reaper continues even if onSessionClose throws', async () => {
    const sessionTtlMs = 10000;
    const sessionIdleMs = 1000;
    const reaperIntervalMs = 500;

    const onSessionClose = jest.fn<(sessionId: string, reason?: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('hook failure'))
      .mockResolvedValue(undefined);

    const executor = createSilentExecutor({ sessionTtlMs, sessionIdleMs, reaperIntervalMs });
    const agent = createMockAgent('error-hook-agent', [], { onSessionClose });
    executor.register(agent);
    await executor.start();

    const session1 = await executor.createSession('error-hook-agent');
    const session2 = await executor.createSession('error-hook-agent');

    // Advance time past idle timeout + one reaper interval
    await jest.advanceTimersByTimeAsync(sessionIdleMs + reaperIntervalMs + 1);

    // Both sessions should be removed despite the first hook throwing
    await expect(executor.getSession(session1.sessionId)).rejects.toThrow(BridgeError);
    await expect(executor.getSession(session2.sessionId)).rejects.toThrow(BridgeError);

    // onSessionClose was called for both
    expect(onSessionClose).toHaveBeenCalledTimes(2);

    await executor.close();
  });
});
