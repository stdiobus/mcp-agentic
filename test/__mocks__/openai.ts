/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual mock for the `openai` npm package.
 *
 * Used by Jest's automatic module resolution when `openai` is imported.
 * Provides mock error classes and a mock OpenAI client constructor.
 */

import { jest } from '@jest/globals';

// ── Mock error classes ──────────────────────────────────────────

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Incorrect API key provided') {
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

export class APITimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'APITimeoutError';
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

// ── Mock OpenAI client ──────────────────────────────────────────

/**
 * Mock OpenAI class that mirrors the real SDK's interface.
 * `chat.completions.create`, `responses.create`, `files.create`, and
 * `files.delete` are jest mock functions.
 */
class OpenAI {
  readonly apiKey: string;
  readonly chat: {
    completions: {
      create: jest.Mock<any>;
    };
  };
  readonly responses: {
    create: jest.Mock<any>;
  };
  readonly files: {
    create: jest.Mock<any>;
    delete: jest.Mock<any>;
  };

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
    this.chat = {
      completions: {
        create: jest.fn<any>(),
      },
    };
    const responsesCreate = jest.fn<any>();
    responsesCreate.mockResolvedValue({
      output_text: 'mock response',
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    this.responses = {
      create: responsesCreate,
    };
    this.files = {
      create: jest.fn<any>(),
      delete: jest.fn<any>(),
    };
  }
}

// Default export matches the real SDK's export shape
export default OpenAI;
