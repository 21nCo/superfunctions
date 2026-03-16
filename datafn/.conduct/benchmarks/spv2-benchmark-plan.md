# SPV2 Benchmark Plan (PHASE_09)

## Goal
Validate that SPV2 pull assembly and websocket invalidation stay performant for ACL-heavy workloads.

## Scope
- Pull assembly path in `datafn/server/src/execution/sync/pull.ts`.
- Shared-with-me ACL index readiness checks in `datafn/server/src/execution/query/pushdown.ts`.
- WebSocket targeting and fallback behavior in `datafn/server/src/ws.ts`.

## Preconditions
- Run from repository root: `/Users/serro/Documents/dev/n/superfunctions`.
- Use a SQL adapter/runtime where ACL indexes are present for the positive benchmark profile.
- Capture Node version and adapter details in benchmark notes.

## Benchmark workloads
1. ACL index diagnostics
- Profile A (positive): provide full ACL index catalog.
- Profile B (negative): omit ACL indexes and confirm deterministic guard failure.

2. Pull assembly window
- Resource streams: 12
- Per-resource change volume: 50000 (logical workload shape)
- Pull window limit: 256
- Expected algorithm: bounded k-way merge (no flatten+sort global assembly path)

3. WebSocket invalidation fanout
- Targeted mode: affected principals list includes one principal.
- Fallback mode: include at least one connection without principal hints.

## Commands
1. Smoke verification
```bash
npm test --workspace datafn/server -- spv2-perf-smoke
```

2. Manual benchmark loop (repeat 5 runs)
```bash
for i in 1 2 3 4 5; do
  npm test --workspace datafn/server -- spv2-perf-smoke --runInBand
 done
```

## Metrics to capture
- Pull merge peak working window (`peakWindow`) from test instrumentation.
- Process RSS and heap peak while running the benchmark loop.
- End-to-end test duration per run.
- p95 run duration across the 5 manual runs.
- WS targeted wake count vs fallback wake count.

## Acceptance thresholds
- Bounded merge window remains `<= pullLimit + resourceCount`.
- No full namespace wakeup in targeted mode when all clients are targetable.
- Fallback mode is explicitly marked degraded and remains correct.
- p95 run duration is stable for local environment baseline (no monotonic degradation trend across 5 runs).

## Reporting template
Record the following in the phase report or follow-up benchmark note:
- Environment: Node version, adapter, machine profile.
- Run durations: `run1..run5` and computed p95.
- Peak memory observations (RSS/heap).
- Targeted and fallback wake counts.
- Any regressions or anomalies.
