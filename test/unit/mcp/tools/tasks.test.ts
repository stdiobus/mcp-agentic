/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { jest, describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { handleTasksDelegate } from '../../../../src/mcp/tools/tasks.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { createMockExecutor } from './_mockExecutor.js';

// ─── Property Tests ───────────────────────────────────────────────

describe('tasks_delegate — Property Tests', () => {
  it('Property 8: tasks_delegate calls createSession, prompt, closeSession in strict order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        async (promptText) => {
          const callOrder: string[] = [];

          const executor = createMockExecutor({
            createSession: jest.fn<any>().mockImplementation(async () => {
              callOrder.push('createSession');
              return {
                sessionId: 'sess-1',
                agentId: 'agent-1',
                status: 'active',
                createdAt: 1700000000000,
                lastActivityAt: 1700000000000,
              };
            }),
            prompt: jest.fn<any>().mockImplementation(async () => {
              callOrder.push('prompt');
              return { text: 'ok', stopReason: 'end_turn' };
            }),
            closeSession: jest.fn<any>().mockImplementation(async () => {
              callOrder.push('closeSession');
            }),
          });

          await handleTasksDelegate(executor, { prompt: promptText });

          expect(callOrder).toEqual(['createSession', 'prompt', 'closeSession']);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 9: BridgeError instances mapped to correct MCP error codes', async () => {
    const errorTypes: Array<{ factory: (msg: string) => BridgeError; expectedCode: number }> = [
      { factory: (m) => BridgeError.config(m), expectedCode: -32004 },
      { factory: (m) => BridgeError.upstream(m), expectedCode: -32002 },
      { factory: (m) => BridgeError.transport(m), expectedCode: -32000 },
      { factory: (m) => BridgeError.timeout(m), expectedCode: -32001 },
      { factory: (m) => BridgeError.internal(m), expectedCode: -32603 },
      { factory: (m) => BridgeError.auth(m), expectedCode: -32003 },
      { factory: (m) => BridgeError.protocol(m), expectedCode: -32000 },
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 0, max: errorTypes.length - 1 }),
        async (errorMessage, errorTypeIndex) => {
          const { factory, expectedCode } = errorTypes[errorTypeIndex]!;
          const error = factory(errorMessage);

          const executor = createMockExecutor({
            createSession: jest.fn<any>().mockRejectedValue(error),
          });

          const result = await handleTasksDelegate(executor, { prompt: 'test' });
          const parsed = JSON.parse(result.content[0]!.text);

          expect(parsed.success).toBe(false);
          expect(parsed.code).toBe(expectedCode);
          expect(parsed.error).toBe(errorMessage);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 9 (extension): non-BridgeError maps to internal error code', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        async (errorMessage) => {
          const executor = createMockExecutor({
            createSession: jest.fn<any>().mockRejectedValue(new Error(errorMessage)),
          });

          const result = await handleTasksDelegate(executor, { prompt: 'test' });
          const parsed = JSON.parse(result.content[0]!.text);

          expect(parsed.success).toBe(false);
          expect(parsed.code).toBe(-32603); // INTERNAL_ERROR
          expect(parsed.error).toBe(errorMessage);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Unit Tests ───────────────────────────────────────────────────

describe('tasks_delegate — Unit Tests', () => {
  it('delegates to executor and returns combined result', async () => {
    const executor = createMockExecutor();
    const result = await handleTasksDelegate(executor, {
      prompt: 'Do something',
      agentId: 'my-agent',
      metadata: { key: 'val' },
    });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.createSession).toHaveBeenCalledWith('my-agent', { key: 'val' });
    expect(executor.prompt).toHaveBeenCalledWith('sess-1', 'Do something', {});
    expect(executor.closeSession).toHaveBeenCalledWith('sess-1', 'task-complete');
    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe('response');
  });

  it('passes timeout to executor.prompt', async () => {
    const executor = createMockExecutor();
    await handleTasksDelegate(executor, {
      prompt: 'Do something',
      timeout: 5000,
    });

    expect(executor.prompt).toHaveBeenCalledWith('sess-1', 'Do something', { timeout: 5000 });
  });

  it('cleanup on prompt error — closeSession still called', async () => {
    const executor = createMockExecutor({
      prompt: jest.fn<any>().mockRejectedValue(new Error('Agent crashed')),
    });

    const result = await handleTasksDelegate(executor, { prompt: 'test' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.success).toBe(false);
    // closeSession should have been called for cleanup
    expect(executor.closeSession).toHaveBeenCalledWith('sess-1', 'task-failed');
  });

  it('cleanup on createSession error — no closeSession attempt', async () => {
    const executor = createMockExecutor({
      createSession: jest.fn<any>().mockRejectedValue(
        BridgeError.upstream('Agent not found'),
      ),
    });

    const result = await handleTasksDelegate(executor, { prompt: 'test' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.success).toBe(false);
    // closeSession should NOT have been called (no session was created)
    expect(executor.closeSession).not.toHaveBeenCalled();
  });
});
