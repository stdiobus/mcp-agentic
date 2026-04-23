/**
 * MCP Tool: agents_discover
 *
 * Exposes agent discovery to the MCP client.
 * User can filter by capability to find the right agent for their task.
 */

import type { AgentExecutor } from '../../executor/AgentExecutor.js';
import type { AgentInfo } from '../../executor/types.js';
import { AgentsDiscoverArgsSchema } from '../../types.js';
import { mapErrorToMCP } from '../../errors/error-mapper.js';

export type AgentsDiscoverInput = {
  capability?: string | undefined;
  refresh?: boolean | undefined;
};

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
 * In-process agents appear first in the result.
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
      agentMap.set(agent.id, agent);
    }
    for (const agent of workerAgents) {
      if (!agentMap.has(agent.id)) {
        agentMap.set(agent.id, agent);
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
