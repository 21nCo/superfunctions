# PHASE_06 Completion Report — WebSocket Hardening + Graceful Shutdown

## Metadata

- **Timestamp**: 2026-02-28T08:31:00Z
- **Agent**: Oz
- **Model**: claude 4.6 sonnet (max)
- **Launcher**: Warp
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin (macOS) / zsh 5.9
- **Branch**: next
- **Commit**: ea87d7e (dirty)
- **Phase**: PHASE_06
- **Status**: PASS

---

## Requirements Summary

**Requirements delivered**: REL-007, REL-009, SCA-005, SCA-006

### REL-007 — WS Heartbeat/Ping-Pong
- **Status**: PASS
- **Acceptance criteria evidence**:
  - `startHeartbeat()` uses `setInterval(heartbeatIntervalMs)` (default 30,000ms) to ping each connected client
  - Ping is sent via `client.ping()` (native WS ping frame); client marked in `pendingPong` Set
  - Per-client `setTimeout(heartbeatTimeoutMs)` (default 10,000ms) fires: if client still in `pendingPong`, calls `removeClient` + `client.close(1001, "Heartbeat timeout")`
  - `handlePong(client)` removes from `pendingPong` preventing closure
  - Heartbeat interval is `unref()`'d to allow process exit
  - `destroy()` clears the interval
  - **Lazy start**: heartbeat starts on first `addClient()` call, not in constructor (avoids spurious `setInterval` in servers with no WS clients)
- **Tests**: TV-REL-010, `handlePong prevents close`, `clients without ping() skipped`, `destroy() stops heartbeat`

### REL-009 — Graceful Shutdown
- **Status**: PASS
- **Acceptance criteria evidence**:
  - `shuttingDown` flag set to `true` → new requests return `503 SERVICE_UNAVAILABLE`
  - `wsManager.close()` called → sends close code `1001 Going Away` to all clients
  - `inFlightCount` tracked in `withAuth` wrapper (increment before handler, decrement in `finally`)
  - `serverClose()` awaits `inFlightCount === 0` or `shutdownTimeoutMs` (default 10,000ms)
  - SIGTERM/SIGINT handlers registered via `process.once` → call `serverClose()`
  - `close()` is idempotent via `if (shuttingDown) return` guard
  - Timer cleanup: `pruneInterval` and `memoryRateLimiter` cleared after drain
  - `close()` returns `Promise<void>`
- **Tests**: TV-REL-012 (WS close 1001, 503 after close, drain on in-flight, timeout resolve)

### SCA-005 — WS Connection Limits
- **Status**: PASS
- **Acceptance criteria evidence**:
  - `addClient()` checks `totalCount >= maxConnections` → `client.close(4503, "Connection limit reached")`; returns `false`
  - `addClient()` checks `namespaceCount >= maxConnectionsPerNamespace` → `client.close(4503, "Namespace connection limit reached")`; returns `false`
  - Defaults: `maxConnections: 10,000`, `maxConnectionsPerNamespace: 100`
  - Existing clients unaffected by limit enforcement
- **Tests**: TV-SCA-007, TV-SCA-008

### SCA-006 — Namespace-Scoped WS Broadcast
- **Status**: PASS
- **Acceptance criteria evidence**:
  - Replaced `Set<WebSocketClient>` + `Map<client, namespace>` with `Map<namespace, Set<client>>` + reverse `Map<client, namespace>`
  - `broadcastCursor(cursor, namespace)` looks up `namespaceClients.get(namespace)` → O(clients-in-namespace) iteration
  - `addClient` / `removeClient` maintain both maps
  - Namespace required parameter (not optional) enforces SCA-006 semantics
- **Tests**: TV-SCA-009 (10 target clients in 1 namespace + 5 clients in other namespaces → exactly 10 sends)

---

## Deliverables Summary

### Files Changed/Added

