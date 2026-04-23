/**
 * Bug Condition Exploration Tests — Publish Blocker Defects
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**
 *
 * These tests encode the EXPECTED (correct) behavior for each of the six
 * publish-blocking bugs. On UNFIXED code they are expected to FAIL,
 * confirming the bugs exist. After the fixes are applied they should PASS.
 *
 * DO NOT fix the code or the tests when they fail — failure IS the success
 * case for exploration tests.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';
import { BridgeError } from '../../../src/errors/BridgeError.js';
import { mapErrorToMCP } from '../../../src/errors/error-mapper.js';
import { handleCombinedDiscover } from '../../../src/mcp/tools/agents.js';
import { handleBridgeHealth } from '../../../src/mcp/tools/health.js';
import { InProcessExecutor } from '../../../src/executor/InProcessExecutor.js';
import type { AgentInfo } from '../../../src/executor/types.js';
import { createMockExecutor } from '../mcp/tools/_mockExecutor.js';

// ── Helpers ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, '..', '..', '..', 'package.json');

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
}

// ── Bug 1 — Phantom dependency ──────────────────────────────────

describe('Bug 1 — Phantom dependency: zod-to-json-schema', () => {
  /**
   * **Validates: Requirements 1.1**
   *
   * package.json MUST declare zod-to-json-schema as an explicit dependency.
   * On unfixed code this will FAIL because the dependency is missing.
   */
  it('should have zod-to-json-schema in dependencies', () => {
    const pkg = readPackageJson();
    const deps = pkg.dependencies as Record<string, string> | undefined;

    expect(deps).toBeDefined();
    expect(deps).toHaveProperty('zod-to-json-schema');
  });
});

// ── Bug 2 — BridgeError.toJSON() stack leak ─────────────────────

describe('Bug 2 — BridgeError.toJSON() stack leak', () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * toJSON() MUST NOT include `stack` at the top level or in `cause`.
   * On unfixed code this will FAIL because stack is present.
   */
  it('should NOT have stack key in toJSON() output', () => {
    const error = BridgeError.internal('test error');
    const json = error.toJSON();

    expect(json).not.toHaveProperty('stack');
  });

  it('should NOT have stack key in cause sub-object of toJSON() output', () => {
    const cause = new Error('original cause');
    const error = BridgeError.upstream('test error', {}, cause);
    const json = error.toJSON();

    expect(json.cause).toBeDefined();
    const causeObj = json.cause as Record<string, unknown>;
    expect(causeObj).not.toHaveProperty('stack');
  });
});

// ── Bug 3 — mapErrorToMCP() stack leak ──────────────────────────

describe('Bug 3 — mapErrorToMCP() stack leak', () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * mapErrorToMCP() for non-BridgeErrors MUST NOT include `stack` in data.
   * On unfixed code this will FAIL because stack is present.
   */
  it('should NOT have stack key in data for non-BridgeError', () => {
    const error = new TypeError('test type error');
    const result = mapErrorToMCP(error);

    expect(result.data).toBeDefined();
    expect(result.data).not.toHaveProperty('stack');
  });
});

// ── Bug 4 — Duplicate agents in handleCombinedDiscover() ────────

describe('Bug 4 — Duplicate agents in handleCombinedDiscover()', () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * handleCombinedDiscover() MUST return unique agent IDs when both
   * executors have overlapping agents. On unfixed code this will FAIL
   * because duplicates are returned.
   */
  it('should return unique agent IDs when executors have overlapping agents', async () => {
    const sharedAgentId = 'codex';

    const inProcessExecutor = createMockExecutor({
      discover: jest.fn<any>().mockResolvedValue([
        { id: sharedAgentId, capabilities: ['code'], status: 'ready' },
        { id: 'in-process-only', capabilities: [], status: 'ready' },
      ]),
    });

    const workerExecutor = createMockExecutor({
      discover: jest.fn<any>().mockResolvedValue([
        { id: sharedAgentId, capabilities: ['code'], status: 'ready' },
        { id: 'worker-only', capabilities: [], status: 'ready' },
      ]),
    });

    const result = await handleCombinedDiscover(inProcessExecutor, workerExecutor, {});
    const text = result.content[0].text;
    const parsed = JSON.parse(text) as { agents: AgentInfo[] };

    const agentIds = parsed.agents.map((a: AgentInfo) => a.id);
    const uniqueIds = new Set(agentIds);

    expect(agentIds.length).toBe(uniqueIds.size);
  });
});

