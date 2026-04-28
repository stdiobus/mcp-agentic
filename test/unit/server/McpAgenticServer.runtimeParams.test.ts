/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for runtimeParams flow through McpAgenticServer.
 *
 * Verifies that prompt-level runtimeParams passed via sessions_prompt and
 * tasks_delegate are correctly injected into MultiProviderCompanionAgent
 * via the duck-typing setPromptRuntimeParams mechanism.
 *
 * Feature: multi-provider-agents
 * Validates: Requirements 6.2, 6.3, 6.4
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import type { AIProvider, AIProviderResult, RuntimeParams, ChatMessage } from '../../../src/provider/AIProvider.js';

// ─── Module-level variables populated in beforeAll ────────────────

let McpAgenticServer: typeof import('../../../src/server/McpAgenticServer.js').McpAgenticServer;
let MultiProviderCompanionAgent: typeof import('../../../src/agent/MultiProviderCompanionAgent.js').MultiProviderCompanionAgent;
let ProviderRegistry: typeof import('../../../src/provider/ProviderRegistry.js').ProviderRegistry;

let mockRegisterTool: jest.Mock;
let mockConnect: jest.Mock;
let mockClose: jest.Mock;
let MockMcpServerClass: jest.Mock;
let MockStdioTransport: jest.Mock;

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

  const mcpServerModule = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const mcpStdioModule = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const mcpAgenticModule = await import('../../../src/server/McpAgenticServer.js');
  const multiProviderModule = await import('../../../src/agent/MultiProviderCompanionAgent.js');
  const registryModule = await import('../../../src/provider/ProviderRegistry.js');

  MockMcpServerClass = mcpServerModule.McpServer as unknown as jest.Mock;
  MockStdioTransport = mcpStdioModule.StdioServerTransport as unknown as jest.Mock;
  McpAgenticServer = mcpAgenticModule.McpAgenticServer;
  MultiProviderCompanionAgent = multiProviderModule.MultiProviderCompanionAgent;
  ProviderRegistry = registryModule.ProviderRegistry;
});

beforeEach(() => {
  registeredTools = new Map();

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
});

// ─── Helpers ──────────────────────────────────────────────────────

