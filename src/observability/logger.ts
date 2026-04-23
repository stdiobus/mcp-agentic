/**
 * Structured logging with correlation ID support.
 *
 * All output goes to stderr by default — stdout is reserved for the MCP wire protocol.
 */

import { LoggingConfig } from '../types.js';

/** Supported log severity levels, ordered from most to least severe. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Contextual metadata attached to log entries. */
export interface LogContext {
  /** Request correlation ID for tracing. */
  correlationId?: string;
  /** Session identifier. */
  sessionId?: string;
  /** Worker identifier. */
  workerId?: string;
  /** Agent identifier. */
  agentId?: string;
  /** Additional arbitrary context fields. */
  [key: string]: unknown;
}

/**
 * Structured logger that writes to stderr with optional JSON or pretty formatting.
 * Supports hierarchical context via {@link Logger.child}.
 */
export class Logger {
  private config: LoggingConfig;
  private context: LogContext;

  /**
   * @param config - Logging configuration (level, format, destination).
   * @param context - Optional initial context fields.
   */
  constructor(config: LoggingConfig, context: LogContext = {}) {
    this.config = config;
    this.context = context;
  }

  /**
   * Create a child logger with additional context merged into the parent's.
   *
   * @param context - Additional context fields for the child logger.
   * @returns A new Logger instance with merged context.
   */
  child(context: LogContext): Logger {
    return new Logger(this.config, { ...this.context, ...context });
  }

  /**
   * Log an error message.
   * @param message - Log message.
   * @param context - Optional additional context for this entry.
   */
  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  /**
   * Log a warning message.
   * @param message - Log message.
   * @param context - Optional additional context for this entry.
   */
  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  /**
   * Log an info message.
   * @param message - Log message.
   * @param context - Optional additional context for this entry.
   */
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  /**
   * Log a debug message.
   * @param message - Log message.
   * @param context - Optional additional context for this entry.
   */
  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  /**
   * Log a trace message.
   * @param message - Log message.
   * @param context - Optional additional context for this entry.
   */
  trace(message: string, context?: LogContext): void {
    this.log('trace', message, context);
  }

  /** Dispatch a log entry at the given level. */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry = this.formatLogEntry(level, message, context);
    this.write(logEntry);
  }

  /** Check whether the given level meets the configured minimum. */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];
    const configLevel = this.config.level;
    const configIndex = levels.indexOf(configLevel);
    const levelIndex = levels.indexOf(level);
    return levelIndex <= configIndex;
  }

  /** Build a formatted log string from level, message, and merged context. */
  private formatLogEntry(level: LogLevel, message: string, context?: LogContext): string {
    const mergedContext = { ...this.context, ...context };

    if (this.config.format === 'json') {
      return this.formatJSON(level, message, mergedContext);
    } else {
      return this.formatPretty(level, message, mergedContext);
    }
  }

  /** Format a log entry as a single-line JSON string. */
  private formatJSON(level: LogLevel, message: string, context: LogContext): string {
    const entry: Record<string, unknown> = {
      level,
      message,
    };

    if (this.config.includeTimestamp) {
      entry.timestamp = new Date().toISOString();
    }

    if (this.config.includeCorrelationId && context.correlationId) {
      entry.correlationId = context.correlationId;
    }

    // Add all context fields
    Object.entries(context).forEach(([key, value]) => {
      if (key !== 'correlationId' || !this.config.includeCorrelationId) {
        entry[key] = value;
      }
    });

    return JSON.stringify(entry);
  }

  /** Format a log entry as human-readable text. */
  private formatPretty(level: LogLevel, message: string, context: LogContext): string {
    const parts: string[] = [];

    if (this.config.includeTimestamp) {
      parts.push(`[${new Date().toISOString()}]`);
    }

    parts.push(`[${level.toUpperCase()}]`);

    if (this.config.includeCorrelationId && context.correlationId) {
      parts.push(`[${context.correlationId}]`);
    }

    parts.push(message);

    // Add context fields
    const contextFields = Object.entries(context)
      .filter(([key]) => key !== 'correlationId' || !this.config.includeCorrelationId)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');

    if (contextFields) {
      parts.push(`{${contextFields}}`);
    }

    return parts.join(' ');
  }

  /** Write a formatted log entry to the configured destination. */
  private write(entry: string): void {
    const destination = this.config.destination;

    if (destination === 'stderr') {
      console.error(entry);
    } else if (destination === 'stdout') {
      console.log(entry);
    } else if (destination === 'file' && this.config.filePath) {
      // TODO: Implement file logging
      console.error(entry);
    } else {
      console.error(entry);
    }
  }
}

/**
 * Create a new {@link Logger} instance.
 *
 * @param config - Logging configuration.
 * @param context - Optional initial context fields.
 * @returns A configured Logger.
 */
export function createLogger(config: LoggingConfig, context?: LogContext): Logger {
  return new Logger(config, context);
}
