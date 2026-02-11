# PHASE_08: Svelte binding

## Phase goal

Provide optional Svelte binding (component or action) that uses core chartFn() API and calls handle.dispose() on component destroy.

## In scope

- New package or subpath: @chartfn/svelte or chartfn/svelte
- Component or action: accepts spec, optional adapter; on mount renders chart; on destroy calls handle.dispose()
- Dependency: Svelte; chartfn core; optionally one adapter

## Out of scope

- React binding (Phase 07); adapter internals

## Deliverables

- `packages/svelte/src/Chart.svelte` or `svelte/Chart.svelte` – component with bind:this or internal div, spec prop, adapter prop; onMount render; onDestroy dispose
- Or useChart(containerRef, spec) action or similar
- Tests: TV-SVELTE-001 (mount Svelte component with spec, destroy, verify dispose called)
- README for Svelte usage

## Requirements covered

- BIND-002

## Implementation tasks

1. Create Svelte package or subpath; add Svelte and chartfn core as dependencies.
2. Implement Chart.svelte (or equivalent): onMount: get container (div), api.render(container, spec, options), store handle; onDestroy: handle.dispose().
3. User provides chartFn instance via context or prop; or binding uses default.
4. Write test: mount Svelte component with spec, destroy, assert dispose was called (mock adapter).
5. Document usage in README.

## Verification steps

- npm test in Svelte package: TV-SVELTE-001 passes.
- Manual: use component in Svelte app; destroy component; no leak.

## Stop condition

- Svelte binding works; TV-SVELTE-001 passes; docs updated; no regression.
