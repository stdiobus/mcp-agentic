# MCP Agentic — Multi-Agent Orchestration Server

[![npm](https://img.shields.io/npm/v/@stdiobus/mcp-agentic?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/@stdiobus/mcp-agentic)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple?style=for-the-badge&logo=jsonwebtokens)](https://modelcontextprotocol.io)
[![ACP](https://img.shields.io/badge/protocol-ACP-purple?style=for-the-badge&logo=jsonwebtokens)](https://agentclientprotocol.com)
[![stdioBus](https://img.shields.io/badge/ecosystem-stdio%20Bus-ff4500?style=for-the-badge)](https://github.com/stdiobus)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=for-the-badge&logo=nodedotjs)](https://nodejs.org)
[![Build](https://img.shields.io/badge/build-esbuild-yellow?style=for-the-badge&logo=esbuild)](https://esbuild.github.io)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=for-the-badge&logo=nodedotjs)](https://github.com/stdiobus/mcp-agentic)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge&logo=opensourceinitiative)](https://github.com/stdiobus/mcp-agentic/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-407%20passing-brightgreen?style=for-the-badge&logo=jest)](https://github.com/stdiobus/mcp-agentic)

Agent orchestration server that connects MCP clients to ACP-compatible agents through [stdio Bus](https://stdiobus.com).

Agents run in-process (via `AgentHandler`) or as external worker processes (via `@stdiobus/node` StdioBus). The single entry point is `McpAgenticServer`, which owns the MCP server, tool registration, and executor lifecycle.

> **This is a public sandbox for a broader agent infrastructure platform.**
> The repository serves as an open proving ground for experimenting with MCP-accessible ACP agent orchestration, validating protocol integrations, and stress-testing runtime boundaries before selected capabilities are considered for the broader stdio Bus ecosystem.
>
> Contributions, forks, and production experiments are welcome.

## Features

- **In-process agents** — implement `AgentHandler` and register directly
- **Worker agents** — route to external ACP processes via stdio Bus
- **Multi-provider AI** — OpenAI, Anthropic, Google Gemini through native SDKs with a unified `AIProvider` interface
- **Runtime parameter control** — dynamically adjust model, temperature, systemPrompt, and more through MCP tools on every request
- **Provider discovery** — discover available providers and their models via `agents_discover`
- **8 MCP tools** — health, discovery, sessions, cancellation, one-shot delegation
- **Session management** — TTL, idle expiry, lifecycle hooks
- **Backpressure** — configurable concurrent request limiting
- **Input validation** — prompt and metadata size limits
- **Typed errors** — `BridgeError` categories with retryability info

## Basic Quick Start

Create a custom entry point that registers your agents before starting the server:

```bash
npm install @stdiobus/mcp-agentic
```

```typescript
import { McpAgenticServer } from '@stdiobus/mcp-agentic';

const server = new McpAgenticServer({ defaultAgentId: 'my-agent' })
  .register({
    id: 'my-agent',
    capabilities: ['code-analysis'],
    async prompt(sessionId, input) {
      return { text: `Analyzed: ${input}`, stopReason: 'end_turn' };
    },
  });

await server.startStdio();
```

This is the primary usage path. Without `register()` calls, no agents are available and delegation tools (`tasks_delegate`, `sessions_create`, etc.) will fail.

## Multi-Provider Quick Start

Use `MultiProviderCompanionAgent` to serve multiple AI providers through a single MCP server. Install the provider SDKs you need:

```bash
npm install @stdiobus/mcp-agentic
npm install openai @anthropic-ai/sdk @google/generative-ai
```

```typescript
import { McpAgenticServer, ProviderRegistry, OpenAIProvider, AnthropicProvider, GoogleGeminiProvider, MultiProviderCompanionAgent } from '@stdiobus/mcp-agentic';

// 1. Create providers with credentials from environment variables
const registry = new ProviderRegistry();

registry.register(new OpenAIProvider({
  credentials: { apiKey: process.env.OPENAI_API_KEY! },
  models: ['gpt-4o', 'gpt-4o-mini'],
}));

registry.register(new AnthropicProvider({
  credentials: { apiKey: process.env.ANTHROPIC_API_KEY! },
  models: ['claude-sonnet-4-20250514'],
}));

registry.register(new GoogleGeminiProvider({
  credentials: { apiKey: process.env.GOOGLE_AI_API_KEY! },
  models: ['gemini-2.0-flash'],
}));

// 2. Create a multi-provider agent
const agent = new MultiProviderCompanionAgent({
  id: 'multi-ai',
  defaultProviderId: 'openai',
  registry,
  systemPrompt: 'You are a helpful assistant.',
});

// 3. Register and start
const server = new McpAgenticServer({ defaultAgentId: 'multi-ai' })
  .register(agent);

await server.startStdio();
```

MCP clients can then select a provider per session and override parameters per prompt:

```jsonc
// Create a session with Anthropic
{ "tool": "sessions_create", "arguments": { "agentId": "multi-ai", "metadata": { "provider": "anthropic", "runtimeParams": { "model": "claude-sonnet-4-20250514" } } } }

// Send a prompt with runtime parameter overrides
{ "tool": "sessions_prompt", "arguments": { "sessionId": "...", "prompt": "Explain MCP", "runtimeParams": { "temperature": 0.3, "maxTokens": 200 } } }

// One-shot delegation with a specific provider
{ "tool": "tasks_delegate", "arguments": { "prompt": "Summarize this", "metadata": { "provider": "google-gemini" }, "runtimeParams": { "temperature": 0 } } }
```

## CLI Reference Server

The published binary (`npx @stdiobus/mcp-agentic`) starts a server with **no agents registered**. It is useful for:

- Verifying MCP connectivity (`bridge_health`)
- Inspecting the tool schema (`agents_discover` returns an empty list)
- Confirming the transport layer works end-to-end

It **cannot delegate work** — `tasks_delegate`, `sessions_create`, and `sessions_prompt` will fail because there are no agents to handle requests. For production use, create a custom entry point with `server.register()` calls as shown in Quick Start above.

The `mcp.json` shipped with this package references the CLI binary and is provided as a template. Copy and adapt it to point at your own server script.

## Architecture

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'edgeLabelBackground':'#1a1a2e','lineColor':'#4a90e2','textColor':'#ddd'}}}%%
graph LR
    C[MCP Client] -->|MCP tools| S[McpAgenticServer] --> IPE[InProcessExecutor]
    IPE -->|AgentHandler| MCA[MultiProviderCompanionAgent]
    MCA --> PR[ProviderRegistry]
    PR --> OP[OpenAIProvider] --> OSDK[openai]
    PR --> AP[AnthropicProvider] --> ASDK["@anthropic-ai/sdk"]
    PR --> GP[GoogleGeminiProvider] --> GSDK["@google/generative-ai"]

    %% ── Styles ──
    classDef client fill:#1a1a2e,stroke:#f39c12,stroke-width:2px,color:#fff
    classDef kernel fill:#1a1a2e,stroke:#4a90e2,stroke-width:3px,color:#fff,font-weight:bold
    classDef worker fill:#16213e,stroke:#50c878,stroke-width:2px,color:#fff
    classDef agent fill:#0f3460,stroke:#9b59b6,stroke-width:1px,color:#ddd
    classDef proxy fill:#16213e,stroke:#e67e22,stroke-width:2px,color:#fff
    classDef external fill:#1a1a2e,stroke:#95a5a6,stroke-width:1px,color:#bbb,font-style:italic

    class C client
    class S,IPE kernel
    class MCA agent
    class PR proxy
    class OP,AP,GP worker
    class OSDK,ASDK,GSDK external
```

<details>
<summary>Session lifecycle — create → prompt → close (in-process agent)</summary>

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'actorBkg':'#1a1a2e','actorBorder':'#4a90e2','actorTextColor':'#fff','signalColor':'#50c878','signalTextColor':'#ddd','noteBkgColor':'#16213e','noteTextColor':'#fff','noteBorderColor':'#e67e22','activationBkgColor':'#0f3460','activationBorderColor':'#9b59b6','sequenceNumberColor':'#f39c12'}}}%%
sequenceDiagram
    participant C as MCP Client
    participant S as McpAgenticServer
    participant E as InProcessExecutor
    participant A as AgentHandler

    C->>S: sessions_create({ agentId })
    S->>S: validateMetadataSize()
    S->>S: resolveExecutor(agentId)
    S->>E: createSession(agentId, metadata)
    E->>A: onSessionCreate(sessionId)
    E-->>S: SessionEntry { sessionId, agentId, status }
    S-->>C: { sessionId, agentId, status: "active" }

    C->>S: sessions_prompt({ sessionId, prompt })
    S->>S: validatePromptSize()
    S->>S: resolveExecutorForSession(sessionId)
    S->>E: prompt(sessionId, input)
    E->>A: prompt(sessionId, input, opts)
    A-->>E: AgentResult { text, stopReason }
    E-->>S: AgentResult
    S-->>C: { text, stopReason }

    C->>S: sessions_close({ sessionId })
    S->>S: resolveExecutorForSession(sessionId)
    S->>E: closeSession(sessionId)
    E->>A: onSessionClose(sessionId)
    E-->>S: void
    S-->>C: { closed: true }
```

</details>

<details>
<summary>sessions_prompt with runtimeParams — parameter merge and provider delegation</summary>

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'actorBkg':'#1a1a2e','actorBorder':'#4a90e2','actorTextColor':'#fff','signalColor':'#50c878','signalTextColor':'#ddd','noteBkgColor':'#16213e','noteTextColor':'#fff','noteBorderColor':'#e67e22','activationBkgColor':'#0f3460','activationBorderColor':'#9b59b6','sequenceNumberColor':'#f39c12'}}}%%
sequenceDiagram
    participant Client as MCP Client
    participant Server as McpAgenticServer
    participant Executor as InProcessExecutor
    participant Agent as MultiProviderCompanionAgent
    participant Registry as ProviderRegistry
    participant Provider as AIProvider

    Client->>Server: sessions_prompt({ sessionId, prompt, runtimeParams })
    Server->>Server: validatePromptSize + withBackpressure
    Server->>Server: resolveExecutorForSession(sessionId)
    Note over Server: If runtimeParams present, pass to<br/>agent.setPromptRuntimeParams()
    Server->>Executor: prompt(sessionId, input, opts)
    Executor->>Agent: prompt(sessionId, input, opts)
    Agent->>Agent: merge(configDefaults, sessionParams, promptParams)
    Agent->>Registry: get(resolvedProviderId)
    Registry-->>Agent: provider instance
    Agent->>Provider: complete(messages, mergedParams, signal)
    Provider-->>Agent: AIProviderResult
    Agent->>Agent: append to conversation history
    Agent-->>Executor: AgentResult
    Executor-->>Server: AgentResult
    Server-->>Client: MCP response
```

</details>

<details>
<summary>sessions_create with provider selection — binding a session to a specific AI provider</summary>

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'actorBkg':'#1a1a2e','actorBorder':'#4a90e2','actorTextColor':'#fff','signalColor':'#50c878','signalTextColor':'#ddd','noteBkgColor':'#16213e','noteTextColor':'#fff','noteBorderColor':'#e67e22','activationBkgColor':'#0f3460','activationBorderColor':'#9b59b6','sequenceNumberColor':'#f39c12'}}}%%
sequenceDiagram
    participant Client as MCP Client
    participant Server as McpAgenticServer
    participant Executor as InProcessExecutor
    participant Agent as MultiProviderCompanionAgent

    Client->>Server: sessions_create({ agentId, metadata: {<br/>provider: "anthropic",<br/>runtimeParams: { model: "claude-sonnet-4-20250514" } } })
    Server->>Executor: createSession(agentId, metadata)
    Executor->>Agent: onSessionCreate(sessionId, metadata)
    Agent->>Agent: extract provider + runtimeParams from metadata
    Agent->>Agent: validate provider exists in registry
    Agent->>Agent: store SessionState with providerId + sessionParams
    Agent-->>Executor: void
    Executor-->>Server: SessionEntry
    Server-->>Client: { sessionId, agentId, status }
```

</details>

<details>
<summary>One-shot delegation — tasks_delegate flow</summary>

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'actorBkg':'#1a1a2e','actorBorder':'#4a90e2','actorTextColor':'#fff','signalColor':'#50c878','signalTextColor':'#ddd','noteBkgColor':'#16213e','noteTextColor':'#fff','noteBorderColor':'#e67e22','activationBkgColor':'#0f3460','activationBorderColor':'#9b59b6','sequenceNumberColor':'#f39c12'}}}%%
sequenceDiagram
    participant C as MCP Client
    participant S as McpAgenticServer
    participant E as AgentExecutor
    participant A as Agent

    C->>S: tasks_delegate({ agentId, prompt })
    S->>S: validatePromptSize()
    S->>S: validateMetadataSize()
    S->>S: resolveExecutor(agentId)
    S->>E: createSession(agentId)
    E-->>S: SessionEntry { sessionId }
    S->>E: prompt(sessionId, input)
    E->>A: prompt(sessionId, input)
    A-->>E: AgentResult { text, stopReason }
    E-->>S: AgentResult
    S->>E: closeSession(sessionId, "task-complete")
    E-->>S: void
    S-->>C: { success: true, text, stopReason }