// ── Bug 5 — Inconsistent health error shape ─────────────────────

describe('Bug 5 — Inconsistent health error shape', () => {
  /**
   * **Validates: Requirements 1.5**
   *
   * handleBridgeHealth() error path MUST return { error, code, data } shape
   * consistent with mapErrorToMCP(). On unfixed code this will FAIL because
   * it returns { healthy, error } instead.
   */
  it('should return { error, code, data } shape when health() throws', async () => {
    const executor = createMockExecutor({
      health: jest.fn<any>().mockRejectedValue(new Error('Connection refused')),
    });

    const result = await handleBridgeHealth(executor);
    const text = result.content[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(parsed).toHaveProperty('error');
    expect(parsed).toHaveProperty('code');
    expect(parsed).toHaveProperty('data');
  });
});

// ── Bug 6 — Reaper/close race ───────────────────────────────────

describe('Bug 6 — Reaper/close race condition', () => {
  /**
   * **Validates: Requirements 1.6**
   *
   * close() MUST call stopReaper() BEFORE setting ready = false.
   * reapExpiredSessions() MUST exit early when ready === false.
   * On unfixed code these will FAIL.
   */
  it('should call stopReaper() BEFORE setting ready = false in close()', async () => {
    const executor = new InProcessExecutor({ reaperIntervalMs: 60_000, silent: true });

    // Register a minimal agent so start() works
    executor.register({
      id: 'test-agent',
      capabilities: [],
      async prompt() {
        return { text: 'ok', stopReason: 'end_turn' };
      },
    });

    await executor.start();

    // Spy on stopReaper and track call order relative to ready state
    const callOrder: string[] = [];

    const originalStopReaper = (executor as any).stopReaper.bind(executor);
    (executor as any).stopReaper = () => {
      callOrder.push(`stopReaper:ready=${(executor as any).ready}`);
      originalStopReaper();
    };

    // Intercept ready setter to track when it changes
    let readyValue = (executor as any).ready;
    Object.defineProperty(executor, 'ready', {
      get() { return readyValue; },
      set(v: boolean) {
        callOrder.push(`setReady:${v}`);
        readyValue = v;
      },
      configurable: true,
    });

    await executor.close();

    // stopReaper should be called while ready is still true
    const stopReaperEntry = callOrder.find(e => e.startsWith('stopReaper:'));
    expect(stopReaperEntry).toBe('stopReaper:ready=true');
  });

  it('should exit early from reapExpiredSessions() when ready === false', async () => {
    const executor = new InProcessExecutor({ reaperIntervalMs: 60_000, silent: true });

    executor.register({
      id: 'test-agent',
      capabilities: [],
      async prompt() {
        return { text: 'ok', stopReason: 'end_turn' };
      },
    });

    await executor.start();

    // Set ready to false to simulate post-close state
    (executor as any).ready = false;

    // Add a fake session that would be reaped if the guard is missing
    const fakeSession = {
      sessionId: 'fake-session',
      agentId: 'test-agent',
      status: 'idle',
      createdAt: 0,          // expired by TTL
      lastActivityAt: 0,     // expired by idle
      agent: (executor as any).agents.get('test-agent'),
    };
    (executor as any).sessions.set('fake-session', fakeSession);

    // Call reapExpiredSessions directly
    await (executor as any).reapExpiredSessions();

    // If the guard exists, the session should NOT be reaped
    expect((executor as any).sessions.has('fake-session')).toBe(true);

    // Cleanup
    (executor as any).stopReaper();
  });
});
