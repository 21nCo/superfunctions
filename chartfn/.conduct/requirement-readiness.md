# ChartFn requirement completion evidence

2026-10-20 UTC. Baseline: `d08c44a47` on the ChartFn branch based on sf-next/next. This accounts for every numbered requirement in `specs/2026-01-29-new-cf7k2m9x-spec/REQUIREMENTS.md`, its test vectors, and all 18 items in `chartfn.intent.md`. Existing target/install/packed-framework evidence is recorded separately in `pr-destination.md`; it is not presented as a new hosted run.

Status meanings: **Implemented** means the stated behavior has source and relevant executable evidence. **Qualified** identifies a conflict or narrower contract that must remain visible. Neither status establishes unrestricted production readiness, registry publication or deployment.

## All 19 numbered requirements

| Requirement | Status | Implementation and executable evidence |
| --- | --- | --- |
| API-001 factory/config | Implemented | `src/chart-fn.ts` exposes factory, render, register/use and default getters/setter. `__tests__/chart-fn.test.ts` covers TV-API-CONFIG-001/002 and initially unregistered defaults. |
| API-002 schema/validation | Implemented | `src/types.ts` defines all seven types; `src/validate.ts` rejects missing/unknown type, missing/empty series, invalid/nonfinite/sparse numeric values and malformed labels. `validate.test.ts` and `core-readiness.test.ts` cover TV-SPEC-VALID-001 and INVALID-001/002/003. This change adds sparse dimensions/labels rejection rather than accepting holes that serialize as null. |
| API-003 adapter interface | Implemented | `ChartAdapter` has readonly name, mount and imperative update/dispose handle. Inline/mock adapters in `chart-fn.test.ts` execute TV-ADAPTER-INTERFACE-001; built-in adapters implement the same interface. |
| API-004 render/selection | Implemented | `src/resolve-container.ts` supports element/selector and catches invalid selectors; `src/chart-fn.ts` selects override/default and validates before mount. `chart-fn.test.ts` covers TV-RENDER-001/002/003/004; prior real-browser acceptance checks actual vendor DOM. Invalid containers use ADAPTER_ERROR as allowed by the requirement note. |
| API-005 error envelopes | Qualified | `render` and `validateChartSpec` satisfy TV-ENVELOPE-001/002/003 with code/message/details; `adapter-error.test.ts` and `observability.test.ts` cover failures. The broad statement that **all** fallible operations return an envelope conflicts with the original detailed SPEC/public types specifying `update():void`, `dispose():void`, and `toImage():Promise<string>`. Current README explicitly documents imperative throws/rejections. This record does not silently redefine that statement as complete. Mount error text is now generic to avoid exposing vendor messages containing chart data. |
| ADAPT-001 ECharts | Implemented | `src/adapters/echarts.ts`; unit adapter/readiness tests cover mapping, update/dispose, partial construction cleanup and recovery after failed theme replacement. Prior actual Chrome tests exercise all seven types, real series and sized PNG/SVG exports (TV-ECHARTS-001/002). New independent-mount pixel comparisons cover each type. |
| ADAPT-002 Carbon | Implemented | `src/adapters/carbon.ts`; `carbon-adapter.test.tsx` covers grouped data, distinct series, combo layers, numeric axes, circular slices, themes, update failure and disposal. Prior actual Chrome SVG/PNG checks cover all seven types (TV-CARBON-001/002); new comparisons confirm repeatability. Carbon requires its stylesheet. |
| VALID-001 before adapter | Implemented | `src/chart-fn.ts` validates before selecting/mounting; `chart-fn.test.ts` verifies invalid data never reaches the recording adapter (TV-VALID-BEFORE-ADAPTER-001). Core and direct adapters also validate updates, stronger than the minimum note. |
| LIMIT-001 limits | Implemented | `src/constants.ts`/`validate.ts` enforce 100 series, 10,000 points per series, and 1 MiB UTF-8 serialized size in supported runtimes. `validate.test.ts` exercises all three limit vectors; `bounds-and-logging.test.ts` verifies oversized values are rejected before reading entries. These caps do not establish a general process-memory ceiling. |
| ADAPT-003 Chart.js | Implemented | `src/adapters/chartjs.ts`; `chartjs-adapter.test.ts` covers data/config, scatter coordinates, mixed datasets and type changes. Prior Chrome checks cover all seven types and canvas ownership; new independent-mount pixel comparisons pass (TV-CHARTJS-001). |
| API-006 registration/default | Implemented | `src/chart-fn.ts`; `chart-fn.test.ts` exercises registration, use/missing use, default replacement and explicit overrides (TV-REGISTER-001/TV-USE-001). |
| API-007 update/dispose | Implemented with vendor lifecycle qualification | Core wrapper preserves one public handle and idempotent dispose. `handle-lifecycle.test.ts` verifies no second adapter.mount call; adapter tests plus prior browser checks verify visible updates/removal. Carbon replaces its internal vendor chart on update; ECharts replaces its vendor renderer on theme changes. The README makes this explicit: “no new mount” applies to the public adapter/handle boundary, not an invariant that every vendor instance survives every update. |
| SPEC-001 passthrough | Implemented | Core checks only the top-level object/serialization size, not vendor option contents. Each adapter shallowly applies its documented key. `passthrough-determinism.test.ts`, Carbon mapping tests, and browser animation overrides execute TV-PASSTHROUGH-001. Native option semantics remain the caller/vendor contract. |
| DETERM-001 determinism | Implemented within tested environment | Core normalization/validation has no random/time source. Existing ECharts config equality test covers canonical mapping. New `scripts/determinism-acceptance.mjs` renders two independent mounts for each of 21 adapter/type combinations, disables animations, and compares decoded PNG RGBA channels. All match exactly on Chrome 154.0.8037.58, with no page errors. This is TV-DETERM-001 final-state evidence, not cross-browser/font/platform/version pixel identity. |
| API-008 optional image export | Implemented | ECharts and Carbon provide Promise<string> PNG/SVG exports; Chart.js/custom adapters may omit them. `toimage-adapter.test.ts` covers the optional interface; prior 149 browser assertions cover real dimensions, valid SVG, nonblank Carbon raster output and cleanup. Carbon exports plot/axes, excluding separate HTML title/legend/toolbar, as documented. No server-side chart rendering is claimed. |
| BIND-001 React | Implemented | `react/src/useChart.tsx`/`Chart.tsx` call core render, update in place and dispose on unmount/identity changes. Three React tests cover lifecycle and StrictMode; prior fresh packed browser consumers cover React 16.8.6/16.14.0/18.3.1/19.3.1 (TV-REACT-001). |
| BIND-002 Svelte | Implemented | `svelte/src/Chart.svelte` calls core render/update and disposes on destroy/identity changes. Three tests cover lifecycle and nested reactive mutation; prior packed Svelte 5.57.2 browser acceptance covers TV-SVELTE-001. |
| OBS-001 logging/privacy | Implemented for specified metadata boundary | `src/logger.ts` defaults production/browser logging to warnings and supports debug registration/render events. `observability.test.ts` now inspects serialized argument objects, rejects leakage through malformed type objects/strings, and confirms raw vendor error text is absent from mount envelopes. Invalid-spec warnings log only code/path. Registered adapter identifiers are allowed metadata; this is not an arbitrary application-log sanitizer. |
| COMPAT-001 versioning | Implemented/documented | README states ChartSpec v1 stability, required version field/deprecation for breaking changes, additive optional methods and SemVer. `src/types.ts` keeps toImage optional. Prior packed Node16/NodeNext declaration consumers and SSR imports establish the selected package artifacts, not every future compiler/runtime. |