```

</details>

<details>
<summary>Worker path — external ACP process via StdioBus</summary>

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'actorBkg':'#1a1a2e','actorBorder':'#4a90e2','actorTextColor':'#fff','signalColor':'#50c878','signalTextColor':'#ddd','noteBkgColor':'#16213e','noteTextColor':'#fff','noteBorderColor':'#e67e22','activationBkgColor':'#0f3460','activationBorderColor':'#9b59b6','sequenceNumberColor':'#f39c12'}}}%%
sequenceDiagram
    participant C as MCP Client
    participant S as McpAgenticServer
    participant W as WorkerExecutor
    participant B as StdioBus
    participant P as ACP Worker Process

    C->>S: sessions_prompt({ sessionId, prompt })
    S->>S: resolveExecutorForSession(sessionId)
    S->>W: prompt(sessionId, input)
    W->>B: bus.request("session/prompt", { sessionId, input })
    B->>P: JSON-RPC via stdin
    P-->>B: JSON-RPC response via stdout
    B-->>W: { text, stopReason }
    W->>W: validate response
    W-->>S: AgentResult
    S-->>C: { text, stopReason }
```

</details>

<details>
<summary>Executor resolution — in-process priority and caching</summary>

```mermaid
%%{init: {'theme':'dark', 'themeVariables':{'actorBkg':'#1a1a2e','actorBorder':'#4a90e2','actorTextColor':'#fff','signalColor':'#50c878','signalTextColor':'#ddd','noteBkgColor':'#16213e','noteTextColor':'#fff','noteBorderColor':'#e67e22','activationBkgColor':'#0f3460','activationBorderColor':'#9b59b6','sequenceNumberColor':'#f39c12'}}}%%
sequenceDiagram
    participant S as McpAgenticServer
    participant Cache as agentExecutorCache
    participant IP as InProcessExecutor
    participant WE as WorkerExecutor

    S->>Cache: get(agentId)
    alt cache hit
        Cache-->>S: executor
    else cache miss
        S->>IP: discover()
        IP-->>S: AgentInfo[]
        alt agent found in-process
            S->>Cache: set(agentId, InProcessExecutor)
            S-->>S: return InProcessExecutor
        else not in-process
            S->>WE: discover()
            WE-->>S: AgentInfo[]
            alt agent found in workers
                S->>Cache: set(agentId, WorkerExecutor)
                S-->>S: return WorkerExecutor
            else not found anywhere
                S-->>S: return InProcessExecutor (will throw "Agent not found")
            end
        end
    end
```

