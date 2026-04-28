# Configuration

## McpAgenticServerConfig

`McpAgenticServer` is configured via a `McpAgenticServerConfig` object passed to the constructor. There is no external config file or `AGENT_CONFIG_PATH` environment variable.

```typescript
interface McpAgenticServerConfig {
  agents?: AgentHandler[];         // Pre-register in-process agents
  defaultAgentId?: string;         // Default agent when none specified
  maxConcurrentRequests?: number;  // Backpressure limit (default: 50)
  maxPromptBytes?: number;         // Max prompt size (default: 1 MiB)
  maxMetadataBytes?: number;       // Max metadata size (default: 64 KiB)
  silent?: boolean;                // Suppress executor stderr logging (default: false)
}
```

## In-process agents

Register agents programmatically using the fluent API:

```typescript
import { McpAgenticServer } from '@stdiobus/mcp-agentic';

const server = new McpAgenticServer({ defaultAgentId: 'my-agent' })
  .register({
    id: 'my-agent',
    capabilities: ['code-analysis', 'debugging'],
    async prompt(sessionId, input) {
      return { text: `Response: ${input}`, stopReason: 'end_turn' };
    },
  });
```

### AgentHandler interface

Agents implement the `AgentHandler` interface:

```typescript
interface AgentHandler {
  readonly id: string;
  readonly capabilities?: string[];
  prompt?(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;
  stream?(sessionId: string, input: string, opts?: StreamOpts): AsyncIterable<AgentEvent>;
  onSessionCreate?(sessionId: string, metadata?: Record<string, unknown>): Promise<void>;
  onSessionClose?(sessionId: string, reason?: string): Promise<void>;
  cancel?(sessionId: string, requestId?: string): Promise<void>;
}
```

At minimum, implement `id` and either `prompt` or `stream`.

## Worker configuration

Register external worker processes via `registerWorker()`:

```typescript
server.registerWorker({
  id: 'py-agent',
  command: 'python',
  args: ['agent.py'],
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' },
  capabilities: ['data-analysis'],
});
```

### WorkerConfig

```typescript
interface WorkerConfig {
  id: string;                       // Unique worker/agent ID
  command: string;                  // Executable to spawn
  args: string[];                   // Command-line arguments
  env?: Record<string, string>;     // Additional environment variables
  capabilities?: string[];          // Advertised capabilities
}
```

The `WorkerExecutor` creates a `StdioBus` instance on `start()` with pool configurations derived from registered `WorkerConfig` entries. The `env` field is passed through to the StdioBus pool so worker processes receive the specified environment variables.

## Backpressure

`maxConcurrentRequests` (default: 50) limits the number of in-flight tool handler calls. When the limit is reached, new requests are rejected with a retryable `BridgeError.transport('Server overloaded')`.

## Input size validation

- `maxPromptBytes` (default: 1,048,576 / 1 MiB) — maximum prompt size in bytes
- `maxMetadataBytes` (default: 65,536 / 64 KiB) — maximum metadata size in bytes (JSON-serialized)

Prompts and metadata are validated before being forwarded to the executor. Oversized inputs are rejected with `BridgeError.upstream`.

## Session limits

The `InProcessExecutor` enforces a configurable `maxSessions` limit (default: 100). Sessions also have:

- **Session TTL** (`sessionTtlMs`, default: 3,600,000 / 1 hour) — maximum session lifetime
- **Idle timeout** (`sessionIdleMs`, default: 600,000 / 10 minutes) — maximum idle time before expiry

Expired sessions are reaped automatically and the agent's `onSessionClose` hook is called with reason `'expired'`.

## Logging

Executors log lifecycle events (start, close, errors) to stderr via `process.stderr.write`. This logging is controlled by the `silent` flag in `McpAgenticServerConfig`:

- `silent: false` (default) — executors write lifecycle messages to stderr
- `silent: true` — all executor logging is suppressed (useful for tests)

stdout is reserved for MCP protocol messages — never write non-protocol data there.

> **Note:** The `Logger` class in `src/observability/logger.ts` and `LoggingConfig` type exist internally but are not exposed through `McpAgenticServerConfig`. They are used by `RemoteAgenticBridge` (SaaS mode) and may be integrated into the public API in a future version.

## CLI entry point

The CLI entry point (`src/cli/server.ts`) is a **reference/diagnostics server** with no agents registered. It starts the MCP server and warns on stderr:

```typescript
import { McpAgenticServer } from '../index.js';

const server = new McpAgenticServer();
await server.startStdio();

// Warns: "No agents registered. This CLI is a reference server for diagnostics only."
```

`bridge_health` and `agents_discover` will respond (healthy: false / empty list), but `tasks_delegate` and `sessions_create` will fail because there are no agents.

For actual agent delegation, create your own entry point that calls `server.register()` before `server.startStdio()`.

## Best practices

1. **Use in-process agents for development** — simpler setup, faster iteration
2. **Use workers for production isolation** — separate processes for reliability
3. **Set appropriate limits** — tune `maxConcurrentRequests`, `maxPromptBytes`, and session limits for your workload
4. **Pass credentials via `env`** — use `WorkerConfig.env` for worker process secrets
5. **Handle signals** — always wire up `SIGINT`/`SIGTERM` to `server.close()`
6. **Monitor health** — use `bridge_health` to check readiness before delegating
7. **Install only needed SDKs** — provider SDKs are peer/optional dependencies; install only the ones you use
8. **Use runtime params for dynamic control** — adjust model, temperature, and system prompt per request without restarting

