/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * createMultiProviderAgent — Sugar-helper for creating a multi-provider agent.
 *
 * Creates a {@link ProviderRegistry}, registers all providers, validates
 * the configuration, and returns a ready-to-use {@link MultiProviderCompanionAgent}.
 *
 * @module provider/factories/createMultiProviderAgent
 */

import { BridgeError } from '../../errors/BridgeError.js';
import type { AIProvider, RuntimeParams } from '../AIProvider.js';
import { ProviderRegistry } from '../ProviderRegistry.js';
import { MultiProviderCompanionAgent } from '../../agent/MultiProviderCompanionAgent.js';

// ── Types ───────────────────────────────────────────────────────

/**
 * Configuration for {@link createMultiProviderAgent}.
 */
export interface CreateMultiProviderAgentConfig {
  /** Unique agent identifier. */
  id: string;
  /** Array of AIProvider instances to register. Must be non-empty. */
  providers: AIProvider[];
  /** ID of the default provider. Must match one of the providers' `id`. */
  defaultProviderId: string;
  /** Optional list of capabilities this agent supports. */
  capabilities?: string[];
  /** Default system prompt applied to all sessions unless overridden. */
  systemPrompt?: string;
  /** Provider-level default RuntimeParams. */
  defaults?: RuntimeParams;
}

// ── Implementation ──────────────────────────────────────────────

/**
 * Create a {@link MultiProviderCompanionAgent} from an array of providers.
 *
 * Internally creates a {@link ProviderRegistry}, registers all providers,
 * and returns a ready-to-use agent instance.
 *
 * @param config - Agent configuration.
 * @returns A configured MultiProviderCompanionAgent.
 * @throws {BridgeError} CONFIG if `providers` is empty, contains duplicate ids,
 *   or `defaultProviderId` does not match any provider.
 */
export function createMultiProviderAgent(
  config: CreateMultiProviderAgentConfig,
): MultiProviderCompanionAgent {
  const { id, providers, defaultProviderId, capabilities, systemPrompt, defaults } = config;

  // 1. Validate: providers non-empty
  if (providers.length === 0) {
    throw BridgeError.config(
      'createMultiProviderAgent requires at least one provider',
    );
  }

  // 2. Validate: no duplicate provider ids
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) {
      throw BridgeError.config(
        `Duplicate provider id "${provider.id}" in createMultiProviderAgent`,
      );
    }
    seen.add(provider.id);
  }

  // 3. Validate: defaultProviderId exists in providers
  if (!seen.has(defaultProviderId)) {
    throw BridgeError.config(
      `Default provider "${defaultProviderId}" not found in providers array. ` +
      `Available: ${[...seen].join(', ')}`,
    );
  }

  // 4. Create registry and register all providers
  const registry = new ProviderRegistry();
  for (const provider of providers) {
    registry.register(provider);
  }

  // 5. Create and return agent
  return new MultiProviderCompanionAgent({
    id,
    defaultProviderId,
    registry,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(defaults !== undefined ? { defaults } : {}),
  });
}
