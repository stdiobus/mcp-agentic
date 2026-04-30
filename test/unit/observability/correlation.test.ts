/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  generateCorrelationId,
  setCorrelationId,
  getCorrelationId,
  clearCorrelationId,
  withCorrelationId,
} from '../../../src/observability/correlation.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Clean up correlation context between tests to avoid cross-contamination. */
afterEach(() => {
  clearCorrelationId();
});

// ── generateCorrelationId ────────────────────────────────────────

describe('generateCorrelationId', () => {
  it('returns a string with "req-" prefix', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^req-/);
  });

  it('returns a string of length 20 (req- prefix + 16 hex chars)', () => {
    const id = generateCorrelationId();
    // "req-" = 4 chars, randomBytes(8).toString('hex') = 16 hex chars → total 20
    expect(id).toHaveLength(20);
  });

  it('contains only hex characters after the prefix', () => {
    const id = generateCorrelationId();
    const hexPart = id.slice(4);
    expect(hexPart).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns unique values on repeated calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });
});

// ── setCorrelationId / getCorrelationId ──────────────────────────

describe('setCorrelationId / getCorrelationId', () => {
  it('round-trips: set then get returns the same value', () => {
    setCorrelationId('test-id-123');
    expect(getCorrelationId()).toBe('test-id-123');
  });

  it('returns undefined before any set', () => {
    // afterEach clears, so this is a fresh state
    expect(getCorrelationId()).toBeUndefined();
  });

  it('overwrites previous value on subsequent set', () => {
    setCorrelationId('first');
    setCorrelationId('second');
    expect(getCorrelationId()).toBe('second');
  });
});

// ── clearCorrelationId ───────────────────────────────────────────

describe('clearCorrelationId', () => {
  it('makes getCorrelationId return undefined after clear', () => {
    setCorrelationId('to-be-cleared');
    expect(getCorrelationId()).toBe('to-be-cleared');

    clearCorrelationId();
    expect(getCorrelationId()).toBeUndefined();
  });

  it('is safe to call when no id is set', () => {
    expect(() => clearCorrelationId()).not.toThrow();
    expect(getCorrelationId()).toBeUndefined();
  });
});

// ── withCorrelationId ────────────────────────────────────────────

describe('withCorrelationId', () => {
  it('sets the id for the duration of the async function', async () => {
    let capturedId: string | undefined;

    await withCorrelationId('scoped-id', async () => {
      capturedId = getCorrelationId();
    });

    expect(capturedId).toBe('scoped-id');
  });

  it('restores the previous id after execution', async () => {
    setCorrelationId('outer-id');

    await withCorrelationId('inner-id', async () => {
      expect(getCorrelationId()).toBe('inner-id');
    });

    expect(getCorrelationId()).toBe('outer-id');
  });

  it('restores the previous id even if fn throws', async () => {
    setCorrelationId('before-error');

    await expect(
      withCorrelationId('error-id', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(getCorrelationId()).toBe('before-error');
  });

  it('clears the id after execution if no previous id was set', async () => {
    // Ensure no id is set
    expect(getCorrelationId()).toBeUndefined();

    await withCorrelationId('temporary-id', async () => {
      expect(getCorrelationId()).toBe('temporary-id');
    });

    expect(getCorrelationId()).toBeUndefined();
  });

  it('returns the value from the async function', async () => {
    const result = await withCorrelationId('id', async () => 42);
    expect(result).toBe(42);
  });
});