</details>

## MCP Tools

| Tool | Description | Notes |
|------|-------------|-------|
| `bridge_health` | Check bridge readiness | |
| `agents_discover` | List available agents, optionally filter by capability | Response includes `providers` field with provider IDs and models when the agent supports multiple providers |
| `sessions_create` | Create a new agent session | Pass `metadata.provider` to select a provider; pass `metadata.runtimeParams` for session-level defaults |
| `sessions_prompt` | Send a prompt to an existing session | Accepts optional `runtimeParams` for per-prompt overrides (model, temperature, systemPrompt, etc.) |
| `sessions_status` | Check session status | |
| `sessions_close` | Close a session | |
| `sessions_cancel` | Cancel an in-flight prompt | |
| `tasks_delegate` | One-shot delegation (create + prompt + close) | Accepts optional `runtimeParams` for parameter overrides; pass `metadata.provider` to select a provider |

## Configuration

`McpAgenticServer` accepts a `McpAgenticServerConfig`:

```typescript
interface McpAgenticServerConfig {
  agents?: AgentHandler[];
  defaultAgentId?: string;
  maxConcurrentRequests?: number;  // default: 50
  maxPromptBytes?: number;         // default: 1048576 (1 MiB)
  maxMetadataBytes?: number;       // default: 65536 (64 KiB)
}
```

