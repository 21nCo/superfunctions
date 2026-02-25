# PHASE 08: Observability (Execution Timing)

## Phase Goal

Add structured execution-phase timing to query, mutation, and sync operations, emittable via configuration.

## In Scope

- `ExecutionTimingEvent` type definition
- Timing instrumentation in query handler (all three strategies)
- Timing instrumentation in mutation handler
- Timing instrumentation in pull/push handlers
- Configuration via `observability.timing` and `observability.onTiming`
- Default `console.debug` handler

## Out of Scope

- OpenTelemetry / tracing SDK integration (can be built on top of `onTiming`)
- Metrics aggregation
- Logging of record data or filter values

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/middleware/timing.ts` | CREATE — timing utility and types |
| `datafn/server/src/routes/query.ts` | MODIFY — instrument query phases |
| `datafn/server/src/routes/mutation.ts` | MODIFY — instrument mutation phases |
| `datafn/server/src/routes/sync.ts` | MODIFY — instrument pull/push phases |
| `datafn/server/src/server.ts` | MODIFY — wire observability config |
| `datafn/server/src/core-types.ts` | MODIFY — add `ObservabilityConfig` type |
| `datafn/server/__tests__/timing.test.ts` | CREATE — timing tests |

## Requirements Covered

- OBS-001 (Query execution timing)
- OBS-002 (Mutation execution timing)
- OBS-003 (Sync execution timing)
- OBS-004 (Timing configuration)

## Implementation Tasks

1. Create `datafn/server/src/middleware/timing.ts`:
   ```typescript
   export interface ExecutionTimingEvent {
     endpoint: string;
     resource?: string;
     operation?: string;
     phases: Record<string, number>;
     totalMs: number;
     timestamp: string;
   }

   export class ExecutionTimer {
     private phases: Record<string, number> = {};
     private current: { name: string; start: number } | null = null;
     private startTime: number;

     constructor() { this.startTime = Date.now(); }

     startPhase(name: string) {
       this.endPhase();
       this.current = { name, start: Date.now() };
     }

     endPhase() {
       if (this.current) {
         this.phases[this.current.name] = Date.now() - this.current.start;
         this.current = null;
       }
     }

     build(endpoint: string, resource?: string, operation?: string): ExecutionTimingEvent {
       this.endPhase();
       const totalMs = Date.now() - this.startTime;
       this.phases.total = totalMs;
       return { endpoint, resource, operation, phases: { ...this.phases }, totalMs, timestamp: new Date().toISOString() };
     }
   }

   export type TimingEmitter = (event: ExecutionTimingEvent) => void;

   export function createTimingEmitter(config?: { timing?: boolean; onTiming?: TimingEmitter }): TimingEmitter | null {
     if (!config?.timing) return null;
     const handler = config.onTiming || ((event) => console.debug("[datafn:timing]", event));
     return (event) => {
       try { handler(event); } catch (e) { console.warn("Timing handler error:", e); }
     };
   }
   ```

2. Instrument query handler (`routes/query.ts`):
   - Create `ExecutionTimer` at handler start
   - `startPhase("validate")` before validation
   - `startPhase("plan")` before classification
   - `startPhase("fetch")` before DB fetch / DbDataStore creation
   - `startPhase("filter")` before in-memory filter (0ms for push-down)
   - `startPhase("sort")` before sort (0ms for push-down)
   - `startPhase("paginate")` before pagination
   - `startPhase("materialize")` before select materialization
   - Emit event after response is computed

3. Instrument mutation handler (`routes/mutation.ts`):
   - Phases: `validate`, `guard`, `execute`, `changeLog`, `idempotency`

4. Instrument sync handlers (`routes/sync.ts`):
   - Pull phases: `validate`, `fetchChanges`, `buildResult`
   - Push phases: `validate`, `execute`, `changeLog`

5. Wire into `server.ts`:
   - Create `timingEmitter` from config
   - Pass to route handler factories

6. Tests:
   - TV-OBS-QUERY-001: timing event has correct phase structure
   - TV-OBS-MUT-001: mutation timing event
   - TV-OBS-SYNC-001: pull timing event
   - TV-OBS-CONFIG-001: timing disabled → no events

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/timing.test.ts
npx vitest run
npx tsc --noEmit
```

**Expected**: All timing tests pass. Existing tests unaffected (timing disabled by default). No performance regression when timing is off.

## Stop Condition

Report: Execution timing implemented for all endpoints. Default and custom handlers verified. No overhead when disabled.
