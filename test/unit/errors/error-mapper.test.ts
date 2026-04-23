import { jest, describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { mapErrorToMCP, mapBridgeErrorToMCP, MCPErrorCode } from '../../../src/errors/error-mapper.js';
import { BridgeError } from '../../../src/errors/BridgeError.js';
import type { BridgeErrorType } from '../../../src/errors/BridgeError.js';

// ─── Property Tests ───────────────────────────────────────────────

describe('error-mapper — Property Tests', () => {
  // **Validates: Requirements 7.5**

  const errorTypeToCode: Array<{ type: BridgeErrorType; factory: (msg: string) => BridgeError; expectedCode: number }> = [
    { type: 'CONFIG', factory: (m) => BridgeError.config(m), expectedCode: MCPErrorCode.CONFIG_ERROR },
    { type: 'AUTH', factory: (m) => BridgeError.auth(m), expectedCode: MCPErrorCode.AUTH_ERROR },
    { type: 'TRANSPORT', factory: (m) => BridgeError.transport(m), expectedCode: MCPErrorCode.SERVER_ERROR },
    { type: 'UPSTREAM', factory: (m) => BridgeError.upstream(m), expectedCode: MCPErrorCode.UPSTREAM_ERROR },
    { type: 'TIMEOUT', factory: (m) => BridgeError.timeout(m), expectedCode: MCPErrorCode.TIMEOUT_ERROR },
    { type: 'PROTOCOL', factory: (m) => BridgeError.protocol(m), expectedCode: MCPErrorCode.SERVER_ERROR },
    { type: 'INTERNAL', factory: (m) => BridgeError.internal(m), expectedCode: MCPErrorCode.INTERNAL_ERROR },
  ];

  it('Property 9: all BridgeError types map to correct MCP error codes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.integer({ min: 0, max: errorTypeToCode.length - 1 }),
        async (message, typeIndex) => {
          const { factory, expectedCode, type } = errorTypeToCode[typeIndex]!;
          const error = factory(message);
          const mcpError = mapBridgeErrorToMCP(error);

          expect(mcpError.code).toBe(expectedCode);
          expect(mcpError.message).toBe(message);
          expect(mcpError.data).toBeDefined();
          expect((mcpError.data as Record<string, unknown>)['type']).toBe(type);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 9 (extension): non-BridgeError maps to INTERNAL_ERROR', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        async (message) => {
          const error = new Error(message);
          const mcpError = mapErrorToMCP(error);

          expect(mcpError.code).toBe(MCPErrorCode.INTERNAL_ERROR);
          expect(mcpError.message).toBe(message);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 9 (extension): non-Error values map to INTERNAL_ERROR with generic message', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        async (value) => {
          const mcpError = mapErrorToMCP(value);

          expect(mcpError.code).toBe(MCPErrorCode.INTERNAL_ERROR);
          expect(typeof mcpError.message).toBe('string');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Sanitization Tests ───────────────────────────────────────────

describe('error-mapper — Sanitization', () => {
  it('mapBridgeErrorToMCP does NOT leak custom details fields (stack, token, authorization)', () => {
    const error = new BridgeError('INTERNAL', 'test', {
      retryable: false,
      correlationId: 'c-1',
      stack: 'leaked stack trace',
      token: 'secret-token-123',
      authorization: 'Bearer secret',
      raw: { sensitive: true },
      request: { url: '/secret' },
      response: { body: 'secret' },
      config: { apiKey: 'key' },
      cause: 'leaked cause string',
    } as any);

    const result = mapBridgeErrorToMCP(error);
    const data = result.data as Record<string, unknown>;

    // Only the 6 allowlisted keys should be present
    const allowedKeys = ['type', 'correlationId', 'upstreamCode', 'retryable', 'sessionValid', 'stage'];
    for (const key of Object.keys(data)) {
      expect(allowedKeys).toContain(key);
    }

    // Explicitly verify dangerous keys are absent
    expect(data).not.toHaveProperty('stack');
    expect(data).not.toHaveProperty('token');
    expect(data).not.toHaveProperty('authorization');
    expect(data).not.toHaveProperty('raw');
    expect(data).not.toHaveProperty('request');
    expect(data).not.toHaveProperty('response');
    expect(data).not.toHaveProperty('config');
    expect(data).not.toHaveProperty('cause');
  });

  it('mapErrorToMCP for unknown errors does NOT include the raw error value', () => {
    const sensitiveObj = { secret: 'password', toString: () => 'leaked-secret' };
    const result = mapErrorToMCP(sensitiveObj);
    const data = result.data as Record<string, unknown>;

    expect(data).not.toHaveProperty('error');
    expect(result.message).toBe('Unknown error occurred');
    expect(JSON.stringify(result)).not.toContain('leaked-secret');
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('mapErrorToMCP for Error instances does NOT include stack', () => {
    const error = new Error('some error');
    error.stack = 'Error: some error\n    at secret/path/file.ts:42:13';
    const result = mapErrorToMCP(error);
    const data = result.data as Record<string, unknown>;

    expect(data).not.toHaveProperty('stack');
    expect(JSON.stringify(result)).not.toContain('secret/path/file.ts');
  });
});

// ─── Unit Tests ───────────────────────────────────────────────────

describe('error-mapper — Unit Tests', () => {
  it('maps BridgeError.config to CONFIG_ERROR (-32004)', () => {
    const error = BridgeError.config('Bad config');
    const result = mapBridgeErrorToMCP(error);
    expect(result.code).toBe(-32004);
    expect(result.message).toBe('Bad config');
  });

  it('maps BridgeError.upstream to UPSTREAM_ERROR (-32002)', () => {
    const error = BridgeError.upstream('Agent failed');
    const result = mapBridgeErrorToMCP(error);
    expect(result.code).toBe(-32002);
  });

  it('maps BridgeError.transport to SERVER_ERROR (-32000)', () => {
    const error = BridgeError.transport('Bus down');
    const result = mapBridgeErrorToMCP(error);
    expect(result.code).toBe(-32000);
  });

  it('maps BridgeError.timeout to TIMEOUT_ERROR (-32001)', () => {
    const error = BridgeError.timeout('Timed out');
    const result = mapBridgeErrorToMCP(error);
    expect(result.code).toBe(-32001);
  });

  it('maps BridgeError.internal to INTERNAL_ERROR (-32603)', () => {
    const error = BridgeError.internal('Unexpected');
    const result = mapBridgeErrorToMCP(error);
    expect(result.code).toBe(-32603);
  });

  it('preserves BridgeError details in data field', () => {
    const error = BridgeError.upstream('Failed', { correlationId: 'abc-123', retryable: false });
    const result = mapBridgeErrorToMCP(error);
    expect((result.data as Record<string, unknown>)['correlationId']).toBe('abc-123');
    expect((result.data as Record<string, unknown>)['retryable']).toBe(false);
  });

  it('mapErrorToMCP handles plain Error', () => {
    const result = mapErrorToMCP(new Error('oops'));
    expect(result.code).toBe(-32603);
    expect(result.message).toBe('oops');
  });

  it('mapErrorToMCP handles non-Error values', () => {
    const result = mapErrorToMCP('string error');
    expect(result.code).toBe(-32603);
    expect(result.message).toBe('Unknown error occurred');
  });
});
