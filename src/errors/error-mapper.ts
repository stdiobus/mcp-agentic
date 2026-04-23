/**
 * Map BridgeError to MCP error codes
 */

import { BridgeError } from './BridgeError.js';

export interface MCPError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * MCP JSON-RPC error codes
 */
export const MCPErrorCode = {
  // Standard JSON-RPC errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // MCP-specific errors
  SERVER_ERROR: -32000,
  TIMEOUT_ERROR: -32001,
  UPSTREAM_ERROR: -32002,
  AUTH_ERROR: -32003,
  CONFIG_ERROR: -32004,
} as const;

/**
 * Map BridgeError to MCP error
 */
export function mapBridgeErrorToMCP(error: BridgeError): MCPError {
  let code: number;

  switch (error.type) {
    case 'CONFIG':
      code = MCPErrorCode.CONFIG_ERROR;
      break;
    case 'AUTH':
      code = MCPErrorCode.AUTH_ERROR;
      break;
    case 'TRANSPORT':
      code = MCPErrorCode.SERVER_ERROR;
      break;
    case 'UPSTREAM':
      code = MCPErrorCode.UPSTREAM_ERROR;
      break;
    case 'TIMEOUT':
      code = MCPErrorCode.TIMEOUT_ERROR;
      break;
    case 'PROTOCOL':
      code = MCPErrorCode.SERVER_ERROR;
      break;
    case 'INTERNAL':
      code = MCPErrorCode.INTERNAL_ERROR;
      break;
    default:
      code = MCPErrorCode.INTERNAL_ERROR;
  }

  return {
    code,
    message: error.message,
    data: {
      type: error.type,
      retryable: error.details.retryable,
      ...(error.details.correlationId !== undefined && { correlationId: error.details.correlationId }),
      ...(error.details.upstreamCode !== undefined && { upstreamCode: error.details.upstreamCode }),
      ...(error.details.sessionValid !== undefined && { sessionValid: error.details.sessionValid }),
      ...(error.details.stage !== undefined && { stage: error.details.stage }),
    },
  };
}

/**
 * Map generic Error to MCP error
 */
export function mapErrorToMCP(error: unknown): MCPError {
  if (error instanceof BridgeError) {
    return mapBridgeErrorToMCP(error);
  }

  if (error instanceof Error) {
    return {
      code: MCPErrorCode.INTERNAL_ERROR,
      message: error.message,
      data: {
        type: 'INTERNAL',
        retryable: false,
      },
    };
  }

  return {
    code: MCPErrorCode.INTERNAL_ERROR,
    message: 'Unknown error occurred',
    data: {
      type: 'INTERNAL',
      retryable: false,
    },
  };
}
