/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Tool: agents_discover
 *
 * Exposes agent discovery to the MCP client.
 * User can filter by capability to find the right agent for their task.
 */

import type { AgentExecutor } from '../../executor/AgentExecutor.js';
import type { AgentInfo } from '../../executor/types.js';
import type { ProviderRegistry } from '../../provider/ProviderRegistry.js';
import { AgentsDiscoverArgsSchema } from '../../types.js';
import { mapErrorToMCP } from '../../errors/error-mapper.js';

// ── Duck-typing helpers ─────────────────────────────────────────

/** Duck-type check: executor exposes getAgent(id) for agent-level introspection. */
interface ExecutorWithGetAgent {
  getAgent(agentId: string): { getProviderRegistry?: () => ProviderRegistry } | undefined;
}

/** Returns true if the executor supports getAgent() (e.g., InProcessExecutor). */
function hasGetAgent(executor: AgentExecutor): executor is AgentExecutor & ExecutorWithGetAgent {
  return typeof (executor as unknown as ExecutorWithGetAgent).getAgent === 'function';
}

/**
 * Enrich an AgentInfo with provider information if the underlying agent
 * exposes a ProviderRegistry via getProviderRegistry().
 */
function enrichWithProviders(
  agent: AgentInfo,
  executor: AgentExecutor,
): AgentInfo {
  if (!hasGetAgent(executor)) return agent;

  const handler = executor.getAgent(agent.id);
  if (!handler || typeof handler.getProviderRegistry !== 'function') return agent;

  const registry = handler.getProviderRegistry();
  const providers = registry.list();

  if (providers.length === 0) return agent;

  return { ...agent, providers };
}

/** Input shape for the `agents_discover` tool handler. */
export type AgentsDiscoverInput = {
  capability?: string | undefined;
  refresh?: boolean | undefined;
};

/**
 * Handle `agents_discover` for a single executor.
 *
 * @param executor - Executor to query.
 * @param input - Validated tool input with optional `capability` filter and `refresh` flag.
 * @returns MCP text content with the list of agents or an error payload.
 */
export async function handleAgentsDiscover(
  executor: AgentExecutor,
  input: AgentsDiscoverInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    AgentsDiscoverArgsSchema.parse(input);

    // `refresh` is accepted for backward compatibility but ignored —
    // AgentExecutor.discover() does not support cache refresh.
    const agents = await executor.discover(input.capability);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ agents }, null, 2),
      }],
    };
  } catch (error) {
    const mcpError = mapErrorToMCP(error);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: mcpError.message,
          code: mcpError.code,
          data: mcpError.data,
        }, null, 2),
      }],
    };
  }
}

/**
 * Combined discover handler that merges agents from multiple executors.
 * Used by McpAgenticServer to merge in-process and worker agents.
 * In-process agents appear first and take precedence on ID collisions.
 *
 * @param inProcessExecutor - In-process executor (always present).
 * @param workerExecutor - Optional worker executor.
 * @param input - Validated tool input with optional `capability` filter.
 * @returns MCP text content with the deduplicated list of agents or an error payload.
 */
export async function handleCombinedDiscover(
  inProcessExecutor: AgentExecutor,
  workerExecutor: AgentExecutor | undefined,
  input: AgentsDiscoverInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const parsed = AgentsDiscoverArgsSchema.parse(input);

    const inProcessAgents = await inProcessExecutor.discover(parsed.capability);
    const workerAgents = workerExecutor
      ? await workerExecutor.discover(parsed.capability)
      : [];

    // Deduplicate by agent ID, in-process agents take precedence
    const agentMap = new Map<string, AgentInfo>();
    for (const agent of inProcessAgents) {
      agentMap.set(agent.id, enrichWithProviders(agent, inProcessExecutor));
    }
    for (const agent of workerAgents) {
      if (!agentMap.has(agent.id)) {
        agentMap.set(agent.id, enrichWithProviders(agent, workerExecutor!));
      }
    }
    const agents = Array.from(agentMap.values());
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ agents }, null, 2),
      }],
    };
  } catch (error) {
    const mcpError = mapErrorToMCP(error);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: mcpError.message,
          code: mcpError.code,
          data: mcpError.data,
        }, null, 2),
      }],
    };
  }
}
