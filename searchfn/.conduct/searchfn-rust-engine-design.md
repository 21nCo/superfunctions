# SearchFn Rust/WASM Engine Design

Issue: SF-25  
Date: 2026-03-28  
Status: Ideation / design draft

## Summary

Introduce an optional Rust-powered search core for SearchFn that compiles to WebAssembly for browser use and preserves the current TypeScript engine as a first-class fallback.

The recommended shape is:

- Keep `IndexedDbAdapter` as the storage/backend adapter.
- Make the compute engine inside that adapter pluggable: `ts`, `wasm`, or `auto`.
- Use dynamic loading for the WASM module so applications only pay the bundle/runtime cost when they opt in.
- Fall back to the existing TypeScript core automatically when WASM is unavailable or fails to initialize or execute correctly.

This keeps SearchFn's public API stable while allowing a faster engine for the CPU-heavy paths.

## Why This Exists

SearchFn already has a meaningful in-process search engine rather than a thin wrapper around an external database. The current hotspots are good candidates for a native core:

- Tokenization and pipeline execution
- Batch indexing
- Fuzzy expansion via Levenshtein
- Posting-list encode/decode
- BM25 scoring and ranking

The browser IndexedDB adapter is a good fit for this approach because the storage boundary is already separated from the compute boundary.

Current code hotspots:

- `searchfn/core/src/indexing/indexer.ts`
- `searchfn/core/src/pipeline/stages.ts`
- `searchfn/core/src/utils/levenshtein.ts`
- `searchfn/core/src/query/scoring.ts`
- `searchfn/core/src/query/query-engine.ts`
- `searchfn/core/src/storage/chunk-serializer.ts`
- `searchfn/adapter-indexeddb/src/index.ts`
- `searchfn/core/src/storage/indexeddb-manager.ts`

## Goals

- Provide an optional Rust/WASM execution path for SearchFn's compute-heavy operations.
- Preserve full compatibility with the current `SearchAdapter` API.
- Keep the current TypeScript core as a supported engine, not just a temporary migration aid.
- Allow runtime selection so apps can choose or automatically fall back in constrained environments such as problematic iOS WebViews.
- Keep IndexedDB persistence working with the browser adapter.
- Avoid forcing WASM bundle cost on every SearchFn consumer.

## Non-Goals

- Rewriting the entire browser adapter in Rust.
- Making IndexedDB itself Rust-owned in the first phase.
- Requiring WASM for all SearchFn users.
- Breaking current storage immediately with a hard migration.
- Solving all WebView runtime issues solely through engine switching. If IndexedDB itself is unstable in a host environment, a TS fallback will not fix that.

## Recommendation

### Recommended architecture

Use one IndexedDB adapter with an internal pluggable engine:

- Adapter/backend: `indexeddb`
- Engine implementation: `ts | wasm | auto`

This is preferable to publishing separate user-facing adapters such as `IndexedDbAdapter` and `IndexedDbWasmAdapter`, because the storage backend is still IndexedDB in both cases. The difference is execution engine, not adapter semantics.

### Why this is the best fit

- Keeps docs and mental model simple: users still choose the IndexedDB adapter.
- Minimizes public API churn.
- Makes fallback behavior straightforward.
- Avoids splitting capabilities and tests across multiple near-identical adapters.
- Lets the existing client constructors evolve naturally.

## Proposed Public API

### Adapter config

Add engine selection to `IndexedDbAdapterOptions`:

```ts
export interface IndexedDbAdapterOptions {
  dbName?: string;
  pipeline?: PipelineOptions;
  cache?: { terms?: number; vectors?: number };
  defaults?: SearchDefaults;

  engine?: "ts" | "wasm" | "auto";
  wasmLoader?: () => Promise<SearchFnWasmModule>;
  onEngineSelected?: (info: { engine: "ts" | "wasm"; reason: string }) => void;
  onWasmFallback?: (info: { reason: string; error?: unknown }) => void;
}
```

### Constructor usage

```ts
createIndexedDbSearchClient({
  adapterConfig: {
    engine: "auto",
    wasmLoader: () => import("@searchfn/core-wasm")
  }
});
```

### Default behavior

- Default should remain `engine: "ts"` initially for conservative rollout.
- After the WASM path proves stable, we can consider `engine: "auto"` as a future default.

