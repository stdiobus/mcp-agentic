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
          if (workerCfg.env !== undefined) {
            expect(pool.env).toEqual(workerCfg.env);
          } else {
            expect(pool.env).toBeUndefined();
          }
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
    it('passes env from WorkerConfig to StdioBus pool config', async () => {
      const env = { API_KEY: 'secret-123', NODE_ENV: 'production' };
      const executor = createSilentWorkerExecutor();
      executor.addWorker({ id: 'w1', command: 'node', args: ['srv.js'], env });

      await executor.start();
      expect(capturedBusConfig).toBeDefined();
      expect(capturedBusConfig.config.pools[0].env).toEqual(env);
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
