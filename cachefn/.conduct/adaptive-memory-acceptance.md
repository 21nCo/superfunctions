# Adaptive browser memory acceptance — 2026-10-15

Implements original V0 §7 memory-conscious eviction API:
`eviction: 'adaptive'`, `memoryMonitoring.enabled`, `threshold`, `checkInterval`,
and `clear({ priority: 'low' })`. `SetOptions.priority` selects low/normal/high;
normal is the default. Sampling compares used heap / heap limit strictly above
threshold. Each pressured interval removes the lowest remaining priority group,
allowing subsequent samples to observe recovery before removing the next group.

Memory and automatic selected-memory backends support monitoring. Persistent
backends are not cleared to relieve heap pressure. LRU capacity behavior remains
unchanged. Entry priorities roundtrip through backend metadata. Manual filtered
clearing applies to the selected backend and current namespace. Pressure eviction
removes entries and tag indexes before invoking reentrant observers, and emits
memory-pressure eviction events/statistics. Unsupported/disabled monitoring
allocates no timer. `dispose()` stops monitoring idempotently without clearing
cache data; Node timers are unreferenced. Runtime invalid samples are ignored.

Checks:
- Full TypeScript suite: 165 tests / 14 files pass (all prior 158 retained).
- Seven deterministic injected heap/timer tests exercise order, threshold equality,
  changing usage, priority clearing, event/stats/tag consistency, unsupported and
  disabled cases, automatic memory tier, disposal, invalid samples/configuration.
- Source and schema fixture typechecks pass.
- Build plus packed ESM/CJS runtime and NodeNext/Node16 typed consumers pass.
- Chrome 154.0.8037.58: all 23 persisted browser assertions pass. The script adds
  an injected heap sample with actual browser timers
  to verify low-priority eviction and disposal. Heap readings are controlled for
  determinism; this does not claim to force actual browser garbage collection.

This completes adaptive policy behavior, not the original independent offline
queue/synchronization requirements. Firefox/Safari and total-heap performance
under production workloads have not been validated.
