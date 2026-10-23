# PHASE 06: WebSocket Hardening + Graceful Shutdown

## Phase goal
Implement WS heartbeat, connection limits, namespace-scoped broadcast, and server graceful shutdown.

## In scope
- REL-H1/SCA-H1/SCA-H2: WS heartbeat, connection limits, namespace-scoped broadcast
- REL-H3: Graceful shutdown with configurable drain timeout

## Out of scope
- WS auth (done in Phase 01)
- Rate limiter fixes (Phase 08)

## Deliverables
- `datafn/server/src/ws.ts` — Heartbeat, limits, namespace Map
- `datafn/server/src/server.ts` — Graceful shutdown (SIGTERM/SIGINT handler, close() method)

## Requirements covered
REL-007, REL-009, SCA-005, SCA-006

## Implementation tasks
1. **Namespace-scoped broadcast** (`ws.ts`):
   - Replace `Set<Client>` with `Map<string, Set<Client>>` keyed by namespace
   - `addClient(client, { namespace })` adds to correct namespace Set
   - `removeClient(client)` removes from namespace Set
   - `broadcastCursor(cursor, namespace)` iterates only the namespace Set

2. **Connection limits** (`ws.ts`):
   - Track total count + per-namespace count
   - On `addClient`: check `totalClients >= maxConnections` → reject with close code `4503`
   - Check namespace count >= `maxConnectionsPerNamespace` → reject with close code `4503`

3. **Heartbeat** (`ws.ts`):
   - Start `setInterval` at `heartbeatIntervalMs` (default 30s)
   - Each tick: for each client, send native WS ping. Mark as "awaiting pong"
   - Set per-client timeout of `heartbeatTimeoutMs` (default 10s)
   - If no pong received: close connection, call `removeClient`
   - `unref()` the heartbeat interval timer
   - Add `destroy()` method to clean up timer

4. **Graceful shutdown** (`server.ts`):
   - Register SIGTERM/SIGINT handlers (or expose `close()` method)
   - `close()` method:
     1. Set `shuttingDown = true` flag
     2. Stop accepting new HTTP connections (if using native server) or reject with 503
     3. Call `wsManager.close()` which sends close code 1001 to all clients
     4. Wait for in-flight request count to reach 0 (or timeout)
     5. Clear rate limit timers (`rateLimiter.destroy()`)
     6. Clear idempotency sweep timer
     7. Clear pruning interval
     8. Resolve close Promise
   - `shutdownTimeoutMs` default: 10,000ms
   - Track in-flight requests via counter (increment on request start, decrement on response)

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- Tests:
  - Connection rejected when global limit reached (close code 4503)
  - Connection rejected when namespace limit reached
  - Broadcast only reaches clients in same namespace (not all)
  - Heartbeat closes dead connection after interval + timeout
  - `close()` sends WS close frame 1001
  - `close()` resolves after in-flight requests complete
  - `close()` resolves after timeout even with stuck requests

## Stop condition
WS is hardened with limits, heartbeat, and scoped broadcast. Graceful shutdown works. Report results.
