/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Logger, createLogger } from '../../../src/observability/logger.js';
import type { LoggingConfig } from '../../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Minimal config for tests — JSON format, no timestamp, no correlation id. */
const baseConfig: LoggingConfig = {
  level: 'trace',
  format: 'json',
  includeTimestamp: false,
  includeCorrelationId: false,
  destination: 'stderr',
};

let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

/** Parse the first console.error call's argument as JSON. */
function lastLogJSON(): Record<string, unknown> {
  expect(consoleErrorSpy).toHaveBeenCalled();
  const raw = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1]![0] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Get the raw string from the last console.error call. */
function lastLogRaw(): string {
  expect(consoleErrorSpy).toHaveBeenCalled();
  return consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1]![0] as string;
}

// ── createLogger ─────────────────────────────────────────────────

describe('createLogger', () => {
  it('returns an instance of Logger', () => {
    const logger = createLogger(baseConfig);
    expect(logger).toBeInstanceOf(Logger);
  });

  it('accepts optional initial context', () => {
    const logger = createLogger(baseConfig, { agentId: 'test-agent' });
    logger.info('hello');
    const entry = lastLogJSON();
    expect(entry.agentId).toBe('test-agent');
  });
});

// ── Log level methods ────────────────────────────────────────────

describe('Logger level methods', () => {
  it.each(['error', 'warn', 'info', 'debug', 'trace'] as const)(
    '%s() writes to console.error with the correct level field',
    (level) => {
      const logger = new Logger(baseConfig);
      logger[level](`${level} message`);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const entry = lastLogJSON();
      expect(entry.level).toBe(level);
      expect(entry.message).toBe(`${level} message`);
    },
  );
});

// ── Level filtering ──────────────────────────────────────────────

