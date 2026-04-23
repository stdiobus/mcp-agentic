/**
 * MCP Tool: bridge_health
 *
 * Returns bridge readiness status.
 * Use before delegating when availability is uncertain.
 */

import type { AgentExecutor } from '../../executor/AgentExecutor.js';
import { mapErrorToMCP } from '../../errors/error-mapper.js';

export async function handleBridgeHealth(
  executor: AgentExecutor
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const h = await executor.health();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(h, null, 2),
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
 * Combined health handler that merges health from multiple executors.
 * Used by McpAgenticServer to combine in-process and worker health.
 */
export async function handleCombinedHealth(
  inProcessExecutor: AgentExecutor,
  workerExecutor?: AgentExecutor,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const inProcessHealth = await inProcessExecutor.health();
    const workerHealth = workerExecutor ? await workerExecutor.health() : null;

    const combined = {
      healthy: inProcessHealth.healthy || (workerHealth?.healthy ?? false),
      agents: {
        total: inProcessHealth.agents.total + (workerHealth?.agents.total ?? 0),
        ready: inProcessHealth.agents.ready + (workerHealth?.agents.ready ?? 0),
      },
      sessions: {
        active: inProcessHealth.sessions.active + (workerHealth?.sessions.active ?? 0),
        capacity: inProcessHealth.sessions.capacity + (workerHealth?.sessions.capacity ?? 0),
      },
      uptime: Math.max(inProcessHealth.uptime, workerHealth?.uptime ?? 0),
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(combined, null, 2),
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
