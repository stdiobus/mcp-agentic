/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual mock for the `@google/generative-ai` npm package.
 *
 * Used by Jest's automatic module resolution when `@google/generative-ai` is imported.
 * Provides a mock GoogleGenerativeAI client and error classes.
 */

import { jest } from '@jest/globals';

// ── Mock error classes ──────────────────────────────────────────

export class GoogleGenerativeAIError extends Error {
  readonly status?: string;
  constructor(message: string, status?: string) {
    super(message);
    this.name = 'GoogleGenerativeAIError';
    this.status = status;
  }
}

// ── Mock generative model ───────────────────────────────────────

const generateContentFn = jest.fn<any>();

class MockGenerativeModel {
  readonly model: string;
  generateContent = generateContentFn;

  constructor(model: string) {
    this.model = model;
  }
}

// ── Mock GoogleGenerativeAI client ──────────────────────────────

/**
 * Mock GoogleGenerativeAI class that mirrors the real SDK's interface.
 * `getGenerativeModel().generateContent()` is a jest mock function.
 */
export class GoogleGenerativeAI {
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getGenerativeModel(params: { model: string }): MockGenerativeModel {
    return new MockGenerativeModel(params.model);
  }
}

// Re-export the mock function for test access
export const __mockGenerateContent = generateContentFn;
