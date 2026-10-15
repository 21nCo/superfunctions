# Automatic browser storage acceptance — 2026-10-15

Original `V0_SPEC.md` §7 automatic storage fallback is implemented in the TypeScript
SDK: `storage: 'auto'`, configurable IndexedDB/localStorage/memory order, actual
write/read availability probes, bounded localStorage, and terminal memory.
Explicit backend selections retain rejection behavior instead of silent switching.

The implementation uses owned random probe stores and cleans up their snapshots
or databases. Probe deadlines allow selection to continue if browser storage
hangs; outstanding probe cleanup completes when that browser operation settles.
Runtime security, quota and availability errors advance an instance permanently.
Serialization/programming errors propagate. Pending operations serialize across
a failover decision. No data migration or cross-tier invalidation is promised:
see the SDK README for cold misses and fresh-instance old-tier reuse semantics.
localStorage caps cover a complete named snapshot; namespace operations remain
isolated while capacity eviction can affect other namespaces sharing that name.

## Checks

- `npm --prefix cachefn/typescript test`: 158 tests across 13 files pass,
  including 14 new localStorage/fallback tests for disabled storage, getter
  security errors, quota rollback, runtime switching, concurrent writes, typed
  persistence, expiration, tag consistency, namespace/event isolation, probe
  cleanup and unsupported-value error propagation.
- `npm --prefix cachefn/typescript run typecheck`: source and schema fixtures pass.
- `npm --prefix cachefn/typescript run test:package`: ESM/CJS build, declarations,
  isolated packed NodeNext/Node16 TypeScript consumers and runtime smoke pass.
- Native Chrome 154.0.8037.58: 21 assertions pass via the persisted script below.
  Includes persistent typed localStorage values, overlapping namespaces, disabled
  IndexedDB/localStorage policy simulations, real native localStorage quota
  exhaustion with automatic memory fallback, and owned probe cleanup. The quota
  case writes a 10 MiB string with the SDK cap set to 40 MiB so Chrome itself,
  rather than the SDK byte cap, rejects the persistent write.

```sh
PLAYWRIGHT_MODULE_PATH=/Volumes/Dev/n/superfunctions/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node cachefn/typescript/scripts/browser-acceptance.mjs
```

Firefox/Safari were not exercised. Automatic fallback does not complete the
separate original adaptive-memory or offline-queue/synchronization requirements.
