# Test Checklist for MCP Agentic

## Coverage Targets

- **Global:** 85% lines, 80% branches
- **Critical modules:** 90% branches
  - `src/bridge/`
  - `src/sessions/`
  - `src/errors/`

## Unit Tests

### SessionManager (`test/unit/sessions/SessionManager.test.ts`)

- [x] create - creates new session
- [x] create - rejects when max sessions reached
- [x] create - generates unique IDs
- [x] get - retrieves existing session
- [x] get - throws when not found
- [x] get - throws when expired
- [x] updateStatus - updates status
- [x] updateStatus - updates lastActivityAt
- [x] touch - updates lastActivityAt
- [x] updateMetadata - updates metadata
- [x] updateMetadata - merges metadata
- [x] close - closes session
- [x] close - transitions through closing state
- [x] list - lists all sessions
- [x] list - filters by status
- [x] cleanup - removes expired sessions
- [x] cleanup - preserves active sessions
- [x] GC - runs automatic cleanup

### MemoryStore (`test/unit/sessions/MemoryStore.test.ts`)

- [ ] init - initializes store
- [ ] create - stores session
- [ ] get - retrieves session
- [ ] get - returns null when not found
- [ ] update - updates session
- [ ] update - throws when not found
- [ ] delete - removes session
- [ ] list - returns all sessions
- [ ] list - filters by status
- [ ] cleanup - removes expired sessions
- [ ] close - clears all sessions
- [ ] size - returns session count

### StdioBusClient (`test/unit/transport/StdioBusClient.test.ts`)

- [ ] connect - connects in embedded mode
- [ ] connect - throws when already connected
- [ ] connect - throws when no pools configured
- [ ] disconnect - disconnects gracefully
- [ ] disconnect - cleans up resources
- [ ] request - sends request and waits for response
- [ ] request - throws when not connected
- [ ] request - handles timeout
- [ ] request - propagates correlation ID
- [ ] notify - sends fire-and-forget notification
- [ ] notify - throws when not connected
- [ ] onMessage - registers handler
- [ ] offMessage - unregisters handler
- [ ] handleNotification - dispatches to handlers
- [ ] handleMessage - dispatches to handlers
- [ ] event: error - emits on error
- [ ] event: close - emits on close

### BridgeService (`test/unit/bridge/BridgeService.test.ts`)

- [ ] init - initializes transport
- [ ] shutdown - disconnects transport
- [ ] discoverWorkers - returns workers
- [ ] discoverWorkers - uses cache when fresh
- [ ] discoverWorkers - refreshes cache when stale
- [ ] discoverWorkers - filters by capability
- [ ] discoverWorkers - handles discovery failure
- [ ] invalidateDiscoveryCache - clears cache
- [ ] createSession - creates session
- [ ] createSession - resolves worker from agentId
- [ ] createSession - checks circuit breaker
- [ ] createSession - binds session to worker
- [ ] createSession - records success
- [ ] createSession - records failure
- [ ] resumeSession - resumes existing session
- [ ] resumeSession - throws when closed
- [ ] resumeSession - touches session
- [ ] closeSession - closes session
- [ ] closeSession - sends notification
- [ ] closeSession - removes binding
- [ ] prompt - sends prompt
- [ ] prompt - updates session status
- [ ] prompt - tracks request
- [ ] prompt - records success/failure
- [ ] getStatus - returns status
- [ ] cancel - sends cancel notification
- [ ] getHealth - returns health status

### Circuit Breaker (`test/unit/bridge/CircuitBreaker.test.ts`)

- [ ] closed - allows requests
- [ ] closed - records failures
- [ ] open - rejects requests
- [ ] open - transitions to half-open after timeout
- [ ] half-open - allows single request
- [ ] half-open - closes on success
- [ ] half-open - reopens on failure
- [ ] threshold - opens after N failures
- [ ] reset - clears failures on success

### Retry Logic (`test/unit/bridge/RetryLogic.test.ts`)

- [ ] retries idempotent operations
- [ ] does not retry non-idempotent operations
- [ ] respects maxAttempts
- [ ] uses exponential backoff
- [ ] respects maxBackoffMs
- [ ] retries on timeout
- [ ] does not retry on auth error
- [ ] propagates last error

### Error Handling (`test/unit/errors/`)

- [ ] BridgeError - creates typed errors
- [ ] BridgeError - preserves cause
- [ ] BridgeError - serializes to JSON
- [ ] error-mapper - maps to MCP codes
- [ ] error-mapper - preserves correlation ID
- [ ] error-mapper - includes retryability

