import { jest, describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { handleBridgeHealth } from '../../../../src/mcp/tools/health.js';
import { createMockExecutor } from './_mockExecutor.js';

describe('health handler — Property Tests', () => {
  it('Property 7 (partial): health response serializes all HealthInfo fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.nat({ max: 100 }),
        fc.nat({ max: 100 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 500 }),
        fc.nat(),
        async (healthy, agentsTotal, agentsReady, sessionsActive, sessionsCap, uptime) => {
          const executor = createMockExecutor({
            health: jest.fn<any>().mockResolvedValue({
              healthy,
              agents: { total: agentsTotal, ready: agentsReady },
              sessions: { active: sessionsActive, capacity: sessionsCap },
              uptime,
            }),
          });

          const result = await handleBridgeHealth(executor);
          const parsed = JSON.parse(result.content[0]!.text);

          expect(parsed.healthy).toBe(healthy);
          expect(parsed.agents.total).toBe(agentsTotal);
          expect(parsed.agents.ready).toBe(agentsReady);
          expect(parsed.sessions.active).toBe(sessionsActive);
          expect(parsed.sessions.capacity).toBe(sessionsCap);
          expect(parsed.uptime).toBe(uptime);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('health handler — Unit Tests', () => {
  it('delegates to executor.health()', async () => {
    const executor = createMockExecutor();
    const result = await handleBridgeHealth(executor);
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.health).toHaveBeenCalledTimes(1);
    expect(parsed.healthy).toBe(true);
  });

  it('returns error response on executor failure', async () => {
    const executor = createMockExecutor({
      health: jest.fn<any>().mockRejectedValue(new Error('Executor down')),
    });

    const result = await handleBridgeHealth(executor);
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.error).toBe('Executor down');
    expect(parsed.code).toBe(-32603);
    expect(parsed.data).toEqual({ type: 'INTERNAL', retryable: false });
  });
});
