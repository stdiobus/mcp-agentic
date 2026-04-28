/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import type { AgentHandler } from '../../../src/agent/AgentHandler.js';

// ─── Module-level variables populated in beforeAll ────────────────

let McpAgenticServer: typeof import('../../../src/server/McpAgenticServer.js').McpAgenticServer;
let InProcessExecutor: typeof import('../../../src/executor/InProcessExecutor.js').InProcessExecutor;
let MockStdioBus: jest.MockedClass<typeof import('@stdiobus/node').StdioBus>;

let mockRegisterTool: jest.Mock;
let mockConnect: jest.Mock;
let mockClose: jest.Mock;
let MockMcpServerClass: jest.Mock;
let MockStdioTransport: jest.Mock;

let mockBusInstance: { start: jest.Mock; stop: jest.Mock; request: jest.Mock };

// Track registered tool callbacks for invoking in tests
let registeredTools: Map<string, { config: any; callback: (...args: any[]) => any }>;

// ─── ESM mock setup + dynamic imports in beforeAll ────────────────

beforeAll(async () => {
  jest.unstable_mockModule('@stdiobus/node', () => ({
    StdioBus: jest.fn(),
    __esModule: true,
  }));

  jest.unstable_mockModule('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: jest.fn(),
    __esModule: true,
  }));

  jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: jest.fn(),
    __esModule: true,
  }));

  const stdiobusModule = await import('@stdiobus/node');
  const mcpServerModule = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const mcpStdioModule = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const mcpAgenticModule = await import('../../../src/server/McpAgenticServer.js');
  const inProcessModule = await import('../../../src/executor/InProcessExecutor.js');

  MockStdioBus = stdiobusModule.StdioBus as jest.MockedClass<typeof stdiobusModule.StdioBus>;
  MockMcpServerClass = mcpServerModule.McpServer as unknown as jest.Mock;
  MockStdioTransport = mcpStdioModule.StdioServerTransport as unknown as jest.Mock;
  McpAgenticServer = mcpAgenticModule.McpAgenticServer;
  InProcessExecutor = inProcessModule.InProcessExecutor;
});

beforeEach(() => {
  registeredTools = new Map();

  // Re-apply mock implementations (resetMocks: true clears them between tests)
  mockRegisterTool = jest.fn<any>().mockImplementation((name: string, config: any, callback: any) => {
    registeredTools.set(name, { config, callback });
    return { enabled: true, enable: jest.fn(), disable: jest.fn(), remove: jest.fn(), update: jest.fn() };
  });
  mockConnect = jest.fn<any>().mockResolvedValue(undefined);
  mockClose = jest.fn<any>().mockResolvedValue(undefined);

  MockMcpServerClass.mockImplementation(() => ({
    registerTool: mockRegisterTool,
    connect: mockConnect,
    close: mockClose,
  }));

  MockStdioTransport.mockImplementation(() => ({}));

  mockBusInstance = {
    start: jest.fn<any>().mockResolvedValue(undefined),
    stop: jest.fn<any>().mockResolvedValue(undefined),
    request: jest.fn<any>().mockResolvedValue({ sessionId: 'worker-session-id' }),
  };

  MockStdioBus.mockImplementation(() => mockBusInstance as any);
});

// ─── Helpers ──────────────────────────────────────────────────────

function createMockAgent(
  id: string,
  capabilities: string[] = [],
  overrides: Partial<Pick<AgentHandler, 'prompt' | 'onSessionCreate' | 'onSessionClose'>> = {},
): AgentHandler {
  return {
    id,
    capabilities,
    prompt: overrides.prompt ?? jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    ...(overrides.onSessionCreate !== undefined ? { onSessionCreate: overrides.onSessionCreate } : {}),
    ...(overrides.onSessionClose !== undefined ? { onSessionClose: overrides.onSessionClose } : {}),
  };
}

const arbNonEmptyString = fc.string({ minLength: 1, maxLength: 32 }).filter(s => s.trim().length > 0);

