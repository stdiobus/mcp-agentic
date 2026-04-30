/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import type { WorkerConfig } from '../../../src/executor/types.js';
import type { WorkerExecutorConfig } from '../../../src/executor/WorkerExecutor.js';

// ─── Module-level variables populated in beforeAll ────────────────

let WorkerExecutor: typeof import('../../../src/executor/WorkerExecutor.js').WorkerExecutor;
let BridgeError: typeof import('../../../src/errors/BridgeError.js').BridgeError;
type BridgeErrorType = InstanceType<typeof import('../../../src/errors/BridgeError.js').BridgeError>;

let MockStdioBus: jest.MockedClass<typeof import('@stdiobus/node').StdioBus>;

let capturedBusConfig: any = null;
let mockBusInstance: {
  start: jest.Mock;
  stop: jest.Mock;
  request: jest.Mock;
};

// ─── ESM mock setup + dynamic imports in beforeAll ────────────────

beforeAll(async () => {
  jest.unstable_mockModule('@stdiobus/node', () => {
    const MockStdioBusClass = jest.fn();
    return {
      StdioBus: MockStdioBusClass,
      __esModule: true,
    };
  });

  const stdiobusModule = await import('@stdiobus/node');
  const workerModule = await import('../../../src/executor/WorkerExecutor.js');
  const bridgeErrorModule = await import('../../../src/errors/BridgeError.js');

  MockStdioBus = stdiobusModule.StdioBus as jest.MockedClass<typeof stdiobusModule.StdioBus>;
  WorkerExecutor = workerModule.WorkerExecutor;
  BridgeError = bridgeErrorModule.BridgeError;
});

beforeEach(() => {
  MockStdioBus.mockClear();
  capturedBusConfig = null;

  mockBusInstance = {
    start: jest.fn<any>().mockResolvedValue(undefined),
    stop: jest.fn<any>().mockResolvedValue(undefined),
    request: jest.fn<any>().mockResolvedValue({ sessionId: 'mock-session' }),
  };

  MockStdioBus.mockImplementation((config: any) => {
    capturedBusConfig = config;
    return mockBusInstance as any;
  });
});

/** Helper to create a WorkerExecutor with silent: true to suppress stderr noise in tests. */
function createSilentWorkerExecutor(config?: Omit<WorkerExecutorConfig, 'silent'>): InstanceType<typeof import('../../../src/executor/WorkerExecutor.js').WorkerExecutor> {
  return new WorkerExecutor({ ...config, silent: true });
}

// ─── Arbitraries ──────────────────────────────────────────────────

const arbNonEmptyString = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => s.trim().length > 0);

const arbArgs = fc.array(fc.string({ minLength: 0, maxLength: 32 }), {
  minLength: 0,
  maxLength: 5,
});

const arbEnv = fc.option(
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 16 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
    fc.string({ minLength: 0, maxLength: 64 }),
    { minKeys: 1, maxKeys: 5 },
  ),
  { nil: undefined },
);

const arbWorkerConfig: fc.Arbitrary<WorkerConfig> = fc
  .tuple(
    arbNonEmptyString,
    arbNonEmptyString,
    arbArgs,
    arbEnv,
    fc.option(
      fc.array(fc.string({ minLength: 1, maxLength: 16 }), { minLength: 0, maxLength: 5 }),
      { nil: undefined },
    ),
  )
  .map(([id, command, args, env, capabilities]) => {
    const config: WorkerConfig = { id, command, args };
    if (env !== undefined) config.env = env;
    if (capabilities !== undefined) config.capabilities = capabilities;
    return config;
  });

const arbWorkerConfigs = fc
  .array(arbWorkerConfig, { minLength: 1, maxLength: 10 })
  .map((configs) => {
    return configs.map((c, i) => {
      const config: WorkerConfig = { id: `${c.id}-${i}`, command: c.command, args: c.args };
      if (c.env !== undefined) config.env = c.env;
      if (c.capabilities !== undefined) config.capabilities = c.capabilities;
      return config;
    });
  });

// ─── Property Tests ───────────────────────────────────────────────

