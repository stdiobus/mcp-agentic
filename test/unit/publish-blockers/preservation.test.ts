/**
 * Preservation Property Tests — Existing Behavior Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**
 *
 * These tests capture baseline behavior on UNFIXED code for non-buggy inputs.
 * They use fast-check property-based testing to verify that existing correct
 * behaviors are preserved across many random inputs.
 *
 * EXPECTED OUTCOME: All tests PASS on unfixed code (confirms baseline).
 */

import { jest } from '@jest/globals';
import * as fc from 'fast-check';
import { BridgeError } from '../../../src/errors/BridgeError.js';
import type { BridgeErrorType, BridgeErrorDetails } from '../../../src/errors/BridgeError.js';
import { mapBridgeErrorToMCP, mapErrorToMCP } from '../../../src/errors/error-mapper.js';
import { handleCombinedDiscover } from '../../../src/mcp/tools/agents.js';
import { handleCombinedHealth } from '../../../src/mcp/tools/health.js';
import { InProcessExecutor } from '../../../src/executor/InProcessExecutor.js';
import type { AgentInfo } from '../../../src/executor/types.js';
import { createMockExecutor } from '../mcp/tools/_mockExecutor.js';

// ── Arbitraries ─────────────────────────────────────────────────

const bridgeErrorTypes: BridgeErrorType[] = [
  'CONFIG', 'AUTH', 'TRANSPORT', 'UPSTREAM', 'TIMEOUT', 'PROTOCOL', 'INTERNAL',
];

const arbBridgeErrorType = fc.constantFrom(...bridgeErrorTypes);

const arbBridgeErrorDetails = fc.record({
  correlationId: fc.option(fc.uuid(), { nil: undefined }),
  upstreamCode: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  retryable: fc.boolean(),
  sessionValid: fc.option(fc.boolean(), { nil: undefined }),
  stage: fc.option(fc.constantFrom('init', 'connect', 'execute', 'close'), { nil: undefined }),
});

const arbErrorMessage = fc.string({ minLength: 1, maxLength: 100 });

/** Generate a unique agent ID (alphanumeric, 3-20 chars). */
const arbAgentId = fc.stringMatching(/^[a-z][a-z0-9-]{2,19}$/);

// ── Helpers ─────────────────────────────────────────────────────

// ── 1. BridgeError.toJSON() field preservation ──────────────────

