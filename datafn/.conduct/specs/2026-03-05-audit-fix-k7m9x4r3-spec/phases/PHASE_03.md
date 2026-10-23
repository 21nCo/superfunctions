# PHASE_03: WebSocket Logging, CAS Retry Logging, Idempotency JSON.parse Narrowing

## Phase Goal

Fix all remaining LOW-priority audit findings: WebSocket error logging, CAS retry intermediate failure logging, and idempotency JSON.parse catch narrowing.

## In Scope

- WS-001: Log WebSocket heartbeat ping failures at warn level
- WS-002: Log WebSocket `handleMessage` errors at warn level
- WS-003: Log WebSocket `close()` errors at warn level
- CAS-001: Log CAS retry intermediate failures in `sequence-store.ts`
- CAS-002: Log CAS retry intermediate failures in `change-tracking.ts`
- IDEM-001: Narrow `idempotency-db.ts` JSON.parse catch

## Out of Scope

- All items addressed in PHASE_00, PHASE_01, PHASE_02.

## Deliverables

| File | Change |
|------|--------|
| `datafn/server/src/ws.ts` | Add `this.logger?.warn(...)` to 3 catch blocks |
| `datafn/server/src/execution/sync/sequence-store.ts` | Add `this.logger?.warn(...)` to CAS retry catch blocks |
| `datafn/server/src/execution/sync/change-tracking.ts` | Add `this.logger?.warn(...)` to CAS retry catch blocks |
| `datafn/server/src/execution/idempotency-db.ts` | Narrow `get()` JSON.parse catch to distinguish SyntaxError |

## Requirements Covered

WS-001, WS-002, WS-003, CAS-001, CAS-002, IDEM-001

## Implementation Tasks

### WebSocket logging

1. [ ] `ws.ts` heartbeat ping catch (~line 101-106): Add `this.logger?.warn("Heartbeat ping failed", { error: String(e), operation: "ws-heartbeat" });` after the `catch {` line (change to `catch (e) {`).
2. [ ] `ws.ts` `handleMessage` catch (~line 188-190): Change `catch {` to `catch (e) {` and add `this.logger?.warn("WebSocket message handling error", { error: String(e), operation: "ws-message" });`.
3. [ ] `ws.ts` `close()` catch (~line 228-230): Change `catch {` to `catch (e) {` and add `this.logger?.warn("WebSocket close error", { error: String(e), operation: "ws-close" });`.

### CAS retry logging

4. [ ] `sequence-store.ts` `getNextN` initial create catch (~line 188-190): Add `this.logger?.warn("Sequence allocation create retry", { attempt, error: String(error), operation: "seq-create" });` inside the catch before `continue`.
   - Change bare `catch {` to `catch (error) {`.
5. [ ] `sequence-store.ts` `getNextN` CAS update catch (~line 209-211): Add `this.logger?.warn("Sequence allocation CAS retry", { attempt, error: String(error), operation: "seq-cas" });` inside the catch before `continue`.
   - Change bare `catch {` to `catch (error) {`.
6. [ ] `change-tracking.ts` `getNextServerSeqBatchFromDb` CAS retry catch (~line 157-168): If intermediate failures are not already logged, add `this.logger?.warn("Sequence batch CAS retry", { attempt, error: String(error), operation: "seq-batch-cas" });` inside the catch.

### Idempotency JSON.parse narrowing

7. [ ] `idempotency-db.ts` `get()` catch (~line 44-46): Replace:
   ```typescript
   } catch {
     return null;
   }
   ```
   With:
   ```typescript
   } catch (error) {
     if (!(error instanceof SyntaxError)) {
       this.logger?.warn("Idempotency store get: unexpected error during parse", {
         error: String(error),
         operation: "idempotency-get",
       });
     }
     return null;
   }
   ```

### Test & verify

8. [ ] Run `npx vitest run datafn/server` — all tests pass.
9. [ ] TypeScript compilation check — no errors.

## Verification Steps

1. `npx vitest run datafn/server` — all tests pass.
2. Grep to verify no bare `catch {` blocks remain in:
   - `ws.ts` (all 3 should now have error variable and logging)
   - `sequence-store.ts` CAS loops
   - `change-tracking.ts` CAS loops
   - `idempotency-db.ts` get()
3. TypeScript compilation — no errors.

## Expected Outcomes

- All WebSocket error paths are observable in server logs.
- CAS retry intermediate failures are visible at warn level.
- Idempotency `get()` logs unexpected (non-JSON-parse) errors.
- **ALL 24 audit findings are now resolved.**

## Stop Condition

Report: all files modified, all tests pass, grep confirms no remaining unlogged catch blocks in target files. Final audit confirmation: all 24 findings addressed.
