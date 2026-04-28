/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from '@jest/globals';
import {
  TOOL_DEFINITIONS,
  bridgeHealthDef,
  agentsDiscoverDef,
  sessionsCreateDef,
  sessionsPromptDef,
  sessionsStatusDef,
  sessionsCloseDef,
  sessionsCancelDef,
  tasksDelegateDef,
} from '../../../src/mcp/tool-definitions.js';
import type { ToolDefinition } from '../../../src/mcp/tool-definitions.js';

// ─── Helpers ──────────────────────────────────────────────────────

/** Assert a tool definition has the required shape. */
function expectValidToolDef(def: ToolDefinition): void {
  expect(typeof def.name).toBe('string');
  expect(def.name.length).toBeGreaterThan(0);
  expect(typeof def.description).toBe('string');
  expect(def.description.length).toBeGreaterThan(0);
}

/** Assert a JSON Schema object has the expected properties. */
function expectSchemaProperties(
  schema: Record<string, unknown>,
  expectedProps: string[],
): void {
  expect(schema.type).toBe('object');
  const properties = schema.properties as Record<string, unknown>;
  expect(properties).toBeDefined();
  for (const prop of expectedProps) {
    expect(properties).toHaveProperty(prop);
  }
}

// ─── Tests ────────────────────────────────────────────────────────

describe('tool-definitions — TOOL_DEFINITIONS array', () => {
  it('exports exactly 8 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(8);
  });

  it('every definition has name and description', () => {
    for (const def of TOOL_DEFINITIONS) {
      expectValidToolDef(def);
    }
  });

  it('tool names are unique', () => {
    const names = TOOL_DEFINITIONS.map(d => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains all expected tool names', () => {
    const names = TOOL_DEFINITIONS.map(d => d.name);
    expect(names).toContain('bridge_health');
    expect(names).toContain('agents_discover');
    expect(names).toContain('sessions_create');
    expect(names).toContain('sessions_prompt');
    expect(names).toContain('sessions_status');
    expect(names).toContain('sessions_close');
    expect(names).toContain('sessions_cancel');
    expect(names).toContain('tasks_delegate');
  });
});

describe('tool-definitions — bridge_health', () => {
  it('has no inputSchema (no parameters)', () => {
    expectValidToolDef(bridgeHealthDef);
    expect(bridgeHealthDef.inputSchema).toBeUndefined();
  });
});

describe('tool-definitions — agents_discover', () => {
  it('has inputSchema with capability property', () => {
    expectValidToolDef(agentsDiscoverDef);
    const schema = agentsDiscoverDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['capability', 'refresh']);
  });
});

describe('tool-definitions — sessions_create', () => {
  it('has inputSchema with agentId, workerId, metadata properties', () => {
    expectValidToolDef(sessionsCreateDef);
    const schema = sessionsCreateDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['agentId', 'workerId', 'metadata']);
  });
});

describe('tool-definitions — sessions_prompt', () => {
  it('has inputSchema with sessionId, prompt, timeout properties', () => {
    expectValidToolDef(sessionsPromptDef);
    const schema = sessionsPromptDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['sessionId', 'prompt', 'timeout']);
  });

  it('sessionId and prompt are required', () => {
    const schema = sessionsPromptDef.inputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('sessionId');
    expect(required).toContain('prompt');
  });
});

describe('tool-definitions — sessions_status', () => {
  it('has inputSchema with sessionId property', () => {
    expectValidToolDef(sessionsStatusDef);
    const schema = sessionsStatusDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['sessionId']);
  });

  it('sessionId is required', () => {
    const schema = sessionsStatusDef.inputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('sessionId');
  });
});

describe('tool-definitions — sessions_close', () => {
  it('has inputSchema with sessionId and reason properties', () => {
    expectValidToolDef(sessionsCloseDef);
    const schema = sessionsCloseDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['sessionId', 'reason']);
  });

  it('sessionId is required', () => {
    const schema = sessionsCloseDef.inputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('sessionId');
  });
});

describe('tool-definitions — sessions_cancel', () => {
  it('has inputSchema with sessionId and requestId properties', () => {
    expectValidToolDef(sessionsCancelDef);
    const schema = sessionsCancelDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['sessionId', 'requestId']);
  });

  it('sessionId is required', () => {
    const schema = sessionsCancelDef.inputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('sessionId');
  });
});

describe('tool-definitions — tasks_delegate', () => {
  it('has inputSchema with prompt, agentId, timeout, metadata properties', () => {
    expectValidToolDef(tasksDelegateDef);
    const schema = tasksDelegateDef.inputSchema as Record<string, unknown>;
    expectSchemaProperties(schema, ['prompt', 'agentId', 'timeout', 'metadata']);
  });

  it('prompt is required', () => {
    const schema = tasksDelegateDef.inputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('prompt');
  });
});
