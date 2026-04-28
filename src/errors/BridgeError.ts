/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge error types and error handling.
 *
 * All domain errors in MCP Agentic use {@link BridgeError} with a typed
 * category. Each category has a static factory method and a default
 * `retryable` flag.
 */

/** Discriminator for {@link BridgeError} categories. */
export type BridgeErrorType =
  | 'CONFIG'
  | 'AUTH'
  | 'TRANSPORT'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'INTERNAL';

/** Structured details attached to a {@link BridgeError}. */
export interface BridgeErrorDetails {
  correlationId?: string;
  upstreamCode?: string;
  retryable: boolean;
  sessionValid?: boolean;
  stage?: string;
  [key: string]: unknown;
}

/**
 * Typed error class for all domain errors in MCP Agentic.
 *
 * Use the static factory methods (`BridgeError.config(...)`, etc.) instead
 * of calling the constructor directly — they set the correct defaults.
 */
export class BridgeError extends Error {
  /** Error category discriminator. */
  public readonly type: BridgeErrorType;
  /** Structured error details including retryability. */
  public readonly details: BridgeErrorDetails;
  /** Original error that caused this one, if any. */
  public readonly cause?: Error;

  /**
   * @param type - Error category.
   * @param message - Human-readable error description.
   * @param details - Partial details; `retryable` defaults to `false`.
   * @param cause - Optional underlying error.
   */
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
   * Create a CONFIG error (not retryable).
   *
   * @param message - Error description.
   * @param details - Optional additional details.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `CONFIG`.
   */
  static config(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('CONFIG', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create an AUTH error (not retryable).
   *
   * @param message - Error description.
   * @param details - Optional additional details.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `AUTH`.
   */
  static auth(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('AUTH', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create a TRANSPORT error (retryable by default).
   *
   * @param message - Error description.
   * @param details - Optional additional details. `retryable` defaults to `true`.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `TRANSPORT`.
   */
  static transport(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('TRANSPORT', message, { ...details, retryable: true }, cause);
  }

  /**
   * Create an UPSTREAM error (not retryable).
   *
   * @param message - Error description.
   * @param details - Optional additional details.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `UPSTREAM`.
   */
  static upstream(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create a TIMEOUT error (retryable by default).
   *
   * @param message - Error description.
   * @param details - Optional additional details. `retryable` defaults to `true`.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `TIMEOUT`.
   */
  static timeout(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('TIMEOUT', message, { ...details, retryable: true }, cause);
  }

  /**
   * Create a PROTOCOL error (not retryable).
   *
   * @param message - Error description.
   * @param details - Optional additional details.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `PROTOCOL`.
   */
  static protocol(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('PROTOCOL', message, { ...details, retryable: false }, cause);
  }

  /**
   * Create an INTERNAL error (not retryable).
   *
   * @param message - Error description.
   * @param details - Optional additional details.
   * @param cause - Optional underlying error.
   * @returns A new BridgeError with type `INTERNAL`.
   */
  static internal(message: string, details?: Partial<BridgeErrorDetails>, cause?: Error): BridgeError {
    return new BridgeError('INTERNAL', message, { ...details, retryable: false }, cause);
  }

  /**
   * Convert to a JSON-serializable plain object.
   * @returns Object with `type`, `message`, `details`, and optional `cause`.
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
