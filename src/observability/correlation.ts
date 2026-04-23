/**
 * Correlation ID generation and management
 */

import { randomBytes } from 'crypto';

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): string {
  return `req-${randomBytes(8).toString('hex')}`;
}

/**
 * Correlation context storage (async local storage would be better in production)
 */
const correlationContext = new Map<string, string>();

/**
 * Set correlation ID for current context
 */
export function setCorrelationId(id: string): void {
  correlationContext.set('current', id);
}

/**
 * Get correlation ID for current context
 */
export function getCorrelationId(): string | undefined {
  return correlationContext.get('current');
}

/**
 * Clear correlation ID for current context
 */
export function clearCorrelationId(): void {
  correlationContext.delete('current');
}

/**
 * Execute function with correlation ID
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