## Provider configuration

### ProviderConfig

Each AI provider is constructed with a `ProviderConfig` that separates credentials from behavior:

```typescript
interface ProviderConfig {
  credentials: Record<string, string>;  // e.g., { apiKey: 'sk-...' }
  models: string[];                      // e.g., ['gpt-4o', 'gpt-4o-mini']
  defaults?: RuntimeParams;              // Default generation parameters
}
```

- `credentials` — key-value pairs sourced from environment variables by the caller. Providers do not access `process.env` directly after construction.
- `models` — list of model identifiers available for this provider.
- `defaults` — optional default `RuntimeParams` applied when no override is specified.

### Credential validation:

Providers validate required credentials at construction time. If a required key (e.g., `apiKey`) is missing or empty, the constructor throws `BridgeError.config('Missing required credential: apiKey')`.

### Example:

```typescript
import { OpenAIProvider } from '@stdiobus/mcp-agentic';

const openai = new OpenAIProvider({
  credentials: { apiKey: process.env.OPENAI_API_KEY ?? '' },
  models: ['gpt-4o', 'gpt-4o-mini'],
  defaults: { temperature: 0.7, maxTokens: 4096 },
});
```

## Multi-provider agent setup

### MultiProviderCompanionConfig

`MultiProviderCompanionAgent` is configured with a `ProviderRegistry` and a default provider:

```typescript
interface MultiProviderCompanionConfig {
  id: string;                    // Unique agent identifier
  defaultProviderId: string;     // Provider used when none specified
  registry: ProviderRegistry;    // Registry of available providers
  capabilities?: string[];       // Agent capabilities for discovery
  systemPrompt?: string;         // Default system prompt
  defaults?: RuntimeParams;      // Agent-level default parameters
}
```

### ProviderRegistry

The `ProviderRegistry` manages provider instances:

```typescript
const registry = new ProviderRegistry();
registry.register(openaiProvider);    // Register OpenAI
registry.register(anthropicProvider); // Register Anthropic
registry.register(geminiProvider);    // Register Gemini

registry.has('openai');    // true
registry.get('openai');    // Returns the OpenAI provider instance
registry.list();           // [{ id: 'openai', models: [...] }, ...]
```

- `register(provider)` — throws `BridgeError.config` if a provider with the same id is already registered
- `get(id)` — throws `BridgeError.upstream` if the provider is not found
- `has(id)` — returns boolean
- `list()` — returns `ProviderInfo[]` with id and models for each provider

### Full server setup example:

```typescript
import {
  McpAgenticServer,
  ProviderRegistry,
  MultiProviderCompanionAgent,
  OpenAIProvider,
  AnthropicProvider,
  GoogleGeminiProvider,
} from '@stdiobus/mcp-agentic';

// Create providers
const registry = new ProviderRegistry();

registry.register(new OpenAIProvider({
  credentials: { apiKey: process.env.OPENAI_API_KEY ?? '' },
  models: ['gpt-4o', 'gpt-4o-mini'],
}));

registry.register(new AnthropicProvider({
  credentials: { apiKey: process.env.ANTHROPIC_API_KEY ?? '' },
  models: ['claude-sonnet-4-20250514'],
}));

registry.register(new GoogleGeminiProvider({
  credentials: { apiKey: process.env.GOOGLE_AI_API_KEY ?? '' },
  models: ['gemini-2.0-flash'],
}));

// Create multi-provider agent
const agent = new MultiProviderCompanionAgent({
  id: 'my-agent',
  defaultProviderId: 'openai',
  registry,
  capabilities: ['general'],
  systemPrompt: 'You are a helpful assistant.',
  defaults: { temperature: 0.7 },
});

// Register and start
const server = new McpAgenticServer({ defaultAgentId: 'my-agent' })
  .register(agent);

await server.startStdio();
```

## RuntimeParams

### Fields

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `model` | `string` | — | Model identifier |
| `temperature` | `number` | 0–2 | Sampling temperature |
| `maxTokens` | `number` | positive int | Max tokens to generate |
| `topP` | `number` | 0–1 | Nucleus sampling |
| `topK` | `number` | positive int | Top-K sampling |
| `stopSequences` | `string[]` | — | Stop sequences |
| `systemPrompt` | `string` | — | System prompt override |
| `providerSpecific` | `Record<string, unknown>` | — | Provider-native parameters |

### Merge priority

Parameters are merged in ascending priority:

```
ProviderConfig.defaults  <  session metadata.runtimeParams  <  prompt-level runtimeParams
```

- Only defined (non-`undefined`) fields from higher-priority layers override lower ones.
- `providerSpecific` is shallow-merged (spread) across all layers, not replaced.

### providerSpecific

The `providerSpecific` field passes provider-native parameters that are not covered by the common fields. Unsupported keys are silently ignored by the provider.

```typescript
runtimeParams: {
  temperature: 0.5,
  providerSpecific: {
    frequency_penalty: 0.8,  // OpenAI-specific
    presence_penalty: 0.3,   // OpenAI-specific
  }
}
```

## Peer dependencies

Provider SDKs are peer/optional dependencies. Install only the SDKs you need:

```bash
# OpenAI
npm install openai

# Anthropic
npm install @anthropic-ai/sdk

# Google Gemini
npm install @google/generative-ai

# All providers
npm install openai @anthropic-ai/sdk @google/generative-ai
```

If a provider SDK is not installed, constructing that provider will fail with an import error. Only install the SDKs for providers you intend to use.
