/**
 * Correlation ID generation and context management.
 *
 * Provides a simple Map-based store for the "current" correlation ID.
 * In production, consider replacing with `AsyncLocalStorage` for
 * proper async context propagation.
 */

import { randomBytes } from 'crypto';

/**
 * Generate a new correlation ID with a `req-` prefix.
 * @returns A hex-encoded random correlation ID (e.g. `req-a1b2c3d4e5f6a7b8`).
 */
export function generateCorrelationId(): string {
  return `req-${randomBytes(8).toString('hex')}`;
}

/** Simple Map-based storage for the current correlation ID. */
const correlationContext = new Map<string, string>();

/**
 * Set the correlation ID for the current context.
 * @param id - Correlation ID to store.
 */
export function setCorrelationId(id: string): void {
  correlationContext.set('current', id);
}

/**
 * Get the correlation ID for the current context.
 * @returns The current correlation ID, or `undefined` if none is set.
 */
export function getCorrelationId(): string | undefined {
  return correlationContext.get('current');
}

/** Clear the correlation ID for the current context. */
export function clearCorrelationId(): void {
  correlationContext.delete('current');
}

/**
 * Execute an async function with a correlation ID set for its duration.
 * Restores the previous correlation ID (or clears it) after completion.
 *
 * @param id - Correlation ID to use during execution.
 * @param fn - Async function to execute.
 * @returns Promise resolving to the function's return value.
 */
export async function withCorrelationId<T>(
  id: string,
  fn: () => Promise<T>
): Promise<T> {
  const previousId = getCorrelationId();
  setCorrelationId(id);
  try {
    return await fn();
  } finally {
    if (previousId) {
      setCorrelationId(previousId);
    } else {
      clearCorrelationId();
    }
  }
}
