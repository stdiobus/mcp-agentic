/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for @stdiobus/node
 */

export class StdioBusClient {
  private connected = false;
  private handlers: Record<string, Function[]> = {};

  constructor(options: any) {
    // Mock constructor
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async request(method: string, params?: any, options?: any): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    // Mock responses based on method
    switch (method) {
      case 'agents/discover':
        return {
          workers: [
            {
              id: 'test-worker',
              name: 'Test Worker',
              capabilities: ['test'],
              status: 'ready',
              instances: 1,
              load: 0,
            },
          ],
        };
      case 'session/new':
        return { sessionId: 'test-session-123' };
      case 'session/prompt':
        return {
          status: 'completed',
          result: { message: 'Test response' },
          warnings: [],
        };
      case 'session/status':
        return {
          status: 'completed',
          result: { progress: 100 },
        };
      default:
        return {};
    }
  }

  notify(method: string, params?: any, options?: any): void {
    // Mock notification
  }

  on(event: string, handler: Function): this {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event]!.push(handler);
    return this;
  }

  off(event: string, handler: Function): this {
    if (this.handlers[event]) {
      const index = this.handlers[event]!.indexOf(handler);
      if (index !== -1) {
        this.handlers[event]!.splice(index, 1);
      }
    }
    return this;
  }

  emit(event: string, ...args: any[]): void {
    if (this.handlers[event]) {
      this.handlers[event]!.forEach(handler => handler(...args));
    }
  }

  getClientSessionId(): string {
    return 'mock-client-session';
  }

  getAgentSessionId(): string | null {
    return 'mock-agent-session';
  }

  setAgentSessionId(sessionId: string): void {
    // Mock implementation
  }
}
