# PHASE_07: React binding

## Phase goal

Provide optional React binding (hook or component) that uses core chartFn() API, renders chart into a container ref or div, and calls handle.dispose() on unmount.

## In scope

- New package or subpath: @chartfn/react or chartfn/react
- useChart(containerRef, spec, options?) or <Chart spec={spec} adapter="echarts" /> that calls chartFn().render() and stores handle; on unmount/dispose calls handle.dispose()
- Dependency: React (peer or dependency); chartfn core; optionally one adapter (or user passes adapter via chartFn config)

## Out of scope

- Svelte binding (Phase 08); Carbon/Chart.js adapter internals

## Deliverables

- `packages/react/src/useChart.ts` or `react/useChart.tsx` – hook that accepts container ref (or creates ref), spec, optional adapter name; returns envelope or handle; useEffect cleanup calls dispose()
- Or `packages/react/src/Chart.tsx` – component with ref to div, spec prop, adapter prop; on mount render(spec), on unmount dispose()
- Tests: TV-REACT-001 (mount component/hook with spec, unmount, verify dispose was called)
- README or docs for React usage

## Requirements covered

- BIND-001

## Implementation tasks

1. Create React package or subpath; add React and chartfn core as dependencies.
2. Implement useChart(containerRef, spec, options?) or <Chart spec={spec} adapter={...} />:
   - On mount/effect: resolve container (ref.current or internal div), call api.render(container, spec, options), store handle.
   - On unmount/cleanup: if handle exists, handle.dispose().
3. User must provide chartFn instance (e.g. context or prop) or binding creates default chartFn with defaultAdapter from env/prop.
4. Write test: render component with spec, unmount, assert dispose was called (mock adapter that records dispose).
5. Document usage in README.

## Verification steps

- npm test in React package: TV-REACT-001 passes.
- Manual: use hook/component in CRA or Vite app; unmount; no leak (e.g. chart instance removed from DOM).

## Stop condition

- React binding works; TV-REACT-001 passes; docs updated; no regression in core or adapters.
