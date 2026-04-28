/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { jest, describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  handleSessionsCreate,
  handleSessionsPrompt,
  handleSessionsStatus,
  handleSessionsClose,
  handleSessionsCancel,
} from '../../../../src/mcp/tools/sessions.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { createMockExecutor } from './_mockExecutor.js';

// ─── Property Tests ───────────────────────────────────────────────

describe('sessions handlers — Property Tests', () => {
  it('Property 7 (partial): sessions_create serializes executor response as JSON with all fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.constantFrom('active', 'idle', 'busy') as fc.Arbitrary<string>,
        fc.nat(),
        async (sessionId, agentId, status, createdAt) => {
          const executor = createMockExecutor({
            createSession: jest.fn<any>().mockResolvedValue({
              sessionId,
              agentId,
              status,
              createdAt,
              lastActivityAt: createdAt,
            }),
          });

          const result = await handleSessionsCreate(executor, {});
          const parsed = JSON.parse(result.content[0]!.text);

          expect(parsed.sessionId).toBe(sessionId);
          expect(parsed.agentId).toBe(agentId);
          expect(parsed.status).toBe(status);
          expect(parsed.createdAt).toBe(createdAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 7 (partial): sessions_prompt serializes executor response as JSON with all fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom('end_turn', 'max_turns', 'cancelled') as fc.Arbitrary<string>,
        fc.option(fc.string(), { nil: undefined }),
        async (text, stopReason, requestId) => {
          const mockResult: Record<string, unknown> = { text, stopReason };
          if (requestId !== undefined) {
            mockResult['requestId'] = requestId;
          }

          const executor = createMockExecutor({
            prompt: jest.fn<any>().mockResolvedValue(mockResult),
          });

          const result = await handleSessionsPrompt(executor, {
            sessionId: 'sess-1',
            prompt: 'test',
          });
          const parsed = JSON.parse(result.content[0]!.text);

          expect(parsed.text).toBe(text);
          expect(parsed.stopReason).toBe(stopReason);
          if (requestId !== undefined) {
            expect(parsed.requestId).toBe(requestId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Unit Tests ───────────────────────────────────────────────────

describe('sessions handlers — Unit Tests', () => {
  it('handleSessionsCreate delegates to executor.createSession', async () => {
    const executor = createMockExecutor();
    const result = await handleSessionsCreate(executor, { agentId: 'my-agent', metadata: { key: 'val' } });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.createSession).toHaveBeenCalledWith('my-agent', { key: 'val' });
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.agentId).toBe('agent-1');
  });

  it('handleSessionsCreate uses workerId as fallback for agentId', async () => {
    const executor = createMockExecutor();
    await handleSessionsCreate(executor, { workerId: 'worker-1' });

    expect(executor.createSession).toHaveBeenCalledWith('worker-1', undefined);
  });

  it('handleSessionsPrompt delegates to executor.prompt with timeout', async () => {
    const executor = createMockExecutor();
    const result = await handleSessionsPrompt(executor, {
      sessionId: 'sess-1',
      prompt: 'Hello',
      timeout: 5000,
    });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.prompt).toHaveBeenCalledWith('sess-1', 'Hello', { timeout: 5000 });
    expect(parsed.text).toBe('response');
    expect(parsed.stopReason).toBe('end_turn');
  });

  it('handleSessionsStatus delegates to executor.getSession', async () => {
    const executor = createMockExecutor();
    const result = await handleSessionsStatus(executor, { sessionId: 'sess-1' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.getSession).toHaveBeenCalledWith('sess-1');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.status).toBe('idle');
  });

  it('handleSessionsClose delegates to executor.closeSession', async () => {
    const executor = createMockExecutor();
    const result = await handleSessionsClose(executor, { sessionId: 'sess-1', reason: 'done' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.closeSession).toHaveBeenCalledWith('sess-1', 'done');
    expect(parsed.closed).toBe(true);
  });

  it('handleSessionsCancel delegates to executor.cancel', async () => {
    const executor = createMockExecutor();
    const result = await handleSessionsCancel(executor, { sessionId: 'sess-1', requestId: 'req-1' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(executor.cancel).toHaveBeenCalledWith('sess-1', 'req-1');
    expect(parsed.cancelled).toBe(true);
  });

  it('error responses use mapErrorToMCP', async () => {
    const executor = createMockExecutor({
      createSession: jest.fn<any>().mockRejectedValue(
        BridgeError.upstream('Agent not found: bad-agent'),
      ),
    });

    const result = await handleSessionsCreate(executor, { agentId: 'bad-agent' });
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.error).toContain('Agent not found');
    expect(parsed.code).toBe(-32002); // UPSTREAM_ERROR
  });
});