### Worker registration

```typescript
server.registerWorker({
  id: 'py-agent',
  command: 'python',
  args: ['agent.py'],
  env: { API_KEY: process.env.API_KEY },
  capabilities: ['data-analysis'],
});
```

### Provider configuration

Each provider is constructed with a `ProviderConfig`:

```typescript
interface ProviderConfig {
  /** Credential key-value pairs sourced from environment variables. */
  credentials: Record<string, string>;
  /** Model identifiers available for this provider. */
  models: string[];
  /** Default RuntimeParams applied when no override is specified. */
  defaults?: RuntimeParams;
}
```

Example:

```typescript
import { OpenAIProvider, AnthropicProvider } from '@stdiobus/mcp-agentic';

const openai = new OpenAIProvider({
  credentials: { apiKey: process.env.OPENAI_API_KEY! },
  models: ['gpt-4o', 'gpt-4o-mini'],
  defaults: { temperature: 0.7, maxTokens: 4096 },
});

const anthropic = new AnthropicProvider({
  credentials: { apiKey: process.env.ANTHROPIC_API_KEY! },
  models: ['claude-sonnet-4-20250514'],
  defaults: { temperature: 0.5 },
});
```

### RuntimeParams

`RuntimeParams` controls AI generation behavior and can be specified at three levels with ascending priority:

