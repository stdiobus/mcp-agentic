import { jest, describe, it, expect } from '@jest/globals';
import { handleAgentsDiscover } from '../../../../src/mcp/tools/agents.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { createMockExecutor } from './_mockExecutor.js';

describe('agents_discover handler — Unit Tests', () => {
  it('delegates to executor.discover() without filter', async () => {
    const agents = [
      { id: 'agent-1', capabilities: ['chat'], status: 'ready' as const },
      { id: 'agent-2', capabilities: ['code'], status: 'ready' as const },
    ];
    const executor = createMockExecutor({
      discover: jest.fn<any>().mockResolvedValue(agents),
    });

    const result = await handleAgentsDiscover(executor, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.discover).toHaveBeenCalledWith(undefined);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0].id).toBe('agent-1');
  });

  it('delegates to executor.discover() with capability filter', async () => {
    const executor = createMockExecutor({
      discover: jest.fn<any>().mockResolvedValue([
        { id: 'agent-1', capabilities: ['chat'], status: 'ready' },
      ]),
    });

    const result = await handleAgentsDiscover(executor, { capability: 'chat' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.discover).toHaveBeenCalledWith('chat');
    expect(parsed.agents).toHaveLength(1);
  });

  it('ignores refresh parameter (backward compatibility)', async () => {
    const executor = createMockExecutor();
    await handleAgentsDiscover(executor, { refresh: true });

    // discover should be called without refresh parameter
    expect(executor.discover).toHaveBeenCalledWith(undefined);
  });

  it('returns error response on executor failure', async () => {
    const executor = createMockExecutor({
      discover: jest.fn<any>().mockRejectedValue(
        BridgeError.internal('Executor not started'),
      ),
    });

    const result = await handleAgentsDiscover(executor, {});
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.error).toContain('Executor not started');
    expect(parsed.code).toBe(-32603);
  });
});
