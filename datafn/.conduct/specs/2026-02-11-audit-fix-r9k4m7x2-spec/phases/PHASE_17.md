# PHASE 17 — Cross-Tab Coordination

## Phase Goal
Enable event relay between browser tabs via BroadcastChannel for near-instant cross-tab reactivity.

## In Scope
- BroadcastChannel creation with namespace-scoped channel name
- Relay non-silent `mutation_applied` events to other tabs
- Receive events from other tabs and emit on local event bus
- Echo prevention via `sourceTabId`
- Cleanup on destroy
- Opt-in via `crossTab: true` config

## Out of Scope
- Leader election (sync engine ownership)
- Full state sync between tabs
- WebSocket deduplication across tabs

## Deliverables
- `client/src/crossTab.ts` — BroadcastChannel relay (NEW FILE)
- `client/src/client.ts` — crossTab config, integration
- `client/__tests__/crossTab.test.ts` — relay tests

## Requirements Covered
- TAB-001

## Implementation Tasks
1. Create `CrossTabRelay` class:
   ```typescript
   class CrossTabRelay {
     private channel: BroadcastChannel | null;
     private tabId: string;
     constructor(namespace: string, eventBus: EventBus) {
       this.tabId = crypto.randomUUID();
       if (typeof BroadcastChannel !== "undefined") {
         this.channel = new BroadcastChannel(`datafn:${namespace}`);
         this.channel.onmessage = (event) => {
           if (event.data.sourceTabId === this.tabId) return; // echo prevention
           eventBus.emit({ ...event.data.event, fromRemoteTab: true });
         };
       }
     }
     broadcast(event: DatafnEvent) {
       this.channel?.postMessage({ sourceTabId: this.tabId, event: sanitizeForRelay(event) });
     }
     close() { this.channel?.close(); this.channel = null; }
   }
   ```
2. `sanitizeForRelay()` — strip full record data, keep only metadata (resource, ids, action, fields, mutationId)
3. In client initialization, if `config.crossTab: true`:
   - Create `CrossTabRelay` with namespace
   - Subscribe to `mutation_applied` events (non-silent, non-fromRemoteTab) and call `relay.broadcast(event)`
4. In `client.destroy()`, call `relay.close()`
5. On received messages, emit with `fromRemoteTab: true` to prevent re-broadcast
6. Write test: mutation in client A triggers event in client B
7. Write test: silent mutations not relayed
8. Write test: no echo (same tab doesn't process own messages)
9. Write test: close on destroy
10. Write test: graceful degradation when BroadcastChannel unavailable
11. Run full test suite

## Verification Steps
- New tests pass: relay, echo prevention, silent suppression, cleanup
- `npm test -w @datafn/client` → 0 failures
- TV-TAB-001, TV-TAB-001N verified

## Stop Condition
Cross-tab event relay works correctly. All tests pass. Phase report written.
