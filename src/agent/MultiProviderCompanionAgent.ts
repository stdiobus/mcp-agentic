/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MultiProviderCompanionAgent — Agent that delegates to any registered AI provider.
 *
 * Implements the {@link AgentHandler} interface without modifications.
 * Supports dynamic provider selection per session and runtime parameter
 * overrides at both session and prompt levels.
 *
 * @module agent/MultiProviderCompanionAgent
 */

import { BridgeError } from '../errors/BridgeError.js';
import type { ChatMessage, RuntimeParams } from '../provider/AIProvider.js';
import { mergeRuntimeParams } from '../provider/AIProvider.js';
import type { ProviderRegistry } from '../provider/ProviderRegistry.js';
import type { AgentHandler, AgentResult, PromptOpts } from './AgentHandler.js';

// ── Configuration ───────────────────────────────────────────────

/**
 * Configuration for constructing a {@link MultiProviderCompanionAgent}.
 */
export interface MultiProviderCompanionConfig {
  /** Unique agent identifier. */
  id: string;
  /** Default provider id to use when no override is specified. */
  defaultProviderId: string;
  /** Registry of available AI providers. */
  registry: ProviderRegistry;
  /** Optional list of capabilities this agent supports. */
  capabilities?: string[];
  /** Default system prompt applied to all sessions unless overridden. */
  systemPrompt?: string;
  /** Provider-level default RuntimeParams. */
  defaults?: RuntimeParams;
}

// ── Internal session state ──────────────────────────────────────

/** Per-session state maintained by the agent. */
interface SessionState {
  /** Provider id for this session. */
  providerId: string;
  /** Conversation history (user + assistant messages). */
  messages: ChatMessage[];
  /** Session-level RuntimeParams (from metadata.runtimeParams at creation). */
  sessionParams: RuntimeParams;
  /** Ephemeral prompt-level params, set before prompt() and cleared after. */
  pendingPromptParams: RuntimeParams | undefined;
}

// ── MultiProviderCompanionAgent ─────────────────────────────────

/**
 * Agent that delegates AI generation to any registered provider.
 *
 * Implements {@link AgentHandler} (prompt, onSessionCreate, onSessionClose).
 * Provides additional methods for prompt-level runtime params and
 * provider registry access (used by McpAgenticServer for discovery).
 */
export class MultiProviderCompanionAgent implements AgentHandler {
  readonly id: string;
  readonly capabilities?: string[];

  private readonly registry: ProviderRegistry;
  private readonly defaultProviderId: string;
  private readonly systemPrompt: string | undefined;
  private readonly defaults: RuntimeParams;
  private readonly sessions = new Map<string, SessionState>();

  constructor(config: MultiProviderCompanionConfig) {
    this.id = config.id;
    if (config.capabilities !== undefined) {
      this.capabilities = config.capabilities;
    }
    this.registry = config.registry;
    this.defaultProviderId = config.defaultProviderId;
    this.systemPrompt = config.systemPrompt ?? undefined;
    this.defaults = config.defaults ?? {};

    // Validate that the default provider exists in the registry
    if (!this.registry.has(this.defaultProviderId)) {
      throw BridgeError.config(
        `Default provider "${this.defaultProviderId}" is not registered in the ProviderRegistry`,
      );
    }
  }

  // ── AgentHandler: prompt ────────────────────────────────────────

  /**
   * Process a prompt by delegating to the resolved provider.
   *
   * Merges runtime params (config defaults < session params < prompt params),
   * resolves the provider, calls complete(), and updates conversation history.
   */
  async prompt(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw BridgeError.config(
        `Session "${sessionId}" does not exist`,
      );
    }

    // Extract and clear pending prompt-level params
    const promptParams = session.pendingPromptParams ?? {};
    session.pendingPromptParams = undefined;

    // Merge params: config defaults < session params < prompt params
    const mergedParams = mergeRuntimeParams(this.defaults, session.sessionParams, promptParams);

    // Resolve provider
    const provider = this.registry.get(session.providerId);

    // Build messages array: system prompt + conversation history + current input
    const systemPrompt = mergedParams.systemPrompt ?? this.systemPrompt;
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Append conversation history
    messages.push(...session.messages);

    // Append current user message
    messages.push({ role: 'user', content: input });

    // Call provider
    const result = await provider.complete(messages, mergedParams, opts?.signal);

    // Update conversation history with user input and assistant response
    session.messages.push({ role: 'user', content: input });
    session.messages.push({ role: 'assistant', content: result.text });

    const agentResult: AgentResult = {
      text: result.text,
      stopReason: result.stopReason,
    };
    if (result.usage !== undefined) {
      agentResult.usage = result.usage;
    }
    return agentResult;
  }

  // ── AgentHandler: onSessionCreate ───────────────────────────────

  /**
   * Initialize session state from metadata.
   *
   * Extracts `provider` and `runtimeParams` from metadata if present.
   * Validates that the specified provider exists in the registry.
   */
  async onSessionCreate(sessionId: string, metadata?: Record<string, unknown>): Promise<void> {
    // Extract provider id from metadata, fall back to default
    const providerId = typeof metadata?.provider === 'string'
      ? metadata.provider
      : this.defaultProviderId;

    // Validate provider exists
    if (!this.registry.has(providerId)) {
      throw BridgeError.config(
        `Provider "${providerId}" is not registered in the ProviderRegistry`,
      );
    }

    // Extract session-level runtimeParams from metadata
    const sessionParams: RuntimeParams = (
      metadata?.runtimeParams !== undefined &&
      metadata.runtimeParams !== null &&
      typeof metadata.runtimeParams === 'object'
    )
      ? metadata.runtimeParams as RuntimeParams
      : {};

    this.sessions.set(sessionId, {
      providerId,
      messages: [],
      sessionParams,
      pendingPromptParams: undefined,
    });
  }

  // ── AgentHandler: onSessionClose ────────────────────────────────

  /**
   * Clean up session state.
   */
  async onSessionClose(sessionId: string, _reason?: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  // ── Additional methods (not part of AgentHandler) ───────────────

  /**
   * Set prompt-level RuntimeParams for the next prompt() call on a session.
   *
   * These params are consumed (cleared) after the next prompt() call.
   * Used by McpAgenticServer via duck-typing to pass per-request overrides.
   *
   * @param sessionId - Session to set params for.
   * @param params - RuntimeParams to apply on the next prompt.
   * @throws {BridgeError} CONFIG if session does not exist.
   */
  setPromptRuntimeParams(sessionId: string, params: RuntimeParams): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw BridgeError.config(
        `Session "${sessionId}" does not exist`,
      );
    }
    session.pendingPromptParams = params;
  }

  /**
   * Get the ProviderRegistry for discovery purposes.
   *
   * Used by agents_discover handler via duck-typing to include
   * provider information in the discovery response.
   */
  getProviderRegistry(): ProviderRegistry {
    return this.registry;
  }
}
