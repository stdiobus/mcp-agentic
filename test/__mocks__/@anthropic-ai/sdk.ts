/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual mock for the `@anthropic-ai/sdk` npm package.
 *
 * Used by Jest's automatic module resolution when `@anthropic-ai/sdk` is imported.
 * Provides mock error classes and a mock Anthropic client constructor.
 */

import { jest } from '@jest/globals';

// ── Mock error classes ──────────────────────────────────────────

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Invalid API key') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class APIConnectionError extends Error {
  constructor(message = 'Connection error') {
    super(message);
    this.name = 'APIConnectionError';
  }
}

export class APIConnectionTimeoutError extends Error {
  constructor(message = 'Connection timed out') {
    super(message);
    this.name = 'APIConnectionTimeoutError';
  }
}

export class BadRequestError extends Error {
  readonly status = 400;
  constructor(message = 'Bad request') {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class InternalServerError extends Error {
  readonly status = 500;
  constructor(message = 'Internal server error') {
    super(message);
    this.name = 'InternalServerError';
  }
}

// ── Mock Anthropic client ───────────────────────────────────────

const createFn = jest.fn<any>();

/**
 * Mock Anthropic class that mirrors the real SDK's interface.
 * `messages.create` is a jest mock function.
 */
class Anthropic {
  readonly apiKey: string;
  readonly messages: {
    create: jest.Mock<any>;
  };

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
    this.messages = {
      create: createFn,
    };
  }
}

// Re-export the mock function for test access
export const __mockMessagesCreate = createFn;

// Default export matches the real SDK's export shape
export default Anthropic;
