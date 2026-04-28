/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared mock AgentExecutor factory for tool handler tests.
 */

import { jest } from '@jest/globals';
import type { AgentExecutor } from '../../../../src/executor/AgentExecutor.js';

const FIXED_TIMESTAMP = 1700000000000;

export function createMockExecutor(overrides: Partial<Record<keyof AgentExecutor, unknown>> = {}): AgentExecutor {
  return {
    start: jest.fn<any>().mockResolvedValue(undefined),
    close: jest.fn<any>().mockResolvedValue(undefined),
    isReady: jest.fn<any>().mockReturnValue(true),
    discover: jest.fn<any>().mockResolvedValue([]),
    createSession: jest.fn<any>().mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      status: 'active',
      createdAt: FIXED_TIMESTAMP,
      lastActivityAt: FIXED_TIMESTAMP,
    }),
    getSession: jest.fn<any>().mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      status: 'idle',
      createdAt: FIXED_TIMESTAMP,
      lastActivityAt: FIXED_TIMESTAMP,
    }),
    closeSession: jest.fn<any>().mockResolvedValue(undefined),
    prompt: jest.fn<any>().mockResolvedValue({
      text: 'response',
      stopReason: 'end_turn',
    }),
    cancel: jest.fn<any>().mockResolvedValue(undefined),
    health: jest.fn<any>().mockResolvedValue({
      healthy: true,
      agents: { total: 1, ready: 1 },
      sessions: { active: 0, capacity: 100 },
      uptime: 1000,
    }),
    ...overrides,
  } as AgentExecutor;
}