## Proposed Package Layout

### Option A: recommended

- `searchfn/core/` -> existing TypeScript implementation
- `searchfn/core-wasm/` -> JS package that loads the browser WASM module and exposes a thin TS wrapper
- Rust crate under `searchfn/core-wasm/rust/` or similar

This keeps the optional WASM payload out of the default `@searchfn/core` package and allows lazy loading.

### Option B: possible but less ideal

Put the Rust/WASM build artifacts directly into `@searchfn/core`.

This is simpler in package count but worse for bundle size, publish flow, and optional adoption.

## Internal Architecture

### New internal interface

Introduce an internal engine contract used by `IndexedDbAdapter`:

```ts
interface SearchCoreEngine {
  ingestBatch(records: IndexingInputRecord[]): EngineIngestBatchResult;
  buildQueryTokens(input: BuildQueryTokensInput): QueryToken[];
  executeQuery(input: ExecuteQueryInput): EngineQueryResult;
  encodePostings(input: EnginePosting[]): EncodedPostingChunk;
  decodePostings(input: ArrayBuffer, encoding: string): EnginePosting[];
}
```

Implementations:

- `TsSearchCoreEngine`
- `WasmSearchCoreEngine`

### Boundary placement

Keep these in TypeScript:

- `IndexedDbManager`
- object store creation
- transaction management
- adapter lifecycle
- client constructors and adapter contract integration

Move these into Rust/WASM:

- tokenization
- stop-word filtering
- stemming
- edge n-gram generation
- fuzzy expansion
- ingest accumulation
- posting encode/decode
- scoring and ranking

This keeps the JS/WASM boundary coarse enough to be worth it.

## Browser Execution Model

### Phase 1 model

- The app dynamically imports the WASM wrapper if configured.
- The wrapper initializes the WASM module.
- The IndexedDB adapter uses the selected engine instance.
- The adapter still reads and writes IndexedDB through existing TS code.

### Worker support

Bulk indexing should continue to work well in a Worker and should be explicitly supported for the WASM engine.

Reasons:

- avoids blocking the main thread
- isolates WASM initialization cost
- better fit for large ingest jobs
- easier fallback if worker initialization fails

We should preserve the current worker-friendly story already present in `searchfn/client/examples/bulk-indexing-worker.ts`.

## Runtime Selection Strategy

### Engine modes

#### `ts`

- Never attempt WASM.
- Use current implementation only.

#### `wasm`

- Require WASM to initialize successfully.
- Throw a clear startup error if it cannot.

#### `auto`

- Attempt to load and initialize WASM.
- If initialization or a startup self-test fails, fall back to TS.
- Emit `onWasmFallback`.

### Fallback rules

Fallback should happen on:

- missing `WebAssembly`
- dynamic import failure
- module instantiation failure
- startup ABI/version mismatch
- self-test failure
- known runtime errors during first use

We should avoid relying on user-agent deny lists as the primary mechanism. Capability checks and real initialization tests are more robust. If we later discover a narrow set of host-specific failures, a deny list can be added as a tactical patch.

## IndexedDB Compatibility

Yes, the WASM engine can work with the IndexedDB adapter.

The key point is that WASM does not need to directly own IndexedDB for this to work. TypeScript can continue to call:

- `open()`
- `putTermChunk()`
- `putTermChunksBatch()`
- `getTermChunk()`
- `putCacheState()`
- `getCacheState()`

and pass plain buffers or structured data to the engine.

This is the simplest and safest approach for the browser.

### Full Rust ownership of IndexedDB

It is technically possible to use `web-sys` and access IndexedDB from Rust/WASM directly, but this is not recommended for the first implementation.

Why not:

- IndexedDB is an async DOM API with awkward ergonomics in Rust/WASM
- the storage code is not the main hotspot
- it increases complexity without increasing confidence
- it makes fallback and integration harder

## Storage Format

### Current situation

The current IndexedDB adapter serializes postings into JSON strings and then feeds them through posting encoding:

- `postingsArray.map((e) => JSON.stringify(e))`
- `encodePostings(serialized)`

At query time, payloads are decoded and then parsed back into posting objects.

This is functional but leaves performance on the table.

### Proposed direction

Introduce a binary-first posting representation for the WASM path:

