/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for McpAgenticServer — worker transport option forwarding.
 *
 * Verifies that the workerListenMode, workerTcpHost, workerTcpPort, and
 * workerUnixPath fields in McpAgenticServerConfig are forwarded correctly
 * to the WorkerExecutor constructor.
 *
 * Kept in a separate file from McpAgenticServer.test.ts because mocking
 * WorkerExecutor's constructor conflicts with the mock setup used there.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import type { McpAgenticServerConfig } from '../../../src/server/McpAgenticServer.js';
import type { WorkerExecutorConfig } from '../../../src/executor/WorkerExecutor.js';

// ─── Module-level variables populated in beforeAll ────────────────

let McpAgenticServer: typeof import('../../../src/server/McpAgenticServer.js').McpAgenticServer;
let MockWorkerExecutor: jest.Mock;
let MockMcpServerClass: jest.Mock;
let MockStdioTransport: jest.Mock;

/** Constructor args captured by the WorkerExecutor mock. */
let capturedWorkerConfig: WorkerExecutorConfig | undefined;

/** Mock executor instance returned by the WorkerExecutor mock. */
let mockWorkerInstance: {
  addWorker: jest.Mock;
  start: jest.Mock;
  close: jest.Mock;
  discover: jest.Mock;
  health: jest.Mock;
  getSession: jest.Mock;
  isReady: jest.Mock;
};

// ─── ESM mock setup + dynamic imports in beforeAll ────────────────

beforeAll(async () => {
  // WorkerExecutor mock — captures constructor args
  jest.unstable_mockModule('../../../src/executor/WorkerExecutor.js', () => {
    const mock = jest.fn();
    return {
      WorkerExecutor: mock,
      __esModule: true,
    };
  });

  jest.unstable_mockModule('@stdiobus/node', () => ({
    StdioBus: jest.fn(),
    __esModule: true,
  }));

  jest.unstable_mockModule('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: jest.fn(),
    __esModule: true,
  }));

  jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: jest.fn(),
    __esModule: true,
  }));

  const workerModule = await import('../../../src/executor/WorkerExecutor.js');
  const mcpServerModule = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const mcpStdioModule = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const mcpAgenticModule = await import('../../../src/server/McpAgenticServer.js');

  MockWorkerExecutor = workerModule.WorkerExecutor as unknown as jest.Mock;
  MockMcpServerClass = mcpServerModule.McpServer as unknown as jest.Mock;
  MockStdioTransport = mcpStdioModule.StdioServerTransport as unknown as jest.Mock;
  McpAgenticServer = mcpAgenticModule.McpAgenticServer;
});

beforeEach(() => {
  capturedWorkerConfig = undefined;

  mockWorkerInstance = {
    addWorker: jest.fn(),
    start: jest.fn<any>().mockResolvedValue(undefined),
    close: jest.fn<any>().mockResolvedValue(undefined),
    discover: jest.fn<any>().mockResolvedValue([]),
    health: jest.fn<any>().mockResolvedValue({
      healthy: true,
      agents: { total: 0, ready: 0 },
      sessions: { active: 0, capacity: 0 },
      uptime: 0,
    }),
    getSession: jest.fn<any>().mockRejectedValue(new Error('no session')),
    isReady: jest.fn<any>().mockReturnValue(true),
  };

  MockWorkerExecutor.mockImplementation((config: WorkerExecutorConfig) => {
    capturedWorkerConfig = config;
    return mockWorkerInstance;
  });

  MockMcpServerClass.mockImplementation(() => ({
    registerTool: jest.fn<any>().mockReturnValue({ enabled: true }),
    connect: jest.fn<any>().mockResolvedValue(undefined),
    close: jest.fn<any>().mockResolvedValue(undefined),
  }));

  MockStdioTransport.mockImplementation(() => ({}));
});

// ─── Helper ───────────────────────────────────────────────────────