/** Create a mock AIProvider that records the params it receives. */
function createMockProvider(id: string): AIProvider & { completeCalls: Array<{ messages: ChatMessage[]; params: RuntimeParams }> } {
  const completeCalls: Array<{ messages: ChatMessage[]; params: RuntimeParams }> = [];

  return {
    id,
    models: ['test-model-1', 'test-model-2'] as const,
    completeCalls,
    async complete(messages: ChatMessage[], params: RuntimeParams, _signal?: AbortSignal): Promise<AIProviderResult> {
      completeCalls.push({ messages, params });
      return { text: `response from ${id}`, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
}

/** Set up a McpAgenticServer with a MultiProviderCompanionAgent and return test utilities. */
async function setupServer(options?: { systemPrompt?: string; defaults?: RuntimeParams }) {
  const registry = new ProviderRegistry();
  const mockProvider = createMockProvider('test-provider');
  registry.register(mockProvider);

  const agent = new MultiProviderCompanionAgent({
    id: 'multi-agent',
    defaultProviderId: 'test-provider',
    registry,
    capabilities: ['chat'],
    systemPrompt: options?.systemPrompt ?? 'You are a helpful assistant.',
    defaults: options?.defaults,
  });

  const server = new McpAgenticServer({ silent: true });
  server.register(agent);
  await server.startStdio();

  return { server, agent, mockProvider, registry };
}

// ─── Integration Tests: sessions_prompt with runtimeParams ────────

describe('McpAgenticServer — runtimeParams integration (sessions_prompt)', () => {
  it('passes runtimeParams to agent via setPromptRuntimeParams for sessions_prompt', async () => {
    const { server, mockProvider } = await setupServer();

    // Create a session
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'multi-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send prompt with runtimeParams
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    const runtimeParams = { temperature: 0.7, maxTokens: 500, model: 'test-model-2' };
    const result = await sessionsPromptTool.callback({
      sessionId,
      prompt: 'Hello',
      runtimeParams,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.text).toBe('response from test-provider');
    expect(parsed.stopReason).toBe('end_turn');

    // Verify the provider received the merged params
    expect(mockProvider.completeCalls).toHaveLength(1);
    const receivedParams = mockProvider.completeCalls[0].params;
    expect(receivedParams.temperature).toBe(0.7);
    expect(receivedParams.maxTokens).toBe(500);
    expect(receivedParams.model).toBe('test-model-2');

    await server.close();
  });

  it('prompt-level runtimeParams override session-level params', async () => {
    const { server, mockProvider } = await setupServer();

    // Create a session with session-level runtimeParams in metadata
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({
      agentId: 'multi-agent',
      metadata: {
        runtimeParams: { temperature: 0.3, maxTokens: 200, model: 'test-model-1' },
      },
    });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send prompt with prompt-level runtimeParams that override session-level
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    await sessionsPromptTool.callback({
      sessionId,
      prompt: 'Hello',
      runtimeParams: { temperature: 0.9, model: 'test-model-2' },
    });

    // Verify prompt-level params took priority
    expect(mockProvider.completeCalls).toHaveLength(1);
    const receivedParams = mockProvider.completeCalls[0].params;
    expect(receivedParams.temperature).toBe(0.9);
    expect(receivedParams.model).toBe('test-model-2');
    // Session-level maxTokens should still be present (not overridden)
    expect(receivedParams.maxTokens).toBe(200);

    await server.close();
  });

  it('sessions_prompt without runtimeParams works normally', async () => {
    const { server, mockProvider } = await setupServer();

    // Create a session
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'multi-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send prompt without runtimeParams
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    const result = await sessionsPromptTool.callback({
      sessionId,
      prompt: 'Hello',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.text).toBe('response from test-provider');

    // Provider should still be called with default/empty params
    expect(mockProvider.completeCalls).toHaveLength(1);

    await server.close();
  });

  it('runtimeParams systemPrompt overrides default systemPrompt', async () => {
    const { server, mockProvider } = await setupServer({ systemPrompt: 'Default system prompt' });

    // Create a session
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'multi-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send prompt with systemPrompt override
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    await sessionsPromptTool.callback({
      sessionId,
      prompt: 'Hello',
      runtimeParams: { systemPrompt: 'Custom system prompt' },
    });

    // Verify the custom system prompt was used in messages
    expect(mockProvider.completeCalls).toHaveLength(1);
    const messages = mockProvider.completeCalls[0].messages;
    const systemMessage = messages.find(m => m.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage!.content).toBe('Custom system prompt');

    await server.close();
  });

  it('runtimeParams with providerSpecific passes through to provider', async () => {
    const { server, mockProvider } = await setupServer();

    // Create a session
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'multi-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send prompt with providerSpecific params
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    await sessionsPromptTool.callback({
      sessionId,
      prompt: 'Hello',
      runtimeParams: { providerSpecific: { frequency_penalty: 0.5, presence_penalty: 0.3 } },
    });

    expect(mockProvider.completeCalls).toHaveLength(1);
    const receivedParams = mockProvider.completeCalls[0].params;
    expect(receivedParams.providerSpecific).toEqual({ frequency_penalty: 0.5, presence_penalty: 0.3 });

    await server.close();
  });
});

// ─── Integration Tests: tasks_delegate with runtimeParams ─────────

describe('McpAgenticServer — runtimeParams integration (tasks_delegate)', () => {
  it('passes runtimeParams to agent via beforePrompt hook for tasks_delegate', async () => {
    const { server, mockProvider } = await setupServer();

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    const result = await tasksDelegateTool.callback({
      prompt: 'Summarize this',
      agentId: 'multi-agent',
      runtimeParams: { temperature: 1.5, maxTokens: 1000 },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe('response from test-provider');

    // Verify the provider received the runtimeParams
    expect(mockProvider.completeCalls).toHaveLength(1);
    const receivedParams = mockProvider.completeCalls[0].params;
    expect(receivedParams.temperature).toBe(1.5);
    expect(receivedParams.maxTokens).toBe(1000);

    await server.close();
  });

  it('tasks_delegate without runtimeParams works normally', async () => {
    const { server, mockProvider } = await setupServer();

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    const result = await tasksDelegateTool.callback({
      prompt: 'Hello',
      agentId: 'multi-agent',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe('response from test-provider');

    // Provider should still be called
    expect(mockProvider.completeCalls).toHaveLength(1);

    await server.close();
  });

  it('tasks_delegate runtimeParams override config defaults', async () => {
    const { server, mockProvider } = await setupServer({
      defaults: { temperature: 0.1, maxTokens: 50 },
    });

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    await tasksDelegateTool.callback({
      prompt: 'Hello',
      agentId: 'multi-agent',
      runtimeParams: { temperature: 1.8 },
    });

    expect(mockProvider.completeCalls).toHaveLength(1);
    const receivedParams = mockProvider.completeCalls[0].params;
    // Prompt-level temperature should override config default
    expect(receivedParams.temperature).toBe(1.8);
    // Config default maxTokens should still be present
    expect(receivedParams.maxTokens).toBe(50);

    await server.close();
  });

  it('tasks_delegate with metadata.runtimeParams (session-level) and top-level runtimeParams (prompt-level)', async () => {
    const { server, mockProvider } = await setupServer();

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    await tasksDelegateTool.callback({
      prompt: 'Hello',
      agentId: 'multi-agent',
      metadata: {
        runtimeParams: { temperature: 0.5, maxTokens: 300 },
      },
      runtimeParams: { temperature: 1.2 },
    });

    expect(mockProvider.completeCalls).toHaveLength(1);
    const receivedParams = mockProvider.completeCalls[0].params;
    // Prompt-level temperature overrides session-level
    expect(receivedParams.temperature).toBe(1.2);
    // Session-level maxTokens should still be present
    expect(receivedParams.maxTokens).toBe(300);

    await server.close();
  });
});

// ─── Integration Tests: agent without setPromptRuntimeParams ──────

describe('McpAgenticServer — runtimeParams with non-multi-provider agent', () => {
  it('runtimeParams is silently ignored for agents without setPromptRuntimeParams', async () => {
    // Create a plain agent without setPromptRuntimeParams
    const plainAgent = {
      id: 'plain-agent',
      capabilities: ['chat'],
      prompt: jest.fn<any>().mockResolvedValue({ text: 'plain response', stopReason: 'end_turn' }),
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      onSessionClose: jest.fn<any>().mockResolvedValue(undefined),
    };

    const server = new McpAgenticServer({ silent: true });
    server.register(plainAgent);
    await server.startStdio();

    // Create a session
    const sessionsCreateTool = registeredTools.get('sessions_create')!;
    const createResult = await sessionsCreateTool.callback({ agentId: 'plain-agent' });
    const sessionId = JSON.parse(createResult.content[0].text).sessionId;

    // Send prompt with runtimeParams — should not throw
    const sessionsPromptTool = registeredTools.get('sessions_prompt')!;
    const result = await sessionsPromptTool.callback({
      sessionId,
      prompt: 'Hello',
      runtimeParams: { temperature: 0.7 },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.text).toBe('plain response');

    // Agent's prompt should have been called normally
    expect(plainAgent.prompt).toHaveBeenCalledTimes(1);

    await server.close();
  });

  it('tasks_delegate runtimeParams is silently ignored for plain agents', async () => {
    const plainAgent = {
      id: 'plain-agent',
      capabilities: ['chat'],
      prompt: jest.fn<any>().mockResolvedValue({ text: 'plain response', stopReason: 'end_turn' }),
      onSessionCreate: jest.fn<any>().mockResolvedValue(undefined),
      onSessionClose: jest.fn<any>().mockResolvedValue(undefined),
    };

    const server = new McpAgenticServer({ silent: true });
    server.register(plainAgent);
    await server.startStdio();

    const tasksDelegateTool = registeredTools.get('tasks_delegate')!;
    const result = await tasksDelegateTool.callback({
      prompt: 'Hello',
      agentId: 'plain-agent',
      runtimeParams: { temperature: 0.7 },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe('plain response');

    await server.close();
  });
});