- doc-id dictionary or normalized string table
- packed term frequencies
- packed metadata flags for common fields such as `isPrefix`
- compact chunk header with doc frequency and optional IDF

### Migration strategy

Do not force an immediate breaking storage migration.

Instead:

- add a new encoding variant for binary payloads
- keep the current JSON-compatible path readable
- allow dual-read during rollout
- allow reindexing to upgrade stored payloads over time

This lets us ship WASM safely without invalidating existing local indexes.

## Client and Adapter Changes

### `@searchfn/client`

Current constructors already choose adapters centrally. Extend `createIndexedDbSearchClient()` so callers can provide engine options and optional WASM loader.

### `@searchfn/adapter-indexeddb`

Refactor the adapter so all compute-heavy sections delegate to an internal engine instance.

High-value refactor points:

- `buildQueryTokens()`
- indexing/ingest path
- posting serialization path
- query execution path

### `@searchfn/adapter-contracts`

No public changes required.

That is a major advantage of the recommended design.

## Python Story

This design also creates a path to a shared Rust core for Python later.

Potential future targets:

- browser: WASM
- Node/server: native module or WASM
- Python: `pyo3`/`maturin`

This is not required for phase 1, but it is a strong strategic reason to isolate the core engine behind an internal contract now.

## Risks

- JS/WASM boundary overhead can erase wins if APIs are too fine-grained.
- Bundle size can increase if WASM is not lazy-loaded.
- Cross-browser and WebView stability may vary.
- Binary encoding migration can add complexity.
- Maintaining TS and Rust engines in lockstep requires careful testing.

## Mitigations

- Keep the boundary coarse.
- Lazy-load the WASM package.
- Keep TS as a permanent fallback.
- Add golden tests that compare TS and WASM outputs.
- Add browser matrix tests, including problematic WebView targets where possible.
- Roll out with `engine: "ts"` default first.

## Testing Strategy

### Correctness

- Golden tests for tokenization, fuzzy expansion, scoring, and ranking parity.
- IndexedDB round-trip tests with TS engine and WASM engine.
- Migration tests for old and new chunk encodings.

### Runtime selection

- `engine: "ts"` never touches WASM
- `engine: "wasm"` fails fast if unavailable
- `engine: "auto"` falls back cleanly

### Browser coverage

- Chromium
- Firefox
- Safari
- at least one mobile/WebView-focused integration path when feasible

### Performance

- batch ingest benchmarks
- fuzzy search benchmarks
- repeated-query latency benchmarks
- memory footprint comparison

## Rollout Plan

### Phase 1: engine extraction

- extract an internal `SearchCoreEngine` contract
- implement `TsSearchCoreEngine`
- keep behavior unchanged

### Phase 2: WASM prototype

- build `@searchfn/core-wasm`
- implement tokenization, scoring, posting encode/decode
- wire `engine: "wasm"` behind an experimental flag

### Phase 3: auto fallback

- add `engine: "auto"`
- add startup self-test and telemetry hooks
- add dynamic loading

### Phase 4: binary storage

- add new posting encoding
- dual-read old and new formats
- benchmark and optimize

### Phase 5: broader runtime adoption

- worker-focused path
- optional Node/server support
- evaluate Python binding reuse

## Open Questions

- Should `engine: "auto"` become the default after stabilization, or should SearchFn remain opt-in forever for WASM?
- Do we want the binary posting format to be shared across TS and Rust, or only produced by the Rust path initially?
- Should WASM initialization happen on adapter construction or lazily on first index/search call?
- Do we want a worker-first WASM path for large indexing jobs, or should worker integration remain app-managed?
- How much parity do we require before publishing `@searchfn/core-wasm` publicly?

## Final Recommendation

Proceed with a pluggable engine design inside `IndexedDbAdapter`, not a separate user-facing WASM adapter.

Ship an optional package such as `@searchfn/core-wasm`, loaded dynamically, and expose:

- `engine: "ts" | "wasm" | "auto"`
- `wasmLoader`
- `onEngineSelected`
- `onWasmFallback`

Use the existing IndexedDB adapter as the stable storage layer and move only the compute-heavy core into Rust/WASM.

This gives SearchFn:

- better performance where WASM works well
- safe fallback where it does not
- minimal public API churn
- a future path to a shared Rust core across TypeScript and Python
