# PHASE 07 — WebSocket Reconnection

## Phase Goal
Implement automatic WebSocket reconnection with exponential backoff and jitter.

## In Scope
- Reconnection on `onclose` event
- Exponential backoff with configurable parameters
- Jitter to prevent thundering herd
- Re-send `hello` with current cursors on reconnect
- `ws_disconnected` and `ws_connected` events
- Disable reconnect on `stop()` or `destroy()`
- Configurable via `DatafnSyncConfig.wsReconnect`

## Out of Scope
- WebSocket heartbeat/ping-pong
- Connection quality monitoring

## Deliverables
- `client/src/sync/engine.ts` — reconnection logic in connectWs()
- `client/__tests__/sync.test.ts` or new `ws-reconnect.test.ts` — reconnection tests

## Requirements Covered
- WS-001

## Implementation Tasks
1. Add `wsReconnect` to `DatafnSyncConfig` type with defaults
2. Add reconnection state to SyncEngine:
   ```typescript
   private wsReconnectAttempt = 0;
   private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
   private wsReconnectEnabled = true;
   ```
3. In `connectWs().onclose`:
   ```typescript
   this.ws.onclose = () => {
     this.ws = null;
     this.eventBus.emit({ type: "ws_disconnected", timestampMs: Date.now() });
     if (this.wsReconnectEnabled && config.wsReconnect?.enabled !== false) {
       this.scheduleReconnect();
     }
   };
   ```
4. Implement `scheduleReconnect()`:
   ```typescript
   private scheduleReconnect() {
     const { baseDelayMs = 1000, multiplier = 2, maxDelayMs = 60000, jitterMs = 500 } = this.config.wsReconnect ?? {};
     const delay = Math.min(baseDelayMs * Math.pow(multiplier, this.wsReconnectAttempt) + Math.random() * jitterMs, maxDelayMs);
     this.wsReconnectTimer = setTimeout(() => {
       this.wsReconnectAttempt++;
       this.connectWs(); // on success: reset attempt, emit ws_connected
     }, delay);
   }
   ```
5. On successful reconnection:
   - Reset `wsReconnectAttempt = 0`
   - Re-send `hello` with current cursors
   - Emit `ws_connected` event
6. In `stop()` and client destroy path:
   - Set `wsReconnectEnabled = false`
   - Clear `wsReconnectTimer`
7. Write test: WS reconnects after close
8. Write test: backoff delay increases on successive failures
9. Write test: reconnect disabled when stop() called
10. Write test: hello re-sent with cursors after reconnect
11. Write test: ws_disconnected and ws_connected events emitted
12. Write test: wsReconnect.enabled: false disables reconnection
13. Run full test suite

## Verification Steps
- New tests pass: reconnection, backoff, events, disable
- `npm test -w @datafn/client` → 0 failures
- TV-WS-001, TV-WS-001N verified

## Stop Condition
WebSocket reconnection works with exponential backoff. All tests pass. Phase report written.