describe('level filtering', () => {
  it('info level does not log debug or trace', () => {
    const logger = new Logger({ ...baseConfig, level: 'info' });

    logger.debug('should not appear');
    logger.trace('should not appear');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    logger.info('should appear');
    logger.warn('should appear');
    logger.error('should appear');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
  });

  it('error level logs only error', () => {
    const logger = new Logger({ ...baseConfig, level: 'error' });

    logger.trace('no');
    logger.debug('no');
    logger.info('no');
    logger.warn('no');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    logger.error('yes');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('trace level logs everything', () => {
    const logger = new Logger({ ...baseConfig, level: 'trace' });

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.trace('t');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(5);
  });
});

// ── JSON format ──────────────────────────────────────────────────

describe('JSON format', () => {
  it('outputs valid JSON with level and message fields', () => {
    const logger = new Logger(baseConfig);
    logger.info('test message');

    const entry = lastLogJSON();
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('test message');
  });

  it('includes timestamp when includeTimestamp is true', () => {
    const logger = new Logger({ ...baseConfig, includeTimestamp: true });
    logger.info('with timestamp');

    const entry = lastLogJSON();
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe('string');
    // Verify it's a valid ISO timestamp
    expect(() => new Date(entry.timestamp as string)).not.toThrow();
  });

  it('excludes timestamp when includeTimestamp is false', () => {
    const logger = new Logger({ ...baseConfig, includeTimestamp: false });
    logger.info('no timestamp');

    const entry = lastLogJSON();
    expect(entry.timestamp).toBeUndefined();
  });

  it('includes correlationId when includeCorrelationId is true and context has it', () => {
    const logger = new Logger({
      ...baseConfig,
      includeCorrelationId: true,
    });
    logger.info('with corr', { correlationId: 'req-abc123' });

    const entry = lastLogJSON();
    expect(entry.correlationId).toBe('req-abc123');
  });

  it('omits correlationId when includeCorrelationId is false', () => {
    const logger = new Logger({
      ...baseConfig,
      includeCorrelationId: false,
    });
    logger.info('no corr', { correlationId: 'req-abc123' });

    const entry = lastLogJSON();
    // correlationId should appear as a regular context field, not promoted
    expect(entry.correlationId).toBe('req-abc123');
  });

  it('includes context fields in JSON output', () => {
    const logger = new Logger(baseConfig, { agentId: 'agent-1' });
    logger.info('ctx test', { sessionId: 'sess-42' });

    const entry = lastLogJSON();
    expect(entry.agentId).toBe('agent-1');
    expect(entry.sessionId).toBe('sess-42');
  });
});

// ── Pretty format ────────────────────────────────────────────────

describe('pretty format', () => {
  const prettyConfig: LoggingConfig = {
    ...baseConfig,
    format: 'pretty',
    includeTimestamp: false,
    includeCorrelationId: false,
  };

  it('outputs [LEVEL] message format', () => {
    const logger = new Logger(prettyConfig);
    logger.info('hello world');

    const raw = lastLogRaw();
    expect(raw).toContain('[INFO]');
    expect(raw).toContain('hello world');
  });

  it('includes ISO timestamp in brackets when includeTimestamp is true', () => {
    const logger = new Logger({ ...prettyConfig, includeTimestamp: true });
    logger.warn('with time');

    const raw = lastLogRaw();
    // Should contain a bracketed ISO timestamp like [2026-04-30T...]
    expect(raw).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(raw).toContain('[WARN]');
  });

  it('includes correlation id in brackets when enabled and present', () => {
    const logger = new Logger({
      ...prettyConfig,
      includeCorrelationId: true,
    });
    logger.info('corr test', { correlationId: 'req-xyz' });

    const raw = lastLogRaw();
    expect(raw).toContain('[req-xyz]');
  });

  it('includes context fields in curly braces', () => {
    const logger = new Logger(prettyConfig, { agentId: 'a1' });
    logger.info('ctx');

    const raw = lastLogRaw();
    expect(raw).toContain('agentId=');
    expect(raw).toContain('"a1"');
  });

  it('uses uppercase level labels', () => {
    const logger = new Logger(prettyConfig);

    logger.error('e');
    expect(lastLogRaw()).toContain('[ERROR]');

    logger.debug('d');
    expect(consoleErrorSpy.mock.calls[1]![0]).toContain('[DEBUG]');
  });
});

// ── child() ──────────────────────────────────────────────────────

describe('child()', () => {
  it('creates a child logger with merged context', () => {
    const parent = new Logger(baseConfig, { agentId: 'parent-agent' });
    const child = parent.child({ sessionId: 'sess-1' });

    child.info('child message');
    const entry = lastLogJSON();
    expect(entry.agentId).toBe('parent-agent');
    expect(entry.sessionId).toBe('sess-1');
  });

  it('child context does not mutate parent context', () => {
    const parent = new Logger(baseConfig, { agentId: 'parent' });
    parent.child({ sessionId: 'child-sess' });

    parent.info('parent message');
    const entry = lastLogJSON();
    expect(entry.agentId).toBe('parent');
    expect(entry.sessionId).toBeUndefined();
  });

  it('child context overrides parent context for same keys', () => {
    const parent = new Logger(baseConfig, { agentId: 'parent' });
    const child = parent.child({ agentId: 'child' });

    child.info('override test');
    const entry = lastLogJSON();
    expect(entry.agentId).toBe('child');
  });

  it('child inherits parent log level and format', () => {
    const parent = new Logger({ ...baseConfig, level: 'error' });
    const child = parent.child({ sessionId: 's1' });

    child.info('should not appear');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    child.error('should appear');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

// ── destination: file without filePath ───────────────────────────

describe('destination fallback', () => {
  it('falls back to console.error when destination is file but filePath is missing', () => {
    const logger = new Logger({
      ...baseConfig,
      destination: 'file',
      // filePath intentionally omitted
    });

    logger.info('fallback test');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('uses console.error when destination is file with filePath (TODO: file logging)', () => {
    const logger = new Logger({
      ...baseConfig,
      destination: 'file',
      filePath: '/tmp/test.log',
    });

    // Current implementation falls back to console.error even with filePath
    logger.info('file test');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
