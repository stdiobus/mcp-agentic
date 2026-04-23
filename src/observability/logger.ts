/**
 * Structured logging with correlation ID support
 */

import { LoggingConfig } from '../types.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LogContext {
  correlationId?: string;
  sessionId?: string;
  workerId?: string;
  agentId?: string;
  [key: string]: unknown;
}

export class Logger {
  private config: LoggingConfig;
  private context: LogContext;

  constructor(config: LoggingConfig, context: LogContext = {}) {
    this.config = config;
    this.context = context;
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    return new Logger(this.config, { ...this.context, ...context });
  }

  /**
   * Log an error message
   */
  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  /**
   * Log a trace message
   */
  trace(message: string, context?: LogContext): void {
    this.log('trace', message, context);
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry = this.formatLogEntry(level, message, context);
    this.write(logEntry);
  }

  /**
   * Check if log level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];
    const configLevel = this.config.level;
    const configIndex = levels.indexOf(configLevel);
    const levelIndex = levels.indexOf(level);
    return levelIndex <= configIndex;
  }

  /**
   * Format log entry
   */
  private formatLogEntry(level: LogLevel, message: string, context?: LogContext): string {
    const mergedContext = { ...this.context, ...context };

    if (this.config.format === 'json') {
      return this.formatJSON(level, message, mergedContext);
    } else {
      return this.formatPretty(level, message, mergedContext);
    }
  }

  /**
   * Format as JSON
   */
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

  /**
   * Format as pretty text
   */
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

  /**
   * Write log entry to destination
   */
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
 * Create a logger instance
 */
export function createLogger(config: LoggingConfig, context?: LogContext): Logger {
  return new Logger(config, context);
}
