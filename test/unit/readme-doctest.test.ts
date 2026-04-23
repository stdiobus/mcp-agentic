/**
 * README.md doctest — verifies every code snippet from README compiles and works.
 *
 * If this test fails, the README documentation is lying to users.
 * Update the README or fix the code — never delete this test.
 */

import { McpAgenticServer } from '../../src/index.js';
import type {
  AgentHandler,
  AgentResult,
  McpAgenticServerConfig,
  WorkerConfig,
} from '../../src/index.js';

// ─── README: Quick Start snippet ─────────────────────────────────
// Tests that the exact pattern from README works (minus startStdio which captures stdio)

describe('README Quick Start', () => {
  it('creates server with register() and inline agent', () => {
    // This is the exact code from README Quick Start section:
    const server = new McpAgenticServer({ defaultAgentId: 'my-agent' })
      .register({
        id: 'my-agent',
        capabilities: ['code-analysis'],
        async prompt(sessionId, input) {
          return { text: `Analyzed: ${input}`, stopReason: 'end_turn' };
        },
      });

    // startStdio() would capture stdin/stdout — we verify construction + registration worked
    expect(server).toBeInstanceOf(McpAgenticServer);
  });

  it('registered agent actually works through executor', async () => {
    const server = new McpAgenticServer({ defaultAgentId: 'my-agent', silent: true })
      .register({
        id: 'my-agent',
        capabilities: ['code-analysis'],
        async prompt(sessionId, input) {
          return { text: `Analyzed: ${input}`, stopReason: 'end_turn' };
        },
      });

    // Access internal executor to verify the agent works end-to-end
    const executor = (server as any).inProcess;
    await executor.start();

    try {
      const session = await executor.createSession('my-agent');
      const result = await executor.prompt(session.sessionId, 'test input');

      expect(result.text).toBe('Analyzed: test input');
      expect(result.stopReason).toBe('end_turn');

      await executor.closeSession(session.sessionId);
    } finally {
      await executor.close();
    }
  });
});

// ─── README: Configuration snippet ───────────────────────────────
// Tests that McpAgenticServerConfig shape matches what README documents

describe('README Configuration', () => {
  it('McpAgenticServerConfig accepts all documented fields', () => {
    const agent: AgentHandler = {
      id: 'test',
      async prompt() {
        return { text: '', stopReason: 'end_turn' };
      },
    };

    // This is the exact interface shape from README Configuration section:
    const config: McpAgenticServerConfig = {
      agents: [agent],
      defaultAgentId: 'test',
      maxConcurrentRequests: 50,  // default: 50
      maxPromptBytes: 1048576,    // default: 1048576 (1 MiB)
      maxMetadataBytes: 65536,    // default: 65536 (64 KiB)
    };

    const server = new McpAgenticServer(config);
    expect(server).toBeInstanceOf(McpAgenticServer);
  });
});

// ─── README: Worker registration snippet ─────────────────────────
// Tests that registerWorker() accepts the exact shape from README

describe('README Worker Registration', () => {
  it('registerWorker() accepts documented WorkerConfig shape', () => {
    const server = new McpAgenticServer({ silent: true });

    // This is the exact code from README Worker registration section:
    server.registerWorker({
      id: 'py-agent',
      command: 'python',
      args: ['agent.py'],
      env: { API_KEY: process.env['API_KEY'] ?? '' },
      capabilities: ['data-analysis'],
    });

    expect(server).toBeInstanceOf(McpAgenticServer);
  });

  it('registerWorker() returns this for chaining', () => {
    const server = new McpAgenticServer({ silent: true });

    const result = server.registerWorker({
      id: 'py-agent',
      command: 'python',
      args: ['agent.py'],
      capabilities: ['data-analysis'],
    });

    expect(result).toBe(server);
  });
});

// ─── README: Public API exports ──────────────────────────────────
// Tests that every export listed in README actually exists

describe('README Public API', () => {
  it('exports McpAgenticServer class', () => {
    expect(McpAgenticServer).toBeDefined();
    expect(typeof McpAgenticServer).toBe('function');
  });

  it('AgentHandler type is usable', () => {
    const agent: AgentHandler = {
      id: 'test',
      capabilities: ['test'],
      async prompt(sessionId: string, input: string) {
        return { text: input, stopReason: 'end_turn' as const };
      },
    };
    expect(agent.id).toBe('test');
  });

  it('AgentResult type is usable', () => {
    const result: AgentResult = {
      text: 'hello',
      stopReason: 'end_turn',
      requestId: 'req-1',
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    expect(result.text).toBe('hello');
  });

  it('WorkerConfig type is usable', () => {
    const config: WorkerConfig = {
      id: 'worker-1',
      command: 'node',
      args: ['worker.js'],
      env: { KEY: 'value' },
      capabilities: ['cap1'],
    };
    expect(config.id).toBe('worker-1');
  });
});
