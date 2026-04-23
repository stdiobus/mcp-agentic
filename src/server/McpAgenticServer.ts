/**
 * McpAgenticServer — Single public entry point for MCP Agentic.
 *
 * Owns the MCP server, tool registration, and executor lifecycle.
 * Users create an instance, register agents (in-process or workers),
 * and call `startStdio()` to begin serving MCP tool calls.
 *
 * Tool logic lives in `src/mcp/tools/*.ts`. This class only:
 *   1. Resolves the correct executor for each request
 *   2. Delegates to the appropriate handler function
 *   3. Returns the result
 *
 * @example
 * const server = new McpAgenticServer()
 *   .register(myAgent)
 *   .registerWorker({ id: 'py-agent', command: 'python', args: ['agent.py'] });
 *
 * await server.startStdio();
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { AgentHandler, Agent } from '../agent/AgentHandler.js';
import type { AgentExecutor } from '../executor/AgentExecutor.js';
import type { WorkerConfig } from '../executor/types.js';
import { InProcessExecutor } from '../executor/InProcessExecutor.js';
import { WorkerExecutor } from '../executor/WorkerExecutor.js';
import { BridgeError } from '../errors/BridgeError.js';

import {
  AgentsDiscoverArgsSchema,
  SessionsCreateArgsSchema,
  SessionsPromptArgsSchema,
  SessionsStatusArgsSchema,
  SessionsCloseArgsSchema,
  SessionsCancelArgsSchema,
  TasksDelegateArgsSchema,
} from '../types.js';

import {
  bridgeHealthDef,
  agentsDiscoverDef,
  sessionsCreateDef,
  sessionsPromptDef,
  sessionsStatusDef,
  sessionsCloseDef,
  sessionsCancelDef,
  tasksDelegateDef,
} from '../mcp/tool-definitions.js';

// ─── Tool handler imports ────────────────────────────────────────

import { handleCombinedHealth } from '../mcp/tools/health.js';
import { handleCombinedDiscover } from '../mcp/tools/agents.js';
import {
  handleSessionsCreate,
  handleSessionsPrompt,
  handleSessionsStatus,
  handleSessionsClose,
  handleSessionsCancel,
} from '../mcp/tools/sessions.js';
import { handleTasksDelegate } from '../mcp/tools/tasks.js';
import type { TasksDelegateInput } from '../mcp/tools/tasks.js';

// ─── Config ──────────────────────────────────────────────────────

export interface McpAgenticServerConfig {
  /** Pre-register in-process agents at construction time. */
  agents?: AgentHandler[];
  /** Default agent ID for session creation when none is specified. */
  defaultAgentId?: string;
  /** Maximum number of concurrent in-flight tool requests. Default: 50. */
  maxConcurrentRequests?: number;
  /** Maximum prompt size in bytes. Default: 1048576 (1 MiB). */
  maxPromptBytes?: number;
  /** Maximum metadata size in bytes (JSON-serialized). Default: 65536 (64 KiB). */
  maxMetadataBytes?: number;
  /** When true, suppresses process.stderr.write logging from executors. Default: false. */
  silent?: boolean;
}

// ─── McpAgenticServer ────────────────────────────────────────────

export class McpAgenticServer {
  private readonly inProcess: InProcessExecutor;
  private worker: WorkerExecutor | undefined;
  private readonly mcpServer: McpServer;
  private readonly _config: McpAgenticServerConfig;

  /** Cache mapping agent ID → executor that owns it. Invalidated on register/registerWorker. */
  private agentExecutorCache: Map<string, AgentExecutor> = new Map();

  /** Number of currently in-flight tool handler calls. */
  private activeRequests = 0;

  /** Maximum allowed concurrent in-flight requests. */
  private readonly maxConcurrentRequests: number;

  /** Maximum prompt size in bytes. */
  private readonly maxPromptBytes: number;

  /** Maximum metadata size in bytes (JSON-serialized). */
  private readonly maxMetadataBytes: number;