- **`datafn/server/src/ws.ts`** — Full rewrite:
  - Added `ping?()` to `WebSocketClient` interface
  - Added `WsManagerConfig` interface (`maxConnections`, `maxConnectionsPerNamespace`, `heartbeatIntervalMs`, `heartbeatTimeoutMs`)
  - Replaced `Set<client>` + `Map<client, namespace>` with `Map<namespace, Set<client>>` + `Map<client, namespace>` (SCA-006)
  - `addClient()` now returns `boolean`; enforces limits with close code 4503 (SCA-005)
  - Added `handlePong(client)` method (REL-007)
  - Added `startHeartbeat()` private method with lazy initialization (starts on first `addClient`)
  - Added `destroy()` method (stops heartbeat timer)
  - Added `close()` method (stops heartbeat + sends 1001 to all clients)
  - `broadcastCursor(cursor, namespace)` now requires `namespace: string`

- **`datafn/server/src/server.ts`** — Changes:
  - Import `WsManagerConfig` from `./ws.js`
  - Added `ws?: WsManagerConfig` and `shutdownTimeoutMs?: number` to `DatafnServerConfig`
  - Updated `DatafnServer` interface: `close(): Promise<void>`, `addClient` returns `boolean`, `handlePong` added
  - `WebSocketManager` created with `config.ws ?? {}`
  - Added `inFlightCount`, `shuttingDown`, `shutdownResolve` variables
  - `withAuth` wrapper: checks `shuttingDown` → 503; increments `inFlightCount`; `finally` decrements and signals drain
  - Implemented `serverClose()` async function with drain + timeout + timer cleanup
  - Registered `process.once("SIGTERM", sigHandler)` and `process.once("SIGINT", sigHandler)`
  - Return object: `close: serverClose`, plus `handlePong` on `websocketHandler`

- **`datafn/server/__tests__/ws.test.ts`** — Added 7 new tests:
  - TV-SCA-007: global limit (4503)
  - TV-SCA-008: namespace limit (4503)
  - TV-SCA-009: namespace-scoped broadcast
  - TV-REL-010: heartbeat closes dead connection (fake timers)
  - `handlePong prevents close` (fake timers)
  - `clients without ping() skipped`
  - `close() sends 1001`
  - `destroy() stops heartbeat without closing clients`

- **`datafn/server/__tests__/server.test.ts`** — New file with 7 tests:
  - `close() returns a Promise`
  - `close() resolves immediately with no in-flight`
  - `close() is idempotent`
  - TV-REL-012: `close() sends WS 1001`
  - `after close(), new requests receive 503`
  - TV-REL-012: `close() resolves after in-flight complete`
  - TV-REL-012: `close() resolves after shutdownTimeoutMs with stuck requests` (fake timers)

---

## Verification Summary

### Phase Verification Steps Executed

```
cd datafn/server && npx vitest run
```

### Test Execution Results

| Metric | Before Phase 06 | After Phase 06 |
|--------|-----------------|----------------|
| Total tests | 451 | 466 |
| Passing | 424 | 439 |
| Failing | 27 | 27 |
| New tests added | — | 15 |

**All 15 new Phase 06 tests pass.** All 27 failures are identical pre-existing failures (all related to `wrapWithRowLevelNamespace is not a function` or other bugs from prior phases).

---

## Notes

1. **Heartbeat lazy start**: The heartbeat `setInterval` is started on first `addClient()` rather than in the constructor. This avoids creating a timer when no WS clients ever connect (which would break existing retention tests that spy on `setInterval`).
2. **Idempotent shutdown**: `serverClose()` uses `if (shuttingDown) return` guard so calling `close()` multiple times is safe. Combined with `process.once` signal handlers, double-execution is impossible.
3. **`broadcastCursor` namespace now required**: Changed from `namespace?: string` (optional) to `namespace: string` (required). The only caller in `server.ts` always passes a namespace — no behavioral change.
4. **`addClient` return type**: Changed from `void` to `boolean` to allow callers to detect connection rejection without inspecting the `close` mock.
5. **Pre-existing failures**: 27 failures, all pre-existing — `wrapWithRowLevelNamespace is not a function` (related to Phase 03 DB adapter), `AUTH-001` JSON message mismatch, aggregate tests.

---

## Ready for Next Phase?

**Yes** — Phase 07 (Performance HIGH fixes: batch serverSeq, static imports, relation batch calls).

No blockers.