// ─── Property Tests ───────────────────────────────────────────────

describe('McpAgenticServer — Property Tests', () => {
  it('Property 12: In-process agent priority over workers — in-process preferred when ID exists in both', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (agentId) => {
        // Reset per-iteration state
        mockBusInstance.request.mockClear();
        mockBusInstance.request.mockResolvedValue({ sessionId: 'worker-session-id' });

        const onSessionCreate = jest.fn<any>().mockResolvedValue(undefined);

        const inProcessAgent = createMockAgent(agentId, ['test'], {
          onSessionCreate,
          prompt: jest.fn<any>().mockResolvedValue({ text: 'in-process-response', stopReason: 'end_turn' }),
        });

        const server = new McpAgenticServer({ silent: true });
        server.register(inProcessAgent);
        server.registerWorker({ id: agentId, command: 'node', args: ['worker.js'] });

        await server.startStdio();

        // Get the sessions_create tool callback registered via McpServer.registerTool
        const sessionsCreateTool = registeredTools.get('sessions_create');
        expect(sessionsCreateTool).toBeDefined();

        // Call sessions_create with the shared agent ID
        const result = await sessionsCreateTool!.callback({ agentId });

        // In-process agent's onSessionCreate should have been called
        expect(onSessionCreate).toHaveBeenCalledTimes(1);

        // Worker's bus.request should NOT have been called for session/new
        const sessionNewCalls = mockBusInstance.request.mock.calls.filter(
          (call: any[]) => call[0] === 'session/new',
        );
        expect(sessionNewCalls).toHaveLength(0);

        // Result should contain the agent ID from in-process executor
        const parsedResult = JSON.parse(result.content[0].text);
        expect(parsedResult.agentId).toBe(agentId);

        await server.close();
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Unit Tests ───────────────────────────────────────────────────

describe('McpAgenticServer — Unit Tests', () => {
  it('register() returns this for chaining', () => {
    const server = new McpAgenticServer({ silent: true });
    const agent = createMockAgent('agent-1');
    const result = server.register(agent);
    expect(result).toBe(server);
  });

  it('registerWorker() returns this for chaining', () => {
    const server = new McpAgenticServer({ silent: true });
    const result = server.registerWorker({ id: 'w1', command: 'node', args: ['w.js'] });
    expect(result).toBe(server);
  });

  it('registerWorker() lazily creates WorkerExecutor — StdioBus not constructed until start', async () => {
    MockStdioBus.mockClear();
    const server = new McpAgenticServer({ silent: true });
    server.registerWorker({ id: 'w1', command: 'node', args: ['w.js'] });

    // StdioBus should not be constructed yet
    expect(MockStdioBus).not.toHaveBeenCalled();

    await server.startStdio();

    // Now StdioBus should be constructed
    expect(MockStdioBus).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it('all 8 tools are registered on MCP server via registerTool', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new McpAgenticServer({ silent: true });

    // registerTool should have been called 8 times (one per tool)
    expect(mockRegisterTool.mock.calls.length).toBe(8);

    // Verify all 8 tool names are registered
    const toolNames = mockRegisterTool.mock.calls.map((call: any[]) => call[0]);
    expect(toolNames).toContain('bridge_health');
    expect(toolNames).toContain('agents_discover');
    expect(toolNames).toContain('sessions_create');
    expect(toolNames).toContain('sessions_prompt');
    expect(toolNames).toContain('sessions_status');
    expect(toolNames).toContain('sessions_close');
    expect(toolNames).toContain('sessions_cancel');
    expect(toolNames).toContain('tasks_delegate');
  });

  it('lifecycle — startStdio and close work without errors', async () => {
    const server = new McpAgenticServer({ silent: true });
    const agent = createMockAgent('test-agent');
    server.register(agent);

    await server.startStdio();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await server.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

// ─── Executor Cache Tests ─────────────────────────────────────────

describe('McpAgenticServer — Executor Cache', () => {
  it('cache hit avoids discover() call on subsequent resolveExecutor', async () => {
    const agent = createMockAgent('cached-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    const server = new McpAgenticServer({ silent: true });
    server.register(agent);

    await server.startStdio();

    // Spy on InProcessExecutor.prototype.discover after startup
    const discoverSpy = jest.spyOn(InProcessExecutor.prototype, 'discover');

    // First call to sessions_create — may trigger discover() on cache miss
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    discoverSpy.mockClear();

    await sessionsCreateTool.callback({ agentId: 'cached-agent' });

    // The cache was populated during startStdio(), so discover() should NOT be called
    expect(discoverSpy).not.toHaveBeenCalled();

    // Second call — still cached, still no discover()
    discoverSpy.mockClear();
    await sessionsCreateTool.callback({ agentId: 'cached-agent' });
    expect(discoverSpy).not.toHaveBeenCalled();

    discoverSpy.mockRestore();
    await server.close();
  });

  it('cache invalidated after register() — discover() called on next resolve', async () => {
    const agent1 = createMockAgent('agent-1', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    const server = new McpAgenticServer({ silent: true });
    server.register(agent1);

    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // Verify cache is populated — no discover() needed
    const discoverSpy = jest.spyOn(InProcessExecutor.prototype, 'discover');
    discoverSpy.mockClear();

    await sessionsCreateTool.callback({ agentId: 'agent-1' });
    expect(discoverSpy).not.toHaveBeenCalled();

    // Register a new agent — this should invalidate the cache
    const agent2 = createMockAgent('agent-2', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });
    server.register(agent2);

    // Next resolve should call discover() because cache was cleared
    discoverSpy.mockClear();
    await sessionsCreateTool.callback({ agentId: 'agent-2' });
    expect(discoverSpy).toHaveBeenCalled();

    discoverSpy.mockRestore();
    await server.close();
  });

  it('cache invalidated after registerWorker()', async () => {
    const agent = createMockAgent('agent-1', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    const server = new McpAgenticServer({ silent: true });
    server.register(agent);

    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // Verify cache is populated
    const discoverSpy = jest.spyOn(InProcessExecutor.prototype, 'discover');
    discoverSpy.mockClear();

    await sessionsCreateTool.callback({ agentId: 'agent-1' });
    expect(discoverSpy).not.toHaveBeenCalled();

    // Register a worker — this should invalidate the cache
    server.registerWorker({ id: 'worker-1', command: 'node', args: ['w.js'] });

    // Next resolve should call discover() because cache was cleared
    discoverSpy.mockClear();
    await sessionsCreateTool.callback({ agentId: 'agent-1' });
    expect(discoverSpy).toHaveBeenCalled();

    discoverSpy.mockRestore();
    await server.close();
  });

  it('cache populated on startStdio() with in-process agents taking priority', async () => {
    const onSessionCreate = jest.fn<any>().mockResolvedValue(undefined);
    const agent = createMockAgent('shared-id', ['test'], {
      onSessionCreate,
      prompt: jest.fn<any>().mockResolvedValue({ text: 'in-process', stopReason: 'end_turn' }),
    });

    const server = new McpAgenticServer({ silent: true });
    server.register(agent);
    server.registerWorker({ id: 'shared-id', command: 'node', args: ['w.js'] });

    await server.startStdio();

    // Spy on discover — should not be called since cache is populated
    const discoverSpy = jest.spyOn(InProcessExecutor.prototype, 'discover');
    discoverSpy.mockClear();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const result = await sessionsCreateTool.callback({ agentId: 'shared-id' });

    // Cache hit — no discover() call
    expect(discoverSpy).not.toHaveBeenCalled();

    // In-process agent should be used (priority over worker)
    expect(onSessionCreate).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.agentId).toBe('shared-id');

    discoverSpy.mockRestore();
    await server.close();
  });
});

// ─── Backpressure Tests ───────────────────────────────────────────

describe('McpAgenticServer — Backpressure', () => {
  it('requests within limit succeed', async () => {
    const agent = createMockAgent('bp-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    const server = new McpAgenticServer({ maxConcurrentRequests: 5, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // Fire 5 sequential requests — all should succeed
    for (let i = 0; i < 5; i++) {
      const result = await sessionsCreateTool.callback({ agentId: 'bp-agent' });
      expect(result.content[0].text).toBeDefined();
    }

    await server.close();
  });

  it('requests over limit get retryable transport error', async () => {
    // Create an agent whose onSessionCreate blocks until we release it
    let resolveBlock: (() => void) | undefined;
    const blockPromise = new Promise<void>((resolve) => { resolveBlock = resolve; });

    const agent = createMockAgent('bp-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockImplementation(() => blockPromise),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    const server = new McpAgenticServer({ maxConcurrentRequests: 2, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // Start 2 requests that will block (filling the limit)
    const pending1 = sessionsCreateTool.callback({ agentId: 'bp-agent' });
    const pending2 = sessionsCreateTool.callback({ agentId: 'bp-agent' });

    // The 3rd request should be rejected immediately
    await expect(sessionsCreateTool.callback({ agentId: 'bp-agent' }))
      .rejects.toThrow('Server overloaded');

    // Verify the error is a BridgeError with retryable: true
    try {
      await sessionsCreateTool.callback({ agentId: 'bp-agent' });
    } catch (err: any) {
      expect(err.name).toBe('BridgeError');
      expect(err.type).toBe('TRANSPORT');
      expect(err.details.retryable).toBe(true);
    }

    // Release the blocked requests
    resolveBlock!();
    await pending1;
    await pending2;

    await server.close();
  });

  it('counter decrements after request completes — slot freed for next request', async () => {
    let callCount = 0;
    const agent = createMockAgent('bp-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockImplementation(async () => { callCount++; }),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    const server = new McpAgenticServer({ maxConcurrentRequests: 1, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // First request completes, freeing the slot
    await sessionsCreateTool.callback({ agentId: 'bp-agent' });
    expect(callCount).toBe(1);

    // Second request should succeed because the first one completed
    await sessionsCreateTool.callback({ agentId: 'bp-agent' });
    expect(callCount).toBe(2);

    await server.close();
  });

  it('counter decrements even when handler throws', async () => {
    const agent = createMockAgent('bp-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockRejectedValue(new Error('agent boom')),
    });

    const server = new McpAgenticServer({ maxConcurrentRequests: 1, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // First request fails (agent throws, but tool handler catches and returns error response)
    const errorResult = await sessionsCreateTool.callback({ agentId: 'bp-agent' });
    const parsed = JSON.parse(errorResult.content[0].text);
    expect(parsed.error).toBeDefined();

    // The slot should be freed — next request should not get "Server overloaded"
    // It will still return an error response because the agent throws, but NOT "Server overloaded"
    const errorResult2 = await sessionsCreateTool.callback({ agentId: 'bp-agent' });
    const parsed2 = JSON.parse(errorResult2.content[0].text);
    expect(parsed2.error).toBeDefined();
    expect(parsed2.error).not.toContain('Server overloaded');

    await server.close();
  });

  it('default maxConcurrentRequests is 50', async () => {
    const agent = createMockAgent('bp-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    // No maxConcurrentRequests in config — should default to 50
    const server = new McpAgenticServer({ silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;

    // 50 sequential requests should all succeed
    for (let i = 0; i < 50; i++) {
      await sessionsCreateTool.callback({ agentId: 'bp-agent' });
    }

    await server.close();
  });
});

// ─── Input Size Validation Tests ──────────────────────────────────

describe('McpAgenticServer — Input Size Validation', () => {
  it('prompt within limit passes for sessions_prompt', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    // 1 KiB limit for easy testing
    const server = new McpAgenticServer({ maxPromptBytes: 1024, silent: true });
    server.register(agent);
    await server.startStdio();

    // Create a session first
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'size-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send a prompt within the limit
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    const result = await sessionsPromptTool.callback({ sessionId, prompt: 'Hello' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.text).toBe('ok');

    await server.close();
  });

  it('prompt over limit rejected for sessions_prompt', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    // Very small limit: 10 bytes
    const server = new McpAgenticServer({ maxPromptBytes: 10, silent: true });
    server.register(agent);
    await server.startStdio();

    // Create a session first
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'size-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send a prompt that exceeds the limit
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    await expect(
      sessionsPromptTool.callback({ sessionId, prompt: 'A'.repeat(100) }),
    ).rejects.toThrow('Prompt exceeds maximum size');

    await server.close();
  });

  it('prompt over limit rejected for tasks_delegate', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    // Very small limit: 10 bytes
    const server = new McpAgenticServer({ maxPromptBytes: 10, silent: true });
    server.register(agent);
    await server.startStdio();

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    await expect(
      tasksDelegateTool.callback({ prompt: 'A'.repeat(100), agentId: 'size-agent' }),
    ).rejects.toThrow('Prompt exceeds maximum size');

    await server.close();
  });

  it('metadata over limit rejected for sessions_create', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    // Very small metadata limit: 10 bytes
    const server = new McpAgenticServer({ maxMetadataBytes: 10, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    // Large metadata object that serializes to more than 10 bytes
    const bigMetadata = { key: 'A'.repeat(100) };
    await expect(
      sessionsCreateTool.callback({ agentId: 'size-agent', metadata: bigMetadata }),
    ).rejects.toThrow('Metadata exceeds maximum size');

    await server.close();
  });

  it('metadata over limit rejected for tasks_delegate', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    // Very small metadata limit: 10 bytes
    const server = new McpAgenticServer({ maxMetadataBytes: 10, silent: true });
    server.register(agent);
    await server.startStdio();

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    const bigMetadata = { key: 'A'.repeat(100) };
    await expect(
      tasksDelegateTool.callback({ prompt: 'hi', agentId: 'size-agent', metadata: bigMetadata }),
    ).rejects.toThrow('Metadata exceeds maximum size');

    await server.close();
  });

  it('metadata within limit passes for sessions_create', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    // 1 KiB limit
    const server = new McpAgenticServer({ maxMetadataBytes: 1024, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    // Small metadata that fits within 1 KiB
    const result = await sessionsCreateTool.callback({ agentId: 'size-agent', metadata: { foo: 'bar' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBeDefined();

    await server.close();
  });

  it('no metadata does not trigger validation', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
    });

    // Very small metadata limit, but no metadata provided
    const server = new McpAgenticServer({ maxMetadataBytes: 1, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const result = await sessionsCreateTool.callback({ agentId: 'size-agent' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBeDefined();

    await server.close();
  });

  it('default maxPromptBytes is 1048576 (1 MiB)', () => {
    // Construct without config — defaults should apply
    // We verify by sending a prompt just under 1 MiB (should not throw)
    // This is a construction-time check; the actual validation is tested above
    const server = new McpAgenticServer({ silent: true });
    // Access private field via any cast for verification
    expect((server as any).maxPromptBytes).toBe(1_048_576);
  });

  it('default maxMetadataBytes is 65536 (64 KiB)', () => {
    const server = new McpAgenticServer({ silent: true });
    expect((server as any).maxMetadataBytes).toBe(65_536);
  });

  it('BridgeError thrown for oversized prompt has UPSTREAM type', async () => {
    const agent = createMockAgent('size-agent', ['test'], {
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      prompt: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    });

    const server = new McpAgenticServer({ maxPromptBytes: 5, silent: true });
    server.register(agent);
    await server.startStdio();

    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'size-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    try {
      await sessionsPromptTool.callback({ sessionId, prompt: 'A'.repeat(100) });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe('BridgeError');
      expect(err.type).toBe('UPSTREAM');
      expect(err.message).toBe('Prompt exceeds maximum size');
    }

    await server.close();
  });
});