  constructor(config?: McpAgenticServerConfig) {
    this._config = config ?? {};
    this.maxConcurrentRequests = this._config.maxConcurrentRequests ?? 50;
    this.maxPromptBytes = this._config.maxPromptBytes ?? 1_048_576;
    this.maxMetadataBytes = this._config.maxMetadataBytes ?? 65_536;
    this.inProcess = new InProcessExecutor({ silent: this._config.silent ?? false });

    // Pre-register agents from config
    if (this._config.agents) {
      for (const agent of this._config.agents) {
        this.inProcess.register(agent);
      }
    }

    // Create MCP server with tool capabilities using the non-deprecated McpServer API
    this.mcpServer = new McpServer(
      { name: 'mcp-agentic', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    this.registerToolHandlers();
  }

  // ── Fluent registration API ───────────────────────────────────

  /**
   * Register an in-process agent.
   * @returns `this` for chaining.
   */
  register(agent: Agent): McpAgenticServer {
    this.inProcess.register(agent);
    this.agentExecutorCache.clear();
    return this;
  }

  /**
   * Register an external worker process.
   * Lazily creates the WorkerExecutor on first call.
   * @returns `this` for chaining.
   */
  registerWorker(config: WorkerConfig): McpAgenticServer {
    if (!this.worker) {
      this.worker = new WorkerExecutor({ silent: this._config.silent ?? false });
    }
    this.worker.addWorker(config);
    this.agentExecutorCache.clear();
    return this;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Start executors and connect the MCP server via stdio transport.
   */
  async startStdio(): Promise<void> {
    await this.inProcess.start();

    if (this.worker) {
      await this.worker.start();
    }

    // Populate the agent executor cache after starting executors.
    // In-process agents are added first so they take priority.
    await this.populateAgentExecutorCache();

    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
  }

  /**
   * Gracefully shut down executors and the MCP server.
   */
  async close(): Promise<void> {
    await this.mcpServer.close();

    if (this.worker) {
      await this.worker.close();
    }

    await this.inProcess.close();
  }

  // ── Executor resolution ───────────────────────────────────────

  /**
   * Resolve which executor handles a given agent ID.
   * In-process agents take priority over workers.
   *
   * Uses the agentExecutorCache for fast lookups. On cache miss,
   * falls back to discover() and populates the cache entry.
   *
   * When no agentId is provided, returns the in-process executor
   * if it has agents, otherwise the worker executor.
   */
  private async resolveExecutor(agentId?: string): Promise<AgentExecutor> {
    // Apply defaultAgentId when no explicit agentId is provided
    const effectiveAgentId = agentId ?? this._config.defaultAgentId;

    if (effectiveAgentId !== undefined) {
      // Check cache first
      const cached = this.agentExecutorCache.get(effectiveAgentId);
      if (cached) {
        return cached;
      }

      // Cache miss — fall back to discover() and populate cache on hit
      const inProcessAgents = await this.inProcess.discover();
      if (inProcessAgents.some(a => a.id === effectiveAgentId)) {
        this.agentExecutorCache.set(effectiveAgentId, this.inProcess);
        return this.inProcess;
      }

      if (this.worker) {
        const workerAgents = await this.worker.discover();
        if (workerAgents.some(a => a.id === effectiveAgentId)) {
          this.agentExecutorCache.set(effectiveAgentId, this.worker);
          return this.worker;
        }
      }

      // Fall through to in-process — it will throw "Agent not found"
      return this.inProcess;
    }

    // No agentId and no defaultAgentId: prefer in-process if it has agents
    const inProcessAgents = await this.inProcess.discover();
    if (inProcessAgents.length > 0) {
      return this.inProcess;
    }

    if (this.worker) {
      return this.worker;
    }

    // No agents anywhere — return in-process, it will throw appropriately
    return this.inProcess;
  }

  /**
   * Populate the agent executor cache by calling discover() on each executor.
   * In-process agents are added first so they take priority over workers.
   */
  private async populateAgentExecutorCache(): Promise<void> {
    this.agentExecutorCache.clear();

    // In-process agents first (they take priority)
    const inProcessAgents = await this.inProcess.discover();
    for (const agent of inProcessAgents) {
      this.agentExecutorCache.set(agent.id, this.inProcess);
    }

    // Worker agents second (only if not already in cache from in-process)
    if (this.worker) {
      const workerAgents = await this.worker.discover();
      for (const agent of workerAgents) {
        if (!this.agentExecutorCache.has(agent.id)) {
          this.agentExecutorCache.set(agent.id, this.worker);
        }
      }
    }
  }

  /**
   * Find which executor owns a given session ID.
   * Checks in-process first, then workers.
   */
  private async resolveExecutorForSession(sessionId: string): Promise<AgentExecutor> {
    // Try in-process first
    try {
      await this.inProcess.getSession(sessionId);
      return this.inProcess;
    } catch {
      // Not found in in-process, try workers
    }

    if (this.worker) {
      try {
        await this.worker.getSession(sessionId);
        return this.worker;
      } catch {
        // Not found in workers either
      }
    }

    // Return in-process — it will throw the appropriate "session not found" error
    return this.inProcess;
  }

  // ── Backpressure ───────────────────────────────────────────────

  /**
   * Wrap a handler call with backpressure limiting.
   * Rejects with a retryable transport error when the server is overloaded.
   */
  private async withBackpressure<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeRequests >= this.maxConcurrentRequests) {
      throw BridgeError.transport('Server overloaded', { retryable: true });
    }
    this.activeRequests++;
    try {
      return await fn();
    } finally {
      this.activeRequests--;
    }
  }

  // ── Input size validation ────────────────────────────────────────

  /**
   * Validate that a prompt does not exceed the configured maximum size.
   * @throws BridgeError.upstream when the prompt is too large.
   */
  private validatePromptSize(prompt: string): void {
    if (Buffer.byteLength(prompt) > this.maxPromptBytes) {
      throw BridgeError.upstream('Prompt exceeds maximum size');
    }
  }

  /**
   * Validate that metadata (JSON-serialized) does not exceed the configured maximum size.
   * @throws BridgeError.upstream when the metadata is too large.
   */
  private validateMetadataSize(metadata?: Record<string, unknown>): void {
    if (metadata !== undefined && Buffer.byteLength(JSON.stringify(metadata)) > this.maxMetadataBytes) {
      throw BridgeError.upstream('Metadata exceeds maximum size');
    }
  }

  // ── Tool registration ─────────────────────────────────────────
  //
  // Each tool: resolve executor → call handler → return result.
  // All tool logic lives in src/mcp/tools/*.ts.

  private registerToolHandlers(): void {
    // Tool descriptions sourced from centralized tool-definitions.ts
    this.mcpServer.registerTool(bridgeHealthDef.name, {
      description: bridgeHealthDef.description,
    }, async () => this.withBackpressure(() => handleCombinedHealth(this.inProcess, this.worker)));

    this.mcpServer.registerTool(agentsDiscoverDef.name, {
      description: agentsDiscoverDef.description,
      inputSchema: AgentsDiscoverArgsSchema,
    }, async (args) => this.withBackpressure(() => handleCombinedDiscover(this.inProcess, this.worker, args)));

    this.mcpServer.registerTool(sessionsCreateDef.name, {
      description: sessionsCreateDef.description,
      inputSchema: SessionsCreateArgsSchema,
    }, async (args) => this.withBackpressure(async () => {
      this.validateMetadataSize(args.metadata as Record<string, unknown> | undefined);
      const agentId = args.agentId ?? args.workerId;
      const executor = await this.resolveExecutor(agentId);
      return handleSessionsCreate(executor, args);
    }));

    this.mcpServer.registerTool(sessionsPromptDef.name, {
      description: sessionsPromptDef.description,
      inputSchema: SessionsPromptArgsSchema,
    }, async (args) => this.withBackpressure(async () => {
      this.validatePromptSize(args.prompt);
      const executor = await this.resolveExecutorForSession(args.sessionId);
      return handleSessionsPrompt(executor, args);
    }));

    this.mcpServer.registerTool(sessionsStatusDef.name, {
      description: sessionsStatusDef.description,
      inputSchema: SessionsStatusArgsSchema,
    }, async (args) => this.withBackpressure(async () => {
      const executor = await this.resolveExecutorForSession(args.sessionId);
      return handleSessionsStatus(executor, args);
    }));

    this.mcpServer.registerTool(sessionsCloseDef.name, {
      description: sessionsCloseDef.description,
      inputSchema: SessionsCloseArgsSchema,
    }, async (args) => this.withBackpressure(async () => {
      const executor = await this.resolveExecutorForSession(args.sessionId);
      return handleSessionsClose(executor, args);
    }));

    this.mcpServer.registerTool(sessionsCancelDef.name, {
      description: sessionsCancelDef.description,
      inputSchema: SessionsCancelArgsSchema,
    }, async (args) => this.withBackpressure(async () => {
      const executor = await this.resolveExecutorForSession(args.sessionId);
      return handleSessionsCancel(executor, args);
    }));

    this.mcpServer.registerTool(tasksDelegateDef.name, {
      description: tasksDelegateDef.description,
      inputSchema: TasksDelegateArgsSchema,
    }, async (args) => this.withBackpressure(async () => {
      this.validatePromptSize(args.prompt);
      this.validateMetadataSize(args.metadata as Record<string, unknown> | undefined);
      const executor = await this.resolveExecutor(args.agentId);
      return handleTasksDelegate(executor, args as TasksDelegateInput);
    }));
  }
}
