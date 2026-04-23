/**
 * Bridge error types and error handling
 */

export type BridgeErrorType =
  | 'CONFIG'
  | 'AUTH'
  | 'TRANSPORT'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'INTERNAL';

export interface BridgeErrorDetails {
  correlationId?: string;
  upstreamCode?: string;
  retryable: boolean;
  sessionValid?: boolean;
  stage?: string;
  [key: string]: unknown;
}

export class BridgeError extends Error {
  public readonly type: BridgeErrorType;
  public readonly details: BridgeErrorDetails;
  public readonly cause?: Error;

  constructor(
    type: BridgeErrorType,
    message: string,
    details: Partial<BridgeErrorDetails> = {},
    cause?: Error
  ) {
    super(message);
    this.name = 'BridgeError';
    this.type = type;
    this.details = {
      retryable: false,
      ...details,
    };
    if (cause) {
      this.cause = cause;
    }

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BridgeError);
    }
  }

  /**
   * Create a CONFIG error
   */
  static config(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('CONFIG', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create an AUTH error
   */
  static auth(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('AUTH', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create a TRANSPORT error
   */
  static transport(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('TRANSPORT', message, { ...details, retryable: true }, cause);
  }

  /**
   * Create an UPSTREAM error
   */
  static upstream(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create a TIMEOUT error
   */
  static timeout(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('TIMEOUT', message, { ...details, retryable: true }, cause);
  }

  /**
   * Create a PROTOCOL error
   */
  static protocol(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('PROTOCOL', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create an INTERNAL error
   */
  static internal(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('INTERNAL', message, { ...details, retryable: false }, cause);
  }

  /**
   * Convert to JSON-serializable object
   */
  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      message: this.message,
      details: this.details,
      cause: this.cause ? {
        message: this.cause.message,
      } : undefined,
    };
  }
}