describe('Preservation: BridgeError.toJSON() field preservation', () => {
  /**
   * **Validates: Requirements 3.2**
   *
   * For random BridgeErrorType and details, toJSON() always includes
   * `type`, `message`, `details`. When cause exists, `cause.message`
   * is present.
   */
  it('toJSON() always includes type, message, details for any BridgeError', () => {
    fc.assert(
      fc.property(
        arbBridgeErrorType,
        arbErrorMessage,
        arbBridgeErrorDetails,
        (errorType, message, details) => {
          const error = new BridgeError(errorType, message, details);
          const json = error.toJSON();

          expect(json).toHaveProperty('type', errorType);
          expect(json).toHaveProperty('message', message);
          expect(json).toHaveProperty('details');
          expect((json.details as BridgeErrorDetails).retryable).toBe(details.retryable);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('toJSON() includes cause.message when cause exists', () => {
    fc.assert(
      fc.property(
        arbBridgeErrorType,
        arbErrorMessage,
        arbBridgeErrorDetails,
        arbErrorMessage,
        (errorType, message, details, causeMessage) => {
          const cause = new Error(causeMessage);
          const error = new BridgeError(errorType, message, details, cause);
          const json = error.toJSON();

          expect(json.cause).toBeDefined();
          const causeObj = json.cause as Record<string, unknown>;
          expect(causeObj).toHaveProperty('message', causeMessage);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── 2. mapBridgeErrorToMCP() data field preservation ────────────

describe('Preservation: mapBridgeErrorToMCP() data field preservation', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For random BridgeErrors, mapBridgeErrorToMCP() result `data` always
   * includes `type` and `retryable`. Optional keys (`correlationId`,
   * `upstreamCode`, `sessionValid`, `stage`) are present only when the
   * corresponding detail value is defined.
   */
  it('data always includes type and retryable; optional keys present only when defined', () => {
    fc.assert(
      fc.property(
        arbBridgeErrorType,
        arbErrorMessage,
        arbBridgeErrorDetails,
        (errorType, message, details) => {
          const error = new BridgeError(errorType, message, details);
          const result = mapBridgeErrorToMCP(error);

          expect(result.data).toBeDefined();
          const data = result.data!;

          // type and retryable are always present
          expect('type' in data).toBe(true);
          expect('retryable' in data).toBe(true);

          // type and retryable must match the input
          expect(data.type).toBe(errorType);
          expect(data.retryable).toBe(details.retryable);

          // Optional keys present only when defined
          if (details.correlationId !== undefined) {
            expect('correlationId' in data).toBe(true);
            expect(data.correlationId).toBe(details.correlationId);
          } else {
            expect('correlationId' in data).toBe(false);
          }

          if (details.upstreamCode !== undefined) {
            expect('upstreamCode' in data).toBe(true);
            expect(data.upstreamCode).toBe(details.upstreamCode);
          } else {
            expect('upstreamCode' in data).toBe(false);
          }

          if (details.sessionValid !== undefined) {
            expect('sessionValid' in data).toBe(true);
            expect(data.sessionValid).toBe(details.sessionValid);
          } else {
            expect('sessionValid' in data).toBe(false);
          }

          if (details.stage !== undefined) {
            expect('stage' in data).toBe(true);
            expect(data.stage).toBe(details.stage);
          } else {
            expect('stage' in data).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── 3. mapErrorToMCP() non-BridgeError preservation ─────────────

describe('Preservation: mapErrorToMCP() non-BridgeError preservation', () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * For random Error messages, mapErrorToMCP() result `data` always
   * includes `type` and `retryable`.
   */
  it('data always includes type and retryable for non-BridgeError', () => {
    fc.assert(
      fc.property(
        arbErrorMessage,
        (message) => {
          const error = new Error(message);
          const result = mapErrorToMCP(error);

          expect(result.data).toBeDefined();
          const data = result.data!;

          expect(data.type).toBe('INTERNAL');
          expect(data.retryable).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── 4. handleCombinedDiscover unique-agents preservation ────────

describe('Preservation: handleCombinedDiscover unique-agents preservation', () => {
  /**
   * **Validates: Requirements 3.5**
   *
   * When all agent IDs are unique across executors, all agents appear
   * in result with in-process agents listed first.
   */
  it('returns all agents with in-process first when IDs are unique', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbAgentId, { minLength: 1, maxLength: 5 }),
        fc.uniqueArray(arbAgentId, { minLength: 1, maxLength: 5 }),
        async (inProcessIds, workerIds) => {
          // Ensure uniqueness across both sets
          const uniqueWorkerIds = workerIds.filter(id => !inProcessIds.includes(id));

          const inProcessAgents: AgentInfo[] = inProcessIds.map(id => ({
            id, capabilities: [], status: 'ready' as const,
          }));
          const workerAgents: AgentInfo[] = uniqueWorkerIds.map(id => ({
            id, capabilities: [], status: 'ready' as const,
          }));

          const inProcessExecutor = createMockExecutor({
            discover: jest.fn<any>().mockResolvedValue(inProcessAgents),
          });
          const workerExecutor = createMockExecutor({
            discover: jest.fn<any>().mockResolvedValue(workerAgents),
          });

          const result = await handleCombinedDiscover(inProcessExecutor, workerExecutor, {});
          const parsed = JSON.parse(result.content[0].text) as { agents: AgentInfo[] };

          // All agents should appear
          expect(parsed.agents.length).toBe(inProcessAgents.length + uniqueWorkerIds.length);

          // In-process agents should come first
          for (let i = 0; i < inProcessAgents.length; i++) {
            expect(parsed.agents[i].id).toBe(inProcessIds[i]);
          }

          // Worker agents should follow
          for (let i = 0; i < uniqueWorkerIds.length; i++) {
            expect(parsed.agents[inProcessAgents.length + i].id).toBe(uniqueWorkerIds[i]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 5. handleCombinedHealth success preservation ────────────────

describe('Preservation: handleCombinedHealth success preservation', () => {
  /**
   * **Validates: Requirements 3.6**
   *
   * When health succeeds, response includes `healthy`, `agents`,
   * `sessions`, `uptime` fields.
   */
  it('success response includes healthy, agents, sessions, uptime', async () => {
    const inProcessExecutor = createMockExecutor({
      discover: jest.fn<any>().mockResolvedValue([
        { id: 'agent-a', capabilities: [], status: 'ready' },
      ]),
    });

    const result = await handleCombinedHealth(inProcessExecutor);
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(parsed).toHaveProperty('healthy');
    expect(parsed).toHaveProperty('agents');
    expect(parsed).toHaveProperty('sessions');
    expect(parsed).toHaveProperty('uptime');

    const agents = parsed.agents as { total: number; ready: number };
    expect(agents).toHaveProperty('total');
    expect(agents).toHaveProperty('ready');

    const sessions = parsed.sessions as { active: number; capacity: number };
    expect(sessions).toHaveProperty('active');
    expect(sessions).toHaveProperty('capacity');
  });
});

// ── 6. InProcessExecutor.close() session clearing preservation ──

describe('Preservation: InProcessExecutor.close() session clearing', () => {
  /**
   * **Validates: Requirements 3.7**
   *
   * close() clears all sessions and logs count to stderr.
   */
  it('close() clears all sessions and logs count to stderr', async () => {
    // This test specifically validates stderr logging, so silent must be false
    const executor = new InProcessExecutor({ reaperIntervalMs: 60_000 });

    executor.register({
      id: 'test-agent',
      capabilities: [],
      async prompt() {
        return { text: 'ok', stopReason: 'end_turn' };
      },
    });

    // Capture stderr output from the start to suppress start() noise
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await executor.start();

      // Create some sessions
      await executor.createSession('test-agent');
      await executor.createSession('test-agent');

      const sessionsBeforeClose = (executor as any).sessions.size;
      expect(sessionsBeforeClose).toBe(2);

      // Clear captures so we only check close() output
      stderrWrites.length = 0;

      await executor.close();
    } finally {
      process.stderr.write = originalWrite;
    }

    // Sessions should be cleared
    expect((executor as any).sessions.size).toBe(0);

    // Stderr should contain the session count
    const logOutput = stderrWrites.join('');
    expect(logOutput).toContain('2 sessions');
  });
});

// ── 7. InProcessExecutor.prompt() signal behavior preservation ──

describe('Preservation: InProcessExecutor.prompt() signal behavior', () => {
  /**
   * **Validates: Requirements 3.8, 3.9**
   *
   * Non-aborted signal executes agent prompt; already-aborted signal
   * rejects immediately with BridgeError.
   */
  it('non-aborted signal executes agent prompt normally', async () => {
    const executor = new InProcessExecutor({ reaperIntervalMs: 60_000, silent: true });

    executor.register({
      id: 'test-agent',
      capabilities: [],
      async prompt(_sessionId: string, input: string) {
        return { text: `echo: ${input}`, stopReason: 'end_turn' };
      },
    });

    await executor.start();

    const session = await executor.createSession('test-agent');
    const controller = new AbortController();

    const result = await executor.prompt(session.sessionId, 'hello', {
      signal: controller.signal,
    });

    expect(result.text).toBe('echo: hello');
    expect(result.stopReason).toBe('end_turn');

    await executor.close();
  });

  it('already-aborted signal rejects immediately with BridgeError', async () => {
    const executor = new InProcessExecutor({ reaperIntervalMs: 60_000, silent: true });

    let promptCalled = false;
    executor.register({
      id: 'test-agent',
      capabilities: [],
      async prompt() {
        promptCalled = true;
        return { text: 'should not reach', stopReason: 'end_turn' };
      },
    });

    await executor.start();

    const session = await executor.createSession('test-agent');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.prompt(session.sessionId, 'hello', { signal: controller.signal }),
    ).rejects.toThrow(BridgeError);

    // Agent prompt should NOT have been called
    expect(promptCalled).toBe(false);

    await executor.close();
  });
});
