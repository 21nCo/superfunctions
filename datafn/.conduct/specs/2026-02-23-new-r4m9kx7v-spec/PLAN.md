# PLAN: Lifecycle-Aware Signals — Execution Strategy

## Architecture Sketch

### Modules and Responsibilities

```
@datafn/core (datafn/core/)
├── types.ts
│   └── defineSchema() → return type change: DatafnSchema → T & DatafnSchema
│
@datafn/client (datafn/client/)
├── src/
│   ├── signals/
│   │   ├── querySignal.ts ........... Raw signal creation (UNCHANGED)
│   │   └── liveSignal.ts ............ NEW: LiveSignal wrapper + LiveSignalRegistry
│   ├── client.ts .................... Proxy extension: table/kv wrapping, rebindAll in performSwitch
│   ├── switchableClient.ts .......... JSDoc @deprecated tags
│   └── index.ts ..................... Updated exports
│
@datafn/svelte (datafn/svelte/)
├── src/
│   ├── toSvelteStore.ts ............. New overload: toSvelteStore(signal), deprecate factory overload
│   └── index.ts ..................... Updated exports
│
Todo App (datafn/examples/todo-app/)
├── client/src/
│   ├── lib/datafn.ts ................ Use defineSchema (remove explicit DatafnSchema annotation)
│   └── App.svelte ................... Replace factory pattern with direct signal usage
```

### Dependency Graph

```
Phase 0: defineSchema type fix + @deprecated tags
    │     (TYPE-001, TYPE-002, TYPE-003, DEPR-001, DEPR-002)
    │     No code dependencies on other phases.
    │
    ▼
Phase 1: LiveSignal + LiveSignalRegistry
    │     (SIG-LIVE-001..008, REG-001..004)
    │     No dependency on Phase 0 (uses DatafnSignal<T> interface unchanged).
    │     But logically Phase 0 should land first for clean type inference in tests.
    │
    ▼
Phase 2: Proxy integration in createDatafnClient
    │     (PROXY-001..007)
    │     Depends on Phase 1 (imports LiveSignalRegistry).
    │
    ▼
Phase 3: @datafn/svelte simplification
    │     (SVELTE-001..003)
    │     Depends on Phase 2 (LiveSignals must exist for toSvelteStore(signal) to be useful).
    │
    ▼
Phase 4: Todo app migration + verification
          (APP-001..004)
          Depends on Phase 0 (defineSchema types), Phase 2 (LiveSignals via Proxy),
          and Phase 3 (simplified toSvelteStore).
```

### Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 0 | Type system prerequisites | `defineSchema` preserves literal names; `@deprecated` JSDoc on switchable client | TypeScript compile check: `ResourceNames<typeof schema>` resolves to literals; IDE shows deprecation strikethrough |
| 1 | Core LiveSignal implementation | `LiveSignal<T>` class + `LiveSignalRegistry` with deduplication, rebind, dispose | Unit tests: signal survives mock switch, dedup, dispose cleanup, error capture |
| 2 | Proxy integration | `createDatafnClient` Proxy wraps `.table().signal()`, `.kv.signal()`, `performSwitch` calls rebindAll | Integration tests: signals created through Proxy survive real `switchContext()` |
| 3 | Svelte adapter simplification | `toSvelteStore(signal)` direct overload; factory overload deprecated | Unit test: store updates after signal rebind; compile test: direct overload works |
| 4 | Todo app migration | Example app uses clean one-liner signal API, zero `as any` casts | Manual: app runs, switches modes, signals update; compile: no `as any` in signal code |

### Definition of Done (global)

No phase is complete unless:
1. All listed verification steps pass.
2. All requirement IDs for that phase are satisfied.
3. Existing tests continue to pass (`npm test` in the affected packages).
4. No new TypeScript compilation errors are introduced.
