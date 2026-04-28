/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider Layer — AI provider abstractions and implementations.
 *
 * This module exports the unified AIProvider interface, ProviderRegistry,
 * and concrete provider implementations (OpenAI, Anthropic, Google Gemini).
 *
 * @module provider
 */

// ── Types and interfaces from AIProvider ────────────────────────

export type {
  AIProvider,
  AIProviderResult,
  ChatMessage,
  ProviderConfig,
  RuntimeParams,
} from './AIProvider.js';

export { mergeRuntimeParams } from './AIProvider.js';

// ── ProviderRegistry ────────────────────────────────────────────

export { ProviderRegistry } from './ProviderRegistry.js';
export type { ProviderInfo } from './ProviderRegistry.js';

// ── ParameterMapper ─────────────────────────────────────────────

export type { ModelProfile, MappableParam } from './ParameterMapper.js';
export { mapParameters } from './ParameterMapper.js';

// ── Concrete provider implementations ───────────────────────────

export { OpenAIProvider, getMaxTokensParamName } from './providers/OpenAIProvider.js';
export { AnthropicProvider } from './providers/AnthropicProvider.js';
export { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