## Original intent items I01–I18

| Intent | Accounted behavior |
| --- | --- |
| I01 unified API | API-001/002/004; one ChartSpec and factory. |
| I02 interface/adapters | API-003 and all three ADAPT requirements. |
| I03 switch/multiple backends | API-004/006 selection, registration and defaults. |
| I04 full chart-type scope | Seven types in types/validation and actual browser coverage; no bar/line-only subset. |
| I05 library-independent data | Canonical series/values/dimensions/labels; no mandatory datafn dependency. |
| I06 lifecycle/export contract | API-003/007/008; imperative error and vendor replacement qualifications above. |
| I07 escape hatch | SPEC-001 and documented adapter-specific keys. |
| I08 deterministic output | DETERM-001; finite actual same-browser comparisons. |
| I09 defined errors | API-005/VALID-001; unresolved broad-envelope versus imperative-handle wording explicitly retained. |
| I10 packaging | `chartfn` with adapter exports, `@chartfn/react`, `@chartfn/svelte`; manifests declare initFunction chartFn, namespace chartfn and schemaVersion 1. Prior packed import/type checks in `pr-destination.md`. |
| I11 environments | Browser rendering; core/framework import and SSR component markup evidence. Headless/server chart rendering is optional and not claimed. |
| I12 framework bindings | Both optional bindings delivered and tested, not silently deferred. |
| I13 three adapters | ECharts, Carbon and Chart.js delivered with actual vendor checks. |
| I14 no MVP subset | Every numbered requirement and all seven types accounted; qualifications remain visible. |
| I15 ecosystem alignment | Adapter interface and package metadata conventions; no data-storage abstraction duplicated because chart rendering has no storage responsibility. |
| I16 observability | OBS-001; invalid-input logging and mount-error privacy corrected. |
| I17 compatibility | COMPAT-001 documented policy and optional methods. |
| I18 limits | LIMIT-001 fixed caps; no broader OOM guarantee. |