describe('WorkerExecutor — Property Tests', () => {
  it('Property 6: WorkerConfig to StdioBus pool config preservation', async () => {
    await fc.assert(
      fc.asyncProperty(arbWorkerConfigs, async (workerConfigs) => {
        MockStdioBus.mockClear();
        capturedBusConfig = null;
        mockBusInstance.start.mockClear();
        mockBusInstance.stop.mockClear();
        mockBusInstance.request.mockClear();

        const executor = createSilentWorkerExecutor();
        for (const config of workerConfigs) {
          executor.addWorker(config);
        }

        await executor.start();

        expect(MockStdioBus).toHaveBeenCalledTimes(1);
        expect(capturedBusConfig).toBeDefined();

        const pools = capturedBusConfig.config.pools;
        expect(pools).toHaveLength(workerConfigs.length);

        for (let i = 0; i < workerConfigs.length; i++) {
          const workerCfg = workerConfigs[i]!;
          const pool = pools[i];
          expect(pool.id).toBe(workerCfg.id);
          expect(pool.command).toBe(workerCfg.command);
          expect(pool.args).toEqual(workerCfg.args);
          // env is NOT passed to StdioBus pool config because
          // StdioBusConfig.pools does not include env in its type.
          // See WorkerExecutor.ts for details.
          expect(pool.env).toBeUndefined();
        }

        await executor.close();
      }),
      { numRuns: 100 },
    );
  });

  it('Property 11: Worker error wrapping — bus.request errors wrapped in BridgeError', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyString,
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 64 }).filter(
            (s) =>
              !s.toLowerCase().includes('timeout') &&
              !s.toLowerCase().includes('timed out'),
          ),
          fc.constantFrom(
            'Request timeout',
            'Operation timed out',
            'Worker TIMEOUT exceeded',
            'Connection timed out waiting for response',
          ),
        ),
        async (workerId, errorMessage) => {
          MockStdioBus.mockClear();
          capturedBusConfig = null;
          mockBusInstance.start.mockClear();
          mockBusInstance.stop.mockClear();
          mockBusInstance.request.mockClear();
          (mockBusInstance.request as jest.Mock<any>).mockResolvedValue({ sessionId: 'mock-session' });

          const executor = createSilentWorkerExecutor();
          executor.addWorker({ id: workerId, command: 'node', args: ['worker.js'] });

          (mockBusInstance.request as jest.Mock<any>).mockRejectedValue(new Error(errorMessage));

          await executor.start();

          const isTimeout =
            errorMessage.toLowerCase().includes('timeout') ||
            errorMessage.toLowerCase().includes('timed out');

          try {
            await executor.createSession(workerId);
            expect(true).toBe(false);
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            const bridgeErr = err as BridgeErrorType;
            expect(bridgeErr.message).toContain(workerId);

            if (isTimeout) {
              expect(bridgeErr.type).toBe('TRANSPORT');
              expect(bridgeErr.details.retryable).toBe(true);
            } else {
              expect(bridgeErr.type).toBe('UPSTREAM');
            }

            expect(bridgeErr.cause).toBeInstanceOf(Error);
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

describe('WorkerExecutor — Unit Tests', () => {
  describe('bus.request method signatures', () => {
    it('createSession calls bus.request("session/new", { agentId }, { timeout })', async () => {
      const executor = createSilentWorkerExecutor({ defaultTimeout: 5000 });
      executor.addWorker({ id: 'agent-1', command: 'node', args: ['w.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValue({ sessionId: 'sess-abc' });

      await executor.start();
      await executor.createSession('agent-1');

      expect(mockBusInstance.request).toHaveBeenCalledWith(
        'session/new',
        { agentId: 'agent-1' },
        { timeout: 5000 },
      );
      await executor.close();
    });

    it('prompt calls bus.request("session/prompt", { sessionId, input }, { timeout })', async () => {
      const executor = createSilentWorkerExecutor({ defaultTimeout: 7000 });
      executor.addWorker({ id: 'agent-1', command: 'node', args: ['w.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-abc' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ text: 'hello', stopReason: 'end_turn' });

      await executor.start();
      await executor.createSession('agent-1');
      await executor.prompt('sess-abc', 'Hi there');

      expect(mockBusInstance.request).toHaveBeenCalledWith(
        'session/prompt',
        { sessionId: 'sess-abc', input: 'Hi there' },
        { timeout: 7000 },
      );
      await executor.close();
    });

    it('closeSession calls bus.request("session/close", { sessionId }, { timeout })', async () => {
      const executor = createSilentWorkerExecutor({ defaultTimeout: 4000 });
      executor.addWorker({ id: 'agent-1', command: 'node', args: ['w.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-abc' });

      await executor.start();
      await executor.createSession('agent-1');
      await executor.closeSession('sess-abc');

      expect(mockBusInstance.request).toHaveBeenCalledWith(
        'session/close',
        { sessionId: 'sess-abc' },
        { timeout: 4000 },
      );
      await executor.close();
    });
  });

  describe('env passthrough', () => {
    // NOTE: StdioBusConfig.pools does not include `env` in its type definition.
    // WorkerConfig.env is accepted by our public API but is NOT forwarded to
    // StdioBus pool config because the upstream type doesn't support it.
    // When @stdiobus/node adds env support to pools, update WorkerExecutor
    // to pass it through and re-enable the assertion below.
    it('does not pass env to StdioBus pool config (unsupported by StdioBusConfig)', async () => {
      const env = { API_KEY: 'secret-123', NODE_ENV: 'production' };
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'], env });

      await executor.start();
      expect(capturedBusConfig).toBeDefined();
      // env is not in StdioBusConfig.pools — it would be silently ignored
      expect(capturedBusConfig.config.pools[0].env).toBeUndefined();
      await executor.close();
    });

    it('omits env from pool config when WorkerConfig has no env', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      expect(capturedBusConfig).toBeDefined();
      expect(capturedBusConfig.config.pools[0].env).toBeUndefined();
      await executor.close();
    });
  });

  describe('timeout handling', () => {
    it('wraps timeout errors in BridgeError.transport with retryable: true', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValue(new Error('Request timeout'));

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('TRANSPORT');
        expect(bridgeErr.details.retryable).toBe(true);
        expect(bridgeErr.message).toContain('w1');
      }
      await executor.close();
    });
  });

  describe('bus error propagation', () => {
    it('wraps generic bus errors in BridgeError.upstream with context', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValue(new Error('Connection refused'));

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('w1');
        expect(bridgeErr.message).toContain('createSession');
        expect(bridgeErr.cause?.message).toBe('Connection refused');
      }
      await executor.close();
    });

    it('wraps prompt bus errors in BridgeError.upstream with operation context', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValueOnce(new Error('Worker crashed'));

      await executor.start();
      await executor.createSession('w1');
      try {
        await executor.prompt('sess-1', 'hello');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('prompt');
        expect(bridgeErr.cause?.message).toBe('Worker crashed');
      }
      await executor.close();
    });
  });

  describe('close()', () => {
    it('calls bus.stop() when closing', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      expect(mockBusInstance.stop).not.toHaveBeenCalled();
      await executor.close();
      expect(mockBusInstance.stop).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no bus exists (no workers)', async () => {
      const executor = createSilentWorkerExecutor();
      await executor.start();
      await expect(executor.close()).resolves.toBeUndefined();
    });
  });

  describe('isReady()', () => {
    it('returns false before start() is called', () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      expect(executor.isReady()).toBe(false);
    });

    it('returns true after start() is called', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      await executor.start();
      expect(executor.isReady()).toBe(true);
      await executor.close();
    });

    it('returns false after close() is called', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      await executor.start();
      await executor.close();
      expect(executor.isReady()).toBe(false);
    });
  });

  describe('start()', () => {
    it('starts StdioBus for multiple workers — each pool is configured', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'] });
      executor.addWorker({ id: 'w2', command: 'python', args: ['b.py'] });
      executor.addWorker({ id: 'w3', command: 'deno', args: ['c.ts'] });

      await executor.start();

      expect(MockStdioBus).toHaveBeenCalledTimes(1);
      expect(capturedBusConfig).toBeDefined();
      const pools = capturedBusConfig.config.pools;
      expect(pools).toHaveLength(3);
      expect(pools[0].id).toBe('w1');
      expect(pools[1].id).toBe('w2');
      expect(pools[2].id).toBe('w3');
      expect(mockBusInstance.start).toHaveBeenCalledTimes(1);

      await executor.close();
    });

    it('wraps StdioBus start failure in BridgeError.transport', async () => {
      mockBusInstance.start.mockRejectedValue(new Error('spawn ENOENT'));

      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'nonexistent', args: [] });

      try {
        await executor.start();
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('TRANSPORT');
        // BridgeError.transport() always sets retryable: true (factory override)
        expect(bridgeErr.details.retryable).toBe(true);
        expect(bridgeErr.message).toContain('Failed to start StdioBus');
        expect(bridgeErr.cause?.message).toBe('spawn ENOENT');
      }
    });

    it('logs to stderr when silent is false', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const executor = new WorkerExecutor({ silent: false });
        executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
        await executor.start();
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('[WorkerExecutor] Started with 1 workers'),
        );
        await executor.close();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('logs "no workers" to stderr when silent is false and no workers registered', async () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const executor = new WorkerExecutor({ silent: false });
        // No workers added
        await executor.start();
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('[WorkerExecutor] Started (no workers)'),
        );
        await executor.close();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('logs failure to stderr when silent is false and start fails', async () => {
      mockBusInstance.start.mockRejectedValue(new Error('bus crash'));
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const executor = new WorkerExecutor({ silent: false });
        executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
        await expect(executor.start()).rejects.toThrow();
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('[WorkerExecutor] Failed to start'),
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe('assertReady()', () => {
    it('throws BridgeError INTERNAL when executor is not started', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      // Calling any method that uses assertReady before start()
      try {
        await executor.discover();
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('INTERNAL');
        expect(bridgeErr.message).toContain('Executor not started');
      }
    });
  });

  describe('discover()', () => {
    it('returns all workers as agent info when no capability filter', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'], capabilities: ['chat'] });
      executor.addWorker({ id: 'w2', command: 'node', args: ['b.js'], capabilities: ['code'] });

      await executor.start();
      const agents = await executor.discover();

      expect(agents).toHaveLength(2);
      expect(agents[0]).toEqual({ id: 'w1', capabilities: ['chat'], status: 'ready' });
      expect(agents[1]).toEqual({ id: 'w2', capabilities: ['code'], status: 'ready' });

      await executor.close();
    });

    it('filters agents by capability', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'], capabilities: ['chat'] });
      executor.addWorker({ id: 'w2', command: 'node', args: ['b.js'], capabilities: ['code'] });
      executor.addWorker({ id: 'w3', command: 'node', args: ['c.js'], capabilities: ['chat', 'code'] });

      await executor.start();
      const chatAgents = await executor.discover('chat');

      expect(chatAgents).toHaveLength(2);
      expect(chatAgents.map((a) => a.id)).toEqual(['w1', 'w3']);

      await executor.close();
    });

    it('returns empty capabilities when worker has none', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'] });

      await executor.start();
      const agents = await executor.discover();

      expect(agents[0]!.capabilities).toEqual([]);

      await executor.close();
    });
  });

  describe('getSession()', () => {
    it('throws BridgeError UPSTREAM when session does not exist', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      try {
        await executor.getSession('nonexistent-session');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('Session not found');
        expect(bridgeErr.message).toContain('nonexistent-session');
      }

      await executor.close();
    });

    it('returns a copy of the session entry for an existing session', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });

      await executor.start();
      await executor.createSession('w1');
      const session = await executor.getSession('sess-1');

      expect(session.sessionId).toBe('sess-1');
      expect(session.agentId).toBe('w1');
      expect(session.status).toBe('active');

      await executor.close();
    });
  });

  describe('closeSession()', () => {
    it('calls bus.request with session/close and removes session from tracking', async () => {
      const executor = createSilentWorkerExecutor({ defaultTimeout: 5000 });
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce(undefined);

      await executor.start();
      await executor.createSession('w1');
      await executor.closeSession('sess-1');

      // Verify bus.request was called with session/close
      expect(mockBusInstance.request).toHaveBeenCalledWith(
        'session/close',
        { sessionId: 'sess-1' },
        { timeout: 5000 },
      );

      // Session should be removed — getSession should throw
      try {
        await executor.getSession('sess-1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeErrorType).message).toContain('Session not found');
      }

      await executor.close();
    });

    it('is idempotent — closing a non-existent session is a no-op', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      // Should not throw
      await expect(executor.closeSession('nonexistent')).resolves.toBeUndefined();

      await executor.close();
    });

    it('wraps bus errors during closeSession in BridgeError', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValueOnce(new Error('close failed'));

      await executor.start();
      await executor.createSession('w1');

      try {
        await executor.closeSession('sess-1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('closeSession');
        expect(bridgeErr.cause?.message).toBe('close failed');
      }

      // Session should still be removed from tracking (finally block)
      try {
        await executor.getSession('sess-1');
        expect(true).toBe(false);
      } catch (err) {
        expect((err as BridgeErrorType).message).toContain('Session not found');
      }

      await executor.close();
    });
  });

  describe('cancel()', () => {
    it('sends session/cancel request to the bus', async () => {
      const executor = createSilentWorkerExecutor({ defaultTimeout: 6000 });
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce(undefined);

      await executor.start();
      await executor.createSession('w1');
      await executor.cancel('sess-1');

      expect(mockBusInstance.request).toHaveBeenCalledWith(
        'session/cancel',
        { sessionId: 'sess-1' },
        { timeout: 6000 },
      );

      await executor.close();
    });

    it('throws BridgeError UPSTREAM when session does not exist', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      try {
        await executor.cancel('nonexistent');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('Session not found');
      }

      await executor.close();
    });

    it('swallows bus errors during cancel (best-effort)', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValueOnce(new Error('cancel failed'));

      await executor.start();
      await executor.createSession('w1');

      // Should not throw — errors are swallowed
      await expect(executor.cancel('sess-1')).resolves.toBeUndefined();

      await executor.close();
    });
  });

  describe('health()', () => {
    it('returns correct health info when started with workers', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'] });
      executor.addWorker({ id: 'w2', command: 'node', args: ['b.js'] });

      await executor.start();
      const health = await executor.health();

      expect(health.healthy).toBe(true);
      expect(health.agents.total).toBe(2);
      expect(health.agents.ready).toBe(2);
      expect(health.sessions.active).toBe(0);
      expect(health.sessions.capacity).toBe(1000);
      expect(health.uptime).toBeGreaterThanOrEqual(0);

      await executor.close();
    });

    it('returns healthy: false when not started', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'] });

      const health = await executor.health();

      expect(health.healthy).toBe(false);
      expect(health.agents.total).toBe(1);
      expect(health.agents.ready).toBe(0);
      expect(health.uptime).toBe(0);
    });

    it('returns healthy: false when started with no workers', async () => {
      const executor = createSilentWorkerExecutor();

      await executor.start();
      const health = await executor.health();

      expect(health.healthy).toBe(false);
      expect(health.agents.total).toBe(0);
      expect(health.agents.ready).toBe(0);

      await executor.close();
    });

    it('tracks active sessions count', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-2' });

      await executor.start();
      await executor.createSession('w1');
      await executor.createSession('w1');

      const health = await executor.health();
      expect(health.sessions.active).toBe(2);

      await executor.close();
    });
  });

  describe('resolveWorker()', () => {
    it('throws BridgeError UPSTREAM when agent is not found', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      try {
        await executor.createSession('nonexistent-agent');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('Worker not found');
        expect(bridgeErr.message).toContain('nonexistent-agent');
      }

      await executor.close();
    });

    it('throws BridgeError UPSTREAM when no workers are registered and agentId is omitted', async () => {
      const executor = createSilentWorkerExecutor();

      await executor.start();
      try {
        await executor.createSession();
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('No workers registered');
      }

      await executor.close();
    });

    it('defaults to first worker when agentId is omitted', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['a.js'] });
      executor.addWorker({ id: 'w2', command: 'node', args: ['b.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });

      await executor.start();
      const session = await executor.createSession();

      // Should have used w1 (first worker)
      expect(mockBusInstance.request).toHaveBeenCalledWith(
        'session/new',
        { agentId: 'w1' },
        expect.any(Object),
      );
      expect(session.agentId).toBe('w1');

      await executor.close();
    });
  });

  describe('wrapBusError()', () => {
    it('passes through BridgeError instances unchanged', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      // Make bus.request throw a BridgeError (e.g. from response validation)
      const originalError = BridgeError.upstream('Invalid worker response: missing sessionId');
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValue(originalError);

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        // Should be the exact same BridgeError, not re-wrapped
        expect(err).toBe(originalError);
      }

      await executor.close();
    });

    it('wraps non-Error values in BridgeError.upstream', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      // eslint-disable-next-line prefer-promise-reject-errors
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValue('string error');

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.cause?.message).toBe('string error');
      }

      await executor.close();
    });
  });

  describe('prompt() session status tracking', () => {
    it('sets session status to busy during prompt and idle after success', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ text: 'hi', stopReason: 'end_turn' });

      await executor.start();
      await executor.createSession('w1');
      await executor.prompt('sess-1', 'hello');

      // After successful prompt, session should be idle
      const session = await executor.getSession('sess-1');
      expect(session.status).toBe('idle');

      await executor.close();
    });

    it('sets session status to failed when prompt errors', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockRejectedValueOnce(new Error('crash'));

      await executor.start();
      await executor.createSession('w1');

      try {
        await executor.prompt('sess-1', 'hello');
      } catch {
        // expected
      }

      const session = await executor.getSession('sess-1');
      expect(session.status).toBe('failed');

      await executor.close();
    });

    it('throws BridgeError UPSTREAM when prompt session does not exist', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });

      await executor.start();
      try {
        await executor.prompt('nonexistent', 'hello');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toContain('Session not found');
      }

      await executor.close();
    });
  });

  describe('createSession() with metadata', () => {
    it('attaches metadata to the session entry', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });

      await executor.start();
      const session = await executor.createSession('w1', { provider: 'openai' });

      expect(session.metadata).toEqual({ provider: 'openai' });

      await executor.close();
    });

    it('omits metadata from session entry when not provided', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });

      await executor.start();
      const session = await executor.createSession('w1');

      expect(session.metadata).toBeUndefined();

      await executor.close();
    });
  });

  describe('response validation', () => {
    it('throws on missing sessionId in createSession response', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValue({ something: 'else' });

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toBe('Invalid worker response: missing sessionId');
      }
      await executor.close();
    });

    it('throws on empty sessionId in createSession response', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValue({ sessionId: '' });

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toBe('Invalid worker response: missing sessionId');
      }
      await executor.close();
    });

    it('throws on missing text in prompt response', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ stopReason: 'end_turn' });

      await executor.start();
      await executor.createSession('w1');
      try {
        await executor.prompt('sess-1', 'hello');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toBe('Invalid worker response: malformed prompt result');
      }
      await executor.close();
    });

    it('throws on missing stopReason in prompt response', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ text: 'hello' });

      await executor.start();
      await executor.createSession('w1');
      try {
        await executor.prompt('sess-1', 'hello');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toBe('Invalid worker response: malformed prompt result');
      }
      await executor.close();
    });

    it('throws on null response from worker in createSession', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValue(null);

      await executor.start();
      try {
        await executor.createSession('w1');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toBe('Invalid worker response: missing sessionId');
      }
      await executor.close();
    });

    it('throws on null response from worker in prompt', async () => {
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'] });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce({ sessionId: 'sess-1' });
      (mockBusInstance.request as jest.Mock<any>).mockResolvedValueOnce(null);

      await executor.start();
      await executor.createSession('w1');
      try {
        await executor.prompt('sess-1', 'hello');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        const bridgeErr = err as BridgeErrorType;
        expect(bridgeErr.type).toBe('UPSTREAM');
        expect(bridgeErr.message).toBe('Invalid worker response: malformed prompt result');
      }
      await executor.close();
    });
  });
});