```
ProviderConfig.defaults  <  session metadata.runtimeParams  <  prompt-level runtimeParams
```

Only defined fields override lower-priority values. `undefined` fields are ignored during merge. `providerSpecific` is shallow-merged across all layers.

```typescript
interface RuntimeParams {
  model?: string;              // Model identifier
  temperature?: number;        // Sampling temperature (0–2)
  maxTokens?: number;          // Maximum tokens to generate
  topP?: number;               // Nucleus sampling (0–1)
  topK?: number;               // Top-K sampling
  stopSequences?: string[];    // Stop sequences
  systemPrompt?: string;       // System prompt override
  providerSpecific?: Record<string, unknown>;  // Provider-native parameters
}
```

## Public API

Exported from `@stdiobus/mcp-agentic`:

**Core types:**

- `McpAgenticServer` — main server class
- `McpAgenticServerConfig` — server configuration type
- `AgentHandler` / `Agent` — agent interface
- `AgentResult`, `AgentEvent`, `AgentChunk`, `AgentFinal`, `AgentError` — result types
- `PromptOpts`, `StreamOpts` — option types
- `WorkerConfig` — worker configuration type

**Provider Layer:**

- `AIProvider` — unified provider interface
- `AIProviderResult` — normalized provider response type
- `RuntimeParams` — generation parameter type
- `ProviderConfig` — provider configuration type
- `ChatMessage` — standard message format type
- `ProviderRegistry` — provider registry class
- `ProviderInfo` — provider info type (id + models)
- `mergeRuntimeParams` — three-level parameter merge utility
- `OpenAIProvider` — OpenAI provider via native SDK
- `AnthropicProvider` — Anthropic provider via native SDK
- `GoogleGeminiProvider` — Google Gemini provider via native SDK

**Multi-Provider Agent:**

- `MultiProviderCompanionAgent` — agent supporting multiple AI providers
- `MultiProviderCompanionConfig` — multi-provider agent configuration type

## Development

```bash
npm install
npm run build        # esbuild + tsc declarations
npm run typecheck    # type checking only
npm run test:unit    # unit tests (Jest)
npm run test:e2e     # end-to-end tests
npm run test:all     # unit + e2e
npm run test:e2e:providers  # live provider e2e tests (requires API keys)
```

### Peer dependencies for provider development

The provider SDKs are peer/optional dependencies. Install only the ones you need:

```bash
npm install openai                  # OpenAI provider
npm install @anthropic-ai/sdk       # Anthropic provider
npm install @google/generative-ai   # Google Gemini provider
```

### Live provider e2e tests

The `test:e2e:providers` script runs end-to-end tests against real AI provider APIs. Tests are skipped automatically when the corresponding API key is not set:

| Environment Variable | Provider |
|---------------------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_AI_API_KEY` | Google Gemini |

## Steering Guides

- [Activation and Scope](steering/activation-and-scope.md)
- [Discovery and Routing](steering/discovery-and-routing.md)
- [Delegation and Session Lifecycle](steering/delegation-and-session-lifecycle.md)
- [Failure Handling](steering/failure-handling.md)
- [Configuration](steering/configuration.md)

## What's Next

MCP Agentic is built to grow. The architecture has no hard limits on the number of tools, agents, or execution backends. Current v1.0 ships with 8 MCP tools and two backends (in-process + worker). Next up: agent registry management, session persistence, operator-level permission controls, and more.

Follow the repo for updates. The project uses semantic versioning.

## License

Apache-2.0
