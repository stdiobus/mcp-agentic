/**
 * BridgeError unit tests
 */

import { BridgeError } from '../../../src/errors/BridgeError.js';

describe('BridgeError', () => {
  describe('constructor', () => {
    it('should create error with type and message', () => {
      const error = new BridgeError('CONFIG', 'Test error');

      expect(error.name).toBe('BridgeError');
      expect(error.type).toBe('CONFIG');
      expect(error.message).toBe('Test error');
      expect(error.details.retryable).toBe(false);
    });

    it('should merge details', () => {
      const error = new BridgeError('TRANSPORT', 'Test error', {
        correlationId: 'test-123',
        retryable: true,
      });

      expect(error.details.correlationId).toBe('test-123');
      expect(error.details.retryable).toBe(true);
    });

    it('should set cause when provided', () => {
      const cause = new Error('Original error');
      const error = new BridgeError('UPSTREAM', 'Test error', {}, cause);

      expect(error.cause).toBe(cause);
    });

    it('should not set cause when not provided', () => {
      const error = new BridgeError('INTERNAL', 'Test error');

      expect(error.cause).toBeUndefined();
    });
  });

  describe('static factory methods', () => {
    it('should create CONFIG error', () => {
      const error = BridgeError.config('Config error');

      expect(error.type).toBe('CONFIG');
      expect(error.message).toBe('Config error');
      expect(error.details.retryable).toBe(false);
    });

    it('should create AUTH error', () => {
      const error = BridgeError.auth('Auth error');

      expect(error.type).toBe('AUTH');
      expect(error.message).toBe('Auth error');
      expect(error.details.retryable).toBe(false);
    });

    it('should create TRANSPORT error', () => {
      const error = BridgeError.transport('Transport error');

      expect(error.type).toBe('TRANSPORT');
      expect(error.message).toBe('Transport error');
      expect(error.details.retryable).toBe(true);
    });

    it('should create UPSTREAM error', () => {
      const error = BridgeError.upstream('Upstream error');

      expect(error.type).toBe('UPSTREAM');
      expect(error.message).toBe('Upstream error');
      expect(error.details.retryable).toBe(false);
    });

    it('should create TIMEOUT error', () => {
      const error = BridgeError.timeout('Timeout error');

      expect(error.type).toBe('TIMEOUT');
      expect(error.message).toBe('Timeout error');
      expect(error.details.retryable).toBe(true);
    });

    it('should create PROTOCOL error', () => {
      const error = BridgeError.protocol('Protocol error');

      expect(error.type).toBe('PROTOCOL');
      expect(error.message).toBe('Protocol error');
      expect(error.details.retryable).toBe(false);
    });

    it('should create INTERNAL error', () => {
      const error = BridgeError.internal('Internal error');

      expect(error.type).toBe('INTERNAL');
      expect(error.message).toBe('Internal error');
      expect(error.details.retryable).toBe(false);
    });

    it('should accept details in factory methods', () => {
      const error = BridgeError.transport('Transport error', {
        correlationId: 'test-123',
        stage: 'connection',
      });

      expect(error.details.correlationId).toBe('test-123');
      expect(error.details.stage).toBe('connection');
      expect(error.details.retryable).toBe(true); // Default for transport
    });

    it('should accept cause in factory methods', () => {
      const cause = new Error('Original error');
      const error = BridgeError.upstream('Upstream error', {}, cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe('toJSON', () => {
    it('should serialize to JSON', () => {
      const error = BridgeError.config('Config error', {
        correlationId: 'test-123',
      });

      const json = error.toJSON();

      expect(json.type).toBe('CONFIG');
      expect(json.message).toBe('Config error');
      expect(json.details).toEqual({
        correlationId: 'test-123',
        retryable: false,
      });
      expect(json).not.toHaveProperty('stack');
    });

    it('should include cause in JSON', () => {
      const cause = new Error('Original error');
      const error = BridgeError.transport('Transport error', {}, cause);

      const json = error.toJSON();

      expect(json.cause).toBeDefined();
      expect((json.cause as any).message).toBe('Original error');
      expect(json.cause).not.toHaveProperty('stack');
    });

    it('should not include cause when not present', () => {
      const error = BridgeError.internal('Internal error');

      const json = error.toJSON();

      expect(json.cause).toBeUndefined();
    });
  });

  describe('inheritance', () => {
    it('should be instance of Error', () => {
      const error = BridgeError.config('Config error');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(BridgeError);
    });

    it('should have proper stack trace', () => {
      const error = BridgeError.config('Config error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('BridgeError');
    });
  });

  describe('error details', () => {
    it('should have default retryable false', () => {
      const error = new BridgeError('CONFIG', 'Test error');

      expect(error.details.retryable).toBe(false);
    });

    it('should override retryable when provided', () => {
      const error = new BridgeError('CONFIG', 'Test error', {
        retryable: true,
      });

      expect(error.details.retryable).toBe(true);
    });

    it('should preserve all detail fields', () => {
      const details = {
        correlationId: 'test-123',
        sessionId: 'session-456',
        workerId: 'worker-789',
        stage: 'validation',
        retryable: true,
        customField: 'custom-value',
      };

      const error = new BridgeError('UPSTREAM', 'Test error', details);

      expect(error.details).toEqual(details);
    });
  });
});