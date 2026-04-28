/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ProviderRegistry — Registry for AI provider instances.
 *
 * Allows registering, discovering, and retrieving {@link AIProvider}
 * instances by their unique identifier. Throws typed {@link BridgeError}
 * on duplicate registration or unknown provider lookup.
 *
 * @module provider/ProviderRegistry
 */

import { BridgeError } from '../errors/BridgeError.js';
import type { AIProvider } from './AIProvider.js';

// ── Types ───────────────────────────────────────────────────────

/** Summary information about a registered provider. */
export interface ProviderInfo {
  /** Unique provider identifier. */
  id: string;
  /** Model identifiers supported by this provider. */
  models: readonly string[];
}

// ── ProviderRegistry ────────────────────────────────────────────

/**
 * Registry of available AI providers.
 *
 * Provides registration, lookup, existence checks, and listing of
 * all registered providers.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  /**
   * Register a provider instance.
   *
   * @param provider - The AIProvider to register.
   * @throws {BridgeError} CONFIG if a provider with the same id is already registered.
   */
  register(provider: AIProvider): void {
    if (this.providers.has(provider.id)) {
      throw BridgeError.config(
        `Provider with id "${provider.id}" is already registered`,
      );
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Retrieve a registered provider by id.
   *
   * @param id - The provider identifier to look up.
   * @returns The registered AIProvider instance.
   * @throws {BridgeError} UPSTREAM if no provider with the given id is registered.
   */
  get(id: string): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw BridgeError.upstream(
        `Provider "${id}" is not registered`,
      );
    }
    return provider;
  }

  /**
   * Check whether a provider with the given id is registered.
   *
   * @param id - The provider identifier to check.
   * @returns `true` if registered, `false` otherwise.
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * List all registered providers with their id and supported models.
   *
   * @returns Array of {@link ProviderInfo} for each registered provider.
   */
  list(): ProviderInfo[] {
    const result: ProviderInfo[] = [];
    for (const provider of this.providers.values()) {
      result.push({ id: provider.id, models: provider.models });
    }
    return result;
  }
}