/** Create server, call registerWorker() once, return the captured constructor config. */
async function captureWorkerConstructorConfig(
  serverConfig: McpAgenticServerConfig,
): Promise<WorkerExecutorConfig> {
  const server = new McpAgenticServer(serverConfig);
  server.registerWorker({ id: 'w1', command: 'node', args: ['agent.js'] });

  // capturedWorkerConfig is set synchronously by the mock constructor
  if (capturedWorkerConfig === undefined) {
    throw new Error('WorkerExecutor constructor was never called');
  }
  return capturedWorkerConfig;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('McpAgenticServer — worker transport option forwarding', () => {

  // ── TCP mode ─────────────────────────────────────────────────

  describe('TCP listen mode', () => {
    it('forwards workerListenMode tcp and workerTcpPort to WorkerExecutor', async () => {
      const config = await captureWorkerConstructorConfig({
        silent: true,
        workerListenMode: 'tcp',
        workerTcpPort: 9000,
      });

      expect(config.listenMode).toBe('tcp');
      expect(config.tcpPort).toBe(9000);
      expect(config.tcpHost).toBeUndefined();
      expect(config.unixPath).toBeUndefined();
    });

    it('forwards workerTcpHost when provided alongside workerListenMode tcp', async () => {
      const config = await captureWorkerConstructorConfig({
        silent: true,
        workerListenMode: 'tcp',
        workerTcpHost: '0.0.0.0',
        workerTcpPort: 9001,
      });

      expect(config.listenMode).toBe('tcp');
      expect(config.tcpHost).toBe('0.0.0.0');
      expect(config.tcpPort).toBe(9001);
      expect(config.unixPath).toBeUndefined();
    });

    it('omits tcpHost from WorkerExecutor config when not set (exactOptionalPropertyTypes)', async () => {
      const config = await captureWorkerConstructorConfig({
        silent: true,
        workerListenMode: 'tcp',
        workerTcpPort: 8080,
      });

      // With exactOptionalPropertyTypes the field must be absent, not set to undefined
      expect(Object.prototype.hasOwnProperty.call(config, 'tcpHost')).toBe(false);
    });

    it('omits tcpPort from WorkerExecutor config when not set', async () => {
      const config = await captureWorkerConstructorConfig({
        silent: true,
        workerListenMode: 'tcp',
      });

      expect(Object.prototype.hasOwnProperty.call(config, 'tcpPort')).toBe(false);
    });
  });

  // ── Unix socket mode ──────────────────────────────────────────

  describe('Unix socket listen mode', () => {
    it('forwards workerListenMode unix and workerUnixPath to WorkerExecutor', async () => {
      const config = await captureWorkerConstructorConfig({
        silent: true,
        workerListenMode: 'unix',
        workerUnixPath: '/tmp/mcp-test.sock',
      });

      expect(config.listenMode).toBe('unix');
      expect(config.unixPath).toBe('/tmp/mcp-test.sock');
      expect(config.tcpHost).toBeUndefined();
      expect(config.tcpPort).toBeUndefined();
    });

    it('omits tcpHost and tcpPort from WorkerExecutor config for unix mode', async () => {
      const config = await captureWorkerConstructorConfig({
        silent: true,
        workerListenMode: 'unix',
        workerUnixPath: '/var/run/agent.sock',
      });

      expect(Object.prototype.hasOwnProperty.call(config, 'tcpHost')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(config, 'tcpPort')).toBe(false);
    });
  });

  // ── No listenMode ─────────────────────────────────────────────

  describe('no workerListenMode configured', () => {
    it('omits listenMode field when workerListenMode is not set', async () => {
      const config = await captureWorkerConstructorConfig({ silent: true });

      // When workerListenMode is absent, McpAgenticServer does not forward it —
      // WorkerExecutor defaults to 'none' internally.
      expect(Object.prototype.hasOwnProperty.call(config, 'listenMode')).toBe(false);
    });

    it('omits all address fields when workerListenMode is not set', async () => {
      const config = await captureWorkerConstructorConfig({ silent: true });

      expect(Object.prototype.hasOwnProperty.call(config, 'tcpHost')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(config, 'tcpPort')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(config, 'unixPath')).toBe(false);
    });
  });

  // ── silent flag forwarding ────────────────────────────────────

  describe('silent flag forwarding', () => {
    it('forwards silent: true to WorkerExecutor', async () => {
      const config = await captureWorkerConstructorConfig({ silent: true });
      expect(config.silent).toBe(true);
    });

    it('forwards silent: false when not set in server config', async () => {
      // silent defaults to false in McpAgenticServer
      const config = await captureWorkerConstructorConfig({});
      expect(config.silent).toBe(false);
    });
  });

  // ── Singleton WorkerExecutor ──────────────────────────────────

  describe('WorkerExecutor singleton behaviour', () => {
    it('constructs WorkerExecutor only once even when registerWorker() is called multiple times', () => {
      const server = new McpAgenticServer({ silent: true, workerListenMode: 'tcp', workerTcpPort: 9999 });

      server.registerWorker({ id: 'w1', command: 'node', args: ['a.js'] });
      server.registerWorker({ id: 'w2', command: 'node', args: ['b.js'] });
      server.registerWorker({ id: 'w3', command: 'python', args: ['c.py'] });

      // Constructor should have been called exactly once
      expect(MockWorkerExecutor).toHaveBeenCalledTimes(1);

      // addWorker should have been called for each registerWorker() call
      expect(mockWorkerInstance.addWorker).toHaveBeenCalledTimes(3);
    });

    it('all subsequent registerWorker calls use the same WorkerExecutor instance', () => {
      const server = new McpAgenticServer({ silent: true });

      server.registerWorker({ id: 'w1', command: 'node', args: ['a.js'] });
      server.registerWorker({ id: 'w2', command: 'node', args: ['b.js'] });

      // Only one WorkerExecutor was created
      expect(MockWorkerExecutor).toHaveBeenCalledTimes(1);

      // Both workers added to the same instance
      expect(mockWorkerInstance.addWorker).toHaveBeenNthCalledWith(
        1, { id: 'w1', command: 'node', args: ['a.js'] },
      );
      expect(mockWorkerInstance.addWorker).toHaveBeenNthCalledWith(
        2, { id: 'w2', command: 'node', args: ['b.js'] },
      );
    });
  });

  // ── No registerWorker call ────────────────────────────────────

  describe('no registerWorker call', () => {
    it('does not construct WorkerExecutor when registerWorker() is never called', () => {
      // Constructing the server alone (with a workerListenMode config) must NOT create
      // a WorkerExecutor — creation is lazy, triggered only by registerWorker().
      new McpAgenticServer({
        silent: true,
        workerListenMode: 'tcp',
        workerTcpPort: 7000,
      });

      expect(MockWorkerExecutor).not.toHaveBeenCalled();
    });
  });
});