### Logger (`test/unit/observability/Logger.test.ts`)

- [ ] logs at correct level
- [ ] filters by log level
- [ ] formats as JSON
- [ ] formats as pretty
- [ ] includes timestamp
- [ ] includes correlation ID
- [ ] child logger inherits context
- [ ] writes to correct destination

### Correlation (`test/unit/observability/Correlation.test.ts`)

- [ ] generateCorrelationId - generates unique IDs
- [ ] setCorrelationId - sets context
- [ ] getCorrelationId - retrieves context
- [ ] clearCorrelationId - clears context
- [ ] withCorrelationId - executes with context

## Integration Tests

### StdioBusClient + Transport (`test/integration/transport.test.ts`)

- [ ] connects to embedded bus
- [ ] sends and receives messages
- [ ] handles notifications
- [ ] handles errors
- [ ] disconnects gracefully

### BridgeService + StdioBusClient (`test/integration/bridge.test.ts`)

- [ ] discovers workers
- [ ] creates session
- [ ] sends prompt
- [ ] gets status
- [ ] closes session
- [ ] handles worker failure
- [ ] circuit breaker opens on failures
- [ ] retries on timeout

### Full Flow (`test/integration/full-flow.test.ts`)

- [ ] discovery -> session -> prompt -> close
- [ ] concurrent sessions
- [ ] session resumption
- [ ] error recovery
- [ ] timeout handling

## E2E Tests

### Real stdio_bus + Workers (`test/e2e/real-bus.test.ts`)

- [ ] starts stdio_bus daemon
- [ ] spawns ACP workers
- [ ] discovers workers
- [ ] creates session
- [ ] sends prompt
- [ ] receives response
- [ ] closes session
- [ ] stops daemon

### MCP Tools (`test/e2e/mcp-tools.test.ts`)

- [ ] bridge_health
- [ ] agents_discover
- [ ] sessions_create
- [ ] sessions_resume
- [ ] sessions_prompt
- [ ] sessions_status
- [ ] sessions_close
- [ ] sessions_list
- [ ] tasks_delegate

### Stress Tests (`test/e2e/stress.test.ts`)

- [ ] concurrent requests
- [ ] burst traffic
- [ ] long-running sessions
- [ ] worker restarts
- [ ] network failures

## Property-Based Tests

### Retry/Backoff (`test/property/retry.test.ts`)

- [ ] backoff is monotonic
- [ ] backoff respects upper bound
- [ ] jitter is within range

### Circuit Breaker (`test/property/circuit-breaker.test.ts`)

- [ ] state transitions are valid
- [ ] threshold is respected
- [ ] timeout is respected

### Error Mapping (`test/property/error-mapping.test.ts`)

- [ ] all errors map to valid MCP codes
- [ ] retryability is consistent
- [ ] correlation ID is preserved

## Critical Scenarios

### Cancellation/Abort

- [ ] cancel request on timeout
- [ ] cancel request explicitly
- [ ] cleanup on cancel
- [ ] no resource leaks

### Race Conditions

- [ ] concurrent open/close same session
- [ ] duplicate request IDs
- [ ] concurrent discovery requests

### Idempotency

- [ ] repeated closeSession
- [ ] repeated discover
- [ ] repeated status check

### Resource Leaks

- [ ] no hanging timers after test
- [ ] no open sockets after test
- [ ] no event listeners after test

### Crash Recovery

- [ ] restart with active sessions
- [ ] session invalidation
- [ ] pending request cleanup

### Backpressure

- [ ] burst requests
- [ ] queue limits
- [ ] EAGAIN handling

### Schema Drift

- [ ] unexpected fields
- [ ] missing fields
- [ ] wrong types
- [ ] malformed JSON

### Observability

- [ ] correlation ID in all logs
- [ ] required log fields
- [ ] log level filtering

## Test Execution

```bash
# Unit tests (fast, always run)
npm run test:unit

# Integration tests (slower, PR + nightly)
npm run test:integration

# E2E tests (slowest, merge gate + nightly)
npm run test:e2e

# All tests
npm run test:all

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## Coverage Gates

- PR merge: 85% lines, 80% branches (unit + integration)
- Release: 85% lines, 80% branches (all tests)
- Critical modules: 90% branches

## CI/CD Integration

- **PR:** unit tests
- **PR + nightly:** unit + integration tests
- **Merge gate:** unit + integration + e2e tests
- **Nightly:** all tests + stress tests
