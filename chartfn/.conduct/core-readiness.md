# ChartFn current core acceptance

Readiness is in progress. This record describes current local evidence, not a release or publication claim.

## Requirements evidence

Source requirements: `specs/2026-01-29-new-cf7k2m9x-spec/REQUIREMENTS.md`.

| Requirement | Current evidence |
|---|---|
| API-001, API-006 factory, registration and defaults | `chart-fn.test.ts` checks factory methods, registration, missing adapters and default selection. |
| API-002, VALID-001 validation before mount | `validate.test.ts`, `chart-fn.test.ts`, `core-readiness.test.ts`; malformed types/series/dimensions/labels/nonfinite or sparse values fail before mounting. |
| API-003 adapter interface | Public TS interfaces and all adapters compile; custom adapter mock tests verify mounting. |
| API-004 render selection and container resolution | `chart-fn.test.ts`, `adapter-error.test.ts`; real Chrome checks invalid CSS selector returns envelope. |
| API-005 envelopes | Render/validation envelopes tested, including null spec and vendor mount exceptions. API-005 wording is reconciled with the explicit API-003/007/008 signatures: render/validation return envelopes; imperative handles propagate exceptions/rejections. This preserves the declared adapter interface. |
| LIMIT-001 | `validate.test.ts` checks 100 series, 10,000 points and 1 MiB serialized payload limits. |
| ADAPT-001 ECharts | Unit tests plus real Chrome all-seven-type rendering, live instance inspection, theme/type updates, exports and disposal. Mount failure cleans up partially created instances. |
| ADAPT-003 Chart.js | Unit tests plus real Chrome all-seven-type rendering, parsed scatter points, mixed combo series, registered area filler and type changes. Supports owned canvases in HTML containers. |
| API-007 lifecycle | `handle-lifecycle.test.ts` and `core-readiness.test.ts` prove custom handle disposal is idempotent and invalid/disposed updates do not reach adapters. Browser acceptance verifies vendor teardown. |
| SPEC-001 passthrough | `passthrough-determinism.test.ts` checks unknown vendor options are retained. Core validates only the record shape/overall payload size, not vendor option contents. |
| DETERM-001 | Stable option-building test and inspection: no random/time source in normalization or validation. Browser fixtures disable animation. |
| API-008 optional exports | ECharts PNG/SVG exports tested in Chrome; requested 320x200 PNG dimensions decoded and checked. No requirement for custom adapters to export. |
| OBS-001 | `observability.test.ts` exercises production logging and verifies absence of full series data. |
| COMPAT-001 | README preserves stable-v1 policy and additive optional adapter methods. Combo series.type is additive. |
| ADAPT-002, BIND-001, BIND-002 | Carbon and framework bindings have separate concurrent owners; require their final integration evidence before full readiness. |

## Reproducible browser command

```sh
PLAYWRIGHT_MODULE_PATH=/Volumes/Dev/n/superfunctions/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node chartfn/scripts/browser-acceptance.mjs
```

First verified browser snapshot: Chrome **154.0.8037.58**, **88 checks**, **zero page errors**, covering Chart.js and ECharts. The script bundles current source, serves a temporary loopback page, starts a fresh headless context and closes browser/server in finally. Carbon coverage is being integrated into the same script; rerun for final aggregate evidence.

Current integrated core snapshot: **51 tests across 12 files passed**, TypeScript typecheck passed, including Carbon replacement and ECharts failure recovery/theme/multiple-pie and sparse-array regressions. Final aggregate browser run with ECharts 6.1.0 passes 149 checks with zero page errors, including Carbon actual-mark and nonblank export assertions. No claims here about packaged consumers or publication.

## Final correction validation, 2026-10-15

Patched Svelte minimum5.57.2; browser logger defaults warn; excessive series rejected before values copied; explicit ECharts legend, failed-theme replacement recovery, and nested Svelte mutation updates corrected.55 core/3React/3Svelte tests, all types/builds pass. Chrome154.0.8037.58 vendor149 assertions no page errors. Packed framework matrix React16.8.6/16.14.0/18.3.1/19.3.1 and Svelte5.57.2 passes. Fresh tarballs ESM/CJS(core/React), React/Svelte SSR pass Node18.18.0/20.20.0/22.23.3; TS5.9 Node16/NodeNext. Consumer `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/chartfn-consumer-ue3OM2`; runtime audit0 advisories127prod5dev. Hosted CI remains a separate gate.
