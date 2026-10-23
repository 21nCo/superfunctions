# PHASE 08 — Push Retry Exponential Backoff

## Phase Goal
Add exponential backoff with jitter to push retry logic, replacing immediate retries.

## In Scope
- Modify `pushWithRetries()` to add delays between retries
- Configurable via `DatafnSyncConfig.pushRetryBackoff`
- Reset on successful push

## Out of Scope
- Pull retry backoff (pull already works differently)
- Circuit breaker pattern

## Deliverables
- `client/src/sync/engine.ts` — backoff in pushWithRetries()
- `client/__tests__/sync.test.ts` — backoff tests

## Requirements Covered
- RET-001

## Implementation Tasks
1. Add `pushRetryBackoff` to `DatafnSyncConfig` type with defaults
2. Create helper `computeBackoffDelay(attempt, config)`:
   ```typescript
   function computeBackoffDelay(attempt: number, config: { baseDelayMs: number; multiplier: number; maxDelayMs: number; jitterMs: number }): number {
     return Math.min(config.baseDelayMs * Math.pow(config.multiplier, attempt) + Math.random() * config.jitterMs, config.maxDelayMs);
   }
   ```
3. Create `sleep(ms)` utility: `const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))`
4. In `pushWithRetries()`, add delay between retries:
   ```typescript
   while (attempt < maxAttempts) {
     try { ... push ... }
     catch (err) {
       if (isTransportError(err) && attempt < maxAttempts) {
         const delay = computeBackoffDelay(attempt, backoffConfig);
         await sleep(delay);
         attempt++;
         continue;
       }
       throw err;
     }
   }
   ```
5. Emit `sync_retry` event before each retry with attempt number and delay
6. Write test: retries have increasing delays
7. Write test: successful push resets backoff
8. Write test: max delay is capped
9. Write test: configurable backoff parameters work
10. Run full test suite

## Verification Steps
- New tests pass: backoff timing, cap, config
- `npm test -w @datafn/client` → 0 failures
- TV-RET-001, TV-RET-001N verified

## Stop Condition
Push retries use exponential backoff. All tests pass. Phase report written.