## Current validation and remaining gates

Current changes are privacy-safe mount/validation diagnostics, sparse label validation, and actual determinism acceptance. This state passes 60 core tests, 3 React tests, 3 Svelte tests, core typecheck and ESM/CommonJS/declaration builds. Actual Chrome 154.0.8037.58 passes all 21 independent-mount comparisons with zero differing channels and zero page errors using ECharts 6.1.0, Chart.js 4.5.1 and Carbon 1.27.21. Prior full clean-install/149 vendor assertions/packed framework matrix remain explicitly historical evidence at `d08c44a47` rather than being recounted as new runs.

Reproduce from the repository root:

```sh
npm --prefix chartfn test
npm --prefix chartfn run typecheck
npm --prefix chartfn run build
npm --prefix chartfn/react test
npm --prefix chartfn/svelte test
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright BROWSER_EXECUTABLE_PATH=/absolute/path/to/chromium node chartfn/scripts/determinism-acceptance.mjs
```

The local driver came from an existing installation; all three product/vendor imports resolved from the ChartFn checkout. Browser contexts and the local server are closed on success/failure. The structured local browser receipt is `/tmp/chartfn-determinism-acceptance.json`.

### Follow-up: radial data and label fallback

Reusing linear-X options for Chart.js pie/donut charts previously converted
numeric values to Cartesian `{x,y}` objects despite omitting Cartesian scales.
Two new regressions fail on that implementation. Radial charts now retain
numeric data regardless of axis options; actual Chrome acceptance verifies the
parsed values and finite nonempty arcs after updating each radial type.
Carbon now uses the supplied labels when optional dimensions is an empty array,
matching the other adapters; unit assertions cover bar keys and pie groups.

After these changes all 63 core tests pass. The complete actual-vendor browser
script passes 153 assertions on Chrome 154.0.8037.58 with no page errors
(`/tmp/chartfn-radial-root-browser.log`), including the new radial cases.

The API-005 broad envelope statement requires contract alignment with the detailed imperative API; changing those method signatures would be a compatibility decision, not an unannounced fix. Current behavior and limits are prominent in the README. Vendor-specific theme capabilities, Carbon plot-only export, same-browser determinism and SSR-import-versus-chart-rendering boundaries are not hidden behind a blanket completion claim.

Hosted validation remains separate. The recorded JavaScript run 39141885349 failed from inherited ProbeFn dependency-cycle configuration, not these ChartFn changes; its snapshot is `/tmp/chartfn-hosted-failed.log`. The later account billing/job-start limitation also prevents claiming a current green hosted run. The separate ProbeFn fix does not by itself prove ChartFn CI has rerun successfully. No CI bypass, merge, publication or deployment is established by these local results.
