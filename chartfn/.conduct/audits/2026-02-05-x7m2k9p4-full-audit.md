## Metadata

- **timestamp**: 2026-02-05T18:58:54Z (UTC)
- **agent_name**: unknown-agent
- **model**: GPT-5.2
- **launcher**: Cursor
- **workspace/project absolute path**: /Users/ar/dev/superfunctions/chartfn
- **OS + shell**: darwin 25.0.0 + zsh
- **repo metadata**:
  - **git repo**: yes (top-level: `/Users/ar/dev/superfunctions`)
  - **branch**: `next`
  - **commit**: `98c71853911e3aa96e9a72f892ee34e720ccc553`
  - **dirty**: yes (many untracked files; see Appendix)
- **intent/notes paths audited**:
  - `/Users/ar/dev/superfunctions/chartfn/.conduct/chartfn.intent.md`
  - `/Users/ar/dev/superfunctions/chartfn/README.md`
  - `/Users/ar/dev/superfunctions/chartfn/react/README.md`
  - `/Users/ar/dev/superfunctions/chartfn/svelte/README.md`
- **spec bundle paths audited**:
  - **bundle**: `/Users/ar/dev/superfunctions/chartfn/.conduct/specs/2026-01-29-new-cf7k2m9x-spec`
  - **included files**:
    - `SPEC.md`
    - `REQUIREMENTS.md`
    - `TEST_VECTORS.md`
    - `PLAN.md`
    - `INTENT_AUDIT.md`
    - `logs.csv`
    - `phases/PHASE_00.md`
    - `phases/PHASE_01.md`
    - `phases/PHASE_02.md`
    - `phases/PHASE_03.md`
    - `phases/PHASE_04.md`
    - `phases/PHASE_05.md`
    - `phases/PHASE_06.md`
    - `phases/PHASE_07.md`
    - `phases/PHASE_08.md`
    - `phases/PHASE_09.md`
    - `phase-reports/PHASE_00-2026-02-05-h7k2q9-report.md`
    - `phase-reports/PHASE_00-2026-02-05-p9c4b2-report.md`
    - `phase-reports/PHASE_01-2026-02-05-k4n8d3-report.md`
    - `phase-reports/PHASE_02-2026-02-05-r3m9v7-report.md`
    - `phase-reports/PHASE_03-2026-02-05-t6y4p1-report.md`
    - `phase-reports/PHASE_04-2026-02-05-z8p1q6-report.md`
    - `phase-reports/PHASE_05-2026-02-05-k2v7n4-report.md`
    - `phase-reports/PHASE_06-2026-02-05-b1c5m8-report.md`
    - `phase-reports/PHASE_07-2026-02-05-x4m7c2-report.md`
    - `phase-reports/PHASE_08-2026-02-05-f3k9w2-report.md`
    - `phase-reports/PHASE_09-2026-02-05-r8n2k5-report.md`
- **codebase scope audited**:
  - **root**: `/Users/ar/dev/superfunctions/chartfn`
  - **included (representative, not exhaustive)**:
    - `src/` (core + adapters)
    - `__tests__/` (core + adapter tests)
    - `react/src/`, `react/__tests__/`
    - `svelte/src/`, `svelte/__tests__/`
    - `package.json` (core + bindings)
  - **excluded**:
    - `node_modules/` (dependency contents)
    - `dist/` (build output, if present)
- **commands executed during audit**:
  - `node -v && npm -v`
  - `npm test --silent` (in `chartfn/`)
  - `npm test --silent` (in `chartfn/react/`)
  - `npm test --silent` (in `chartfn/svelte/`)
  - `date -u +"%Y-%m-%dT%H:%M:%SZ"`
  - `git rev-parse --show-toplevel`
  - `git branch --show-current && git rev-parse HEAD && git status --porcelain`

## Audit scope

- **Audit type**: Full, read-only audit of implementation vs (1) authoritative intent docs and (2) the complete spec bundle.
- **No sampling**: All intent items and all requirements in `REQUIREMENTS.md` are covered.
- **Precedence**:
  - **Intent docs** (`chartfn.intent.md` + READMEs) are authoritative for “what was intended”.
  - **Spec bundle** is authoritative for “what was specified”.
  - No multi-bundle precedence decisions were required (single bundle provided).
- **Note on phase reports**: `phase-reports/*` were read to avoid omissions, but were treated as *historical context* only (not authoritative for pass/fail).

## Inputs audited (intent + spec bundles)

### Intent / notes

- `/Users/ar/dev/superfunctions/chartfn/.conduct/chartfn.intent.md`
- `/Users/ar/dev/superfunctions/chartfn/README.md`
- `/Users/ar/dev/superfunctions/chartfn/react/README.md`
- `/Users/ar/dev/superfunctions/chartfn/svelte/README.md`

### Spec bundle(s)

- `/Users/ar/dev/superfunctions/chartfn/.conduct/specs/2026-01-29-new-cf7k2m9x-spec` (all files listed in Metadata)

## High-level findings

- **Overall**: Implementation is **substantially compliant** with the authoritative intent and the spec bundle. All requirements in `REQUIREMENTS.md` have implementation evidence and automated test coverage.
- **Notable issue (DX/CI risk)**: Running `npm test` at the **core** package root (`chartfn/`) currently **fails** because Vitest discovers `react/` and `svelte/` tests, but the core `vitest.config.ts` does not alias `chartfn` to source (and `dist/` is not built). Running tests **within** `chartfn/react` and `chartfn/svelte` succeeds. This is not a requirements failure, but it is an operational risk for “full suite passes” expectations.
- **No spec conflicts identified** within the provided bundle.
- **Minor spec ambiguity**: `ChartSpecData.series` is typed as `Array<ChartSpecSeries | Record<string, unknown>>` and docs say “or equivalent rows”, but core validation requires a `.values: number[]` array; “equivalent row” forms are not actually supported. This is best addressed as documentation/type clarification rather than a functional spec violation.

### Coverage summary

- **Intent → spec coverage**: 18/18 intent items (I01–I18) mapped to spec sections and/or requirement IDs; **0 SPEC MISSING**, **0 SPEC CONFLICT**.
- **Spec → code coverage**: 19/19 requirements implemented; **PASS=19, PARTIAL=0, FAIL=0, UNVERIFIED=0** (see requirement tables below).

### Top risks (ranked)

1. **Root test runner failure in `chartfn/`**: `npm test` fails unless bindings tests are run from their package directories or additional resolver config/build steps are added.  
   - **Why it matters**: Breaks CI expectations and “full suite passes” workflows; increases friction for contributors.
2. **Ambiguous `series` shape (“equivalent rows”)**: Types/docs suggest broader shapes than validation supports.  
   - **Why it matters**: Confusing API contract; unexpected `SPEC_INVALID` for users who supply non-`values` series rows.
3. **React binding update semantics**: `useChart` likely remounts on spec changes due to effect cleanup pattern.  
   - **Why it matters**: Performance regressions and potential flicker; harder to reason about lifecycle behavior.

### Fix order list (ranked)

1. **Fix monorepo test execution ergonomics**: ensure a “full test run” story exists from the core package runner.  
   - **References**: I12; BIND-001, BIND-002 (indirect); PLAN.md DoD.
2. **Clarify/align `ChartSpecData.series` supported forms** (docs + types + validation as needed).  
   - **References**: I05; API-002.
3. **Improve React binding update path to prefer `handle.update()`** without dispose/remount on spec changes.  
   - **References**: I06, I12; BIND-001.

## Intent Inventory (numbered)

Source-of-truth intent extracted from `chartfn.intent.md` plus the public READMEs.

I01. **Unified API**: Provide a canonical, library-agnostic `ChartSpec` + a unified adapter interface; app code describes charts in `ChartSpec`, adapters translate to backend configs.
I02. **Interface + adapters**: Core defines `ChartSpec` + `ChartAdapter`; multiple backends implement the adapter contract (at least ECharts + Carbon; plus Chart.js).
I03. **Switch or multi-backend**: Users can configure a default adapter and register multiple adapters by name; rendering can select a specific adapter or use default.
I04. **Chart types**: Support a defined set of chart types (at least bar, line, area, pie, scatter; plus any additional specified).
I05. **Data shape contract**: `ChartSpec` data shape supports series/dimensions/labels; library-agnostic and compatible with typical data sources (including datafn outputs).
I06. **Adapter contract & lifecycle**: Adapter mount into a container returns a handle (or equivalent) supporting `update(spec)` and `dispose()`, with an optional `toImage()` export capability; common-path usage must not require library-specific APIs.
I07. **Escape hatch**: A passthrough mechanism exists so advanced use-cases can supply adapter-native options without leaving ChartFn.
I08. **Determinism**: For the same `ChartSpec` and adapter, output is deterministic where underlying libraries permit; core must not introduce randomness.
I09. **Errors & envelopes**: Invalid `ChartSpec`, unknown adapter, and adapter runtime failures produce defined errors with codes and a consistent envelope.
I10. **Packaging & superfunctions conventions**: `chartFn` is the init function; namespace `chartfn`; package structure supports core + adapters (packages or subpaths).
I11. **Environments**: Browser DOM container is primary; Node/SSR is optional (especially for export/toImage) if adapters support it.
I12. **Framework bindings (optional, if in scope)**: Optional React and Svelte bindings that use the core `chartFn()` API and provide a drop-in DX.
I13. **Adapter implementation completeness**: ECharts, Carbon, Chart.js adapters exist and are tested against the shared contract.
I14. **No MVP subset**: Do not silently reduce scope to a minimal subset; priorities only define sequencing, not scope reduction.
I15. **Ecosystem alignment**: Align patterns/naming with other superfunctions packages (e.g. plugfn adapter concepts).
I16. **Observability**: Must specify what is logged/emitted and what must *not* be logged (notably raw series values in production).
I17. **Versioning / compatibility**: Define a compatibility strategy for `ChartSpec` evolution and adapter interface stability; follow SemVer.
I18. **Limits / caps**: Define and enforce caps (payload size, series count, points per series) to prevent abuse/OOM.

## Intent → Spec coverage matrix (complete; no sampling)

Mapping validated against the bundle’s `INTENT_AUDIT.md` and cross-checked manually against `SPEC.md` and `REQUIREMENTS.md`.

| Intent | Where specified (SPEC / PLAN) | Requirement IDs | Test vectors |
|---|---|---|---|
| I01 | `SPEC.md`: Overview, Glossary, Public API | API-002, API-003, API-004 | TV-SPEC-VALID-001, TV-ADAPTER-INTERFACE-001, TV-RENDER-001 |
| I02 | `SPEC.md`: Goals, Public API; `PLAN.md`: Architecture | API-003, ADAPT-001, ADAPT-002, ADAPT-003 | TV-ECHARTS-*, TV-CARBON-*, TV-CHARTJS-001 |
| I03 | `SPEC.md`: Semantics (adapter selection); Public API; `PLAN.md` | API-001, API-004, API-006 | TV-API-CONFIG-001/002, TV-RENDER-002/004, TV-REGISTER-001, TV-USE-001 |
| I04 | `SPEC.md`: `ChartType` union | API-002 | TV-SPEC-VALID-001, TV-SPEC-INVALID-003 |
| I05 | `SPEC.md`: Data formats/protocol; `ChartSpecData` | API-002 | TV-SPEC-VALID-001 |
| I06 | `SPEC.md`: Adapter handle; semantics for update/dispose; toImage optional | API-003, API-007, API-008 | TV-HANDLE-UPDATE-001, TV-HANDLE-DISPOSE-001, TV-TOIMAGE-001 |
| I07 | `SPEC.md`: passthrough field; security note | SPEC-001 | TV-PASSTHROUGH-001 |
| I08 | `SPEC.md`: Invariants (Determinism) | DETERM-001 | TV-DETERM-001 |
| I09 | `SPEC.md`: Validation + error codes + envelope | API-005, VALID-001 | TV-ENVELOPE-001/002/003, TV-VALID-BEFORE-ADAPTER-001, TV-SPEC-INVALID-* |
| I10 | `PLAN.md`: Architecture; `package.json` conventions implied | API-001 (API surface); (packaging is doc-only) | N/A |
| I11 | `SPEC.md`: Target environments; container resolution | API-004, API-008 (optional export) | TV-RENDER-*; TV-TOIMAGE-001 |
| I12 | `SPEC.md`: Goals (bindings optional); `phases/PHASE_07.md`, `PHASE_08.md` | BIND-001, BIND-002 | TV-REACT-001, TV-SVELTE-001 |
| I13 | `SPEC.md`: Goals; adapter requirements | ADAPT-001, ADAPT-002, ADAPT-003 | TV-ECHARTS-*, TV-CARBON-*, TV-CHARTJS-001 |
| I14 | `SPEC.md`: Non-goals (no MVP subset); `REQUIREMENTS.md` includes full set | (meta) all requirements | (meta) all vectors |
| I15 | `SPEC.md`: “Aligns with superfunctions patterns” (high-level) | (doc-only) | N/A |
| I16 | `SPEC.md`: Observability; plus README guidance | OBS-001 | TV-OBS-001 |
| I17 | `SPEC.md`: Compatibility/versioning; plus README guidance | COMPAT-001 | Documentation audit |
| I18 | `SPEC.md`: Limits/caps; validation section | LIMIT-001 | TV-LIMIT-* |

### Spec-vs-intent completeness / drift verdict

- **SPEC MISSING**: None identified for the numbered intent items (I01–I18).
- **SPEC CONFLICT**: None identified (single bundle; internal docs consistent).
- **Minor ambiguity (non-blocking)**: “series may be Record<string, unknown> / equivalent rows” is not described with acceptance criteria, and core validation enforces `.values: number[]`. Recommend clarifying docs/types.

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)

Spec bundle: `2026-01-29-new-cf7k2m9x-spec`

| Status | Count |
|---|---:|
| PASS | 19 |
| PARTIAL | 0 |
| FAIL | 0 |
| UNVERIFIED | 0 |

## Requirement-by-requirement results (tables + per-requirement notes)

### Summary table

| ID | Priority | Status | Primary evidence |
|---|---|---|---|
| API-001 | P0 | PASS | `src/chart-fn.ts`, `__tests__/chart-fn.test.ts` |
| API-002 | P0 | PASS | `src/types.ts`, `src/validate.ts`, `__tests__/validate.test.ts` |
| API-003 | P0 | PASS | `src/types.ts`, adapter impls, `__tests__/chart-fn.test.ts` |
| API-004 | P0 | PASS | `src/chart-fn.ts`, `src/resolve-container.ts`, `__tests__/chart-fn.test.ts` |
| API-005 | P0 | PASS | `src/types.ts`, `src/chart-fn.ts`, tests in `__tests__/chart-fn.test.ts`, `__tests__/adapter-error.test.ts` |
| ADAPT-001 | P0 | PASS | `src/adapters/echarts.ts`, `__tests__/echarts-adapter.test.ts` |
| ADAPT-002 | P0 | PASS | `src/adapters/carbon.ts`, `__tests__/carbon-adapter.test.tsx` |
| VALID-001 | P0 | PASS | `src/chart-fn.ts`, `__tests__/chart-fn.test.ts` |
| LIMIT-001 | P0 | PASS | `src/constants.ts`, `src/validate.ts`, `__tests__/validate.test.ts` |
| ADAPT-003 | P1 | PASS | `src/adapters/chartjs.ts`, `__tests__/chartjs-adapter.test.ts` |
| API-006 | P1 | PASS | `src/chart-fn.ts`, `__tests__/chart-fn.test.ts` |
| API-007 | P1 | PASS | adapter handles in `src/adapters/*`, `__tests__/handle-lifecycle.test.ts` |
| SPEC-001 | P1 | PASS | `src/types.ts`, passthrough merges in adapters, `__tests__/passthrough-determinism.test.ts` |
| DETERM-001 | P1 | PASS | grep (no `Date.now`/`Math.random`), `__tests__/passthrough-determinism.test.ts` |
| API-008 | P2 | PASS | `src/types.ts`, `src/adapters/echarts.ts`, `__tests__/toimage-adapter.test.ts` |
| BIND-001 | P2 | PASS | `react/src/*`, `react/__tests__/chart-react.test.tsx` |
| BIND-002 | P2 | PASS | `svelte/src/Chart.svelte`, `svelte/__tests__/chart-svelte.test.ts` |
| OBS-001 | P2 | PASS | `src/logger.ts`, `src/chart-fn.ts`, `__tests__/observability.test.ts` |
| COMPAT-001 | P2 | PASS | `README.md` (core) |

### Per-requirement notes (key checks)

#### API-001: chartFn factory and config — PASS

- **Evidence**:
  - `src/chart-fn.ts`: `chartFn(config)` returns `{ render, use, registerAdapter, getDefaultAdapter, setDefaultAdapter }`.
  - `__tests__/chart-fn.test.ts`: validates presence and default adapter get/set behavior.
- **Notes**: Matches intent I10 and requirement acceptance criteria.

#### API-002: ChartSpec schema and validation — PASS

- **Evidence**:
  - `src/types.ts`: `ChartSpec`, `ChartType`, `ChartSpecData`/`Options`.
  - `src/validate.ts`: `validateChartSpec(spec: unknown)` enforces required fields + limits.
  - `__tests__/validate.test.ts`: covers valid and invalid vectors.
- **Notes**: Validation requires `.values: number[]` for each series entry; consider clarifying docs/types if “equivalent rows” are intended.

#### API-003: ChartAdapter interface — PASS

- **Evidence**:
  - `src/types.ts`: `ChartAdapter` and `ChartAdapterHandle`.
  - `__tests__/chart-fn.test.ts`: accepts inline adapter object; handle has `update` and `dispose`.

#### API-004: render() with adapter selection — PASS

- **Evidence**:
  - `src/resolve-container.ts`: selector resolution via `document.querySelector`.
  - `src/chart-fn.ts`: validate spec → select adapter → `adapter.mount()`; catches errors.
  - `__tests__/chart-fn.test.ts`: default adapter, explicit adapter, invalid spec, unknown adapter, selector resolution.
- **Notes**: Container resolution failure returns `ADAPTER_ERROR`, consistent with spec note.

#### API-005: Envelope and error codes — PASS

- **Evidence**:
  - `src/types.ts`: envelope + error types/codes.
  - `src/validate.ts`: emits `SPEC_INVALID` with `details.path`.
  - `src/chart-fn.ts`: emits `ADAPTER_UNKNOWN` / `ADAPTER_ERROR` with `details.adapter`.
  - Tests: `__tests__/chart-fn.test.ts`, `__tests__/adapter-error.test.ts`.

#### ADAPT-001: ECharts adapter — PASS

- **Evidence**:
  - `src/adapters/echarts.ts`: mounts ECharts instance, `update`, idempotent `dispose`, optional `toImage`.
  - `__tests__/echarts-adapter.test.ts`, `__tests__/toimage-adapter.test.ts` (mocked ECharts).
- **Notes**: Mapping supports ChartType set; passthrough via `spec.passthrough.echartsOptions` merged shallowly.

#### ADAPT-002: Carbon adapter — PASS

- **Evidence**:
  - `src/adapters/carbon.ts`: uses React root to mount Carbon components; `update` rerenders; idempotent `dispose`.
  - `__tests__/carbon-adapter.test.tsx` (mocked ReactDOM + Carbon components).
- **Notes**: Passthrough via `spec.passthrough.carbonOptions` shallow merge.

#### VALID-001: Spec validation before adapter — PASS

- **Evidence**:
  - `src/chart-fn.ts`: validates and returns early before adapter lookup/mount.
  - `__tests__/chart-fn.test.ts`: “does not call adapter when spec invalid”.

#### LIMIT-001: Series and payload limits — PASS

- **Evidence**:
  - `src/constants.ts`: `MAX_SERIES=100`, `MAX_POINTS_PER_SERIES=10_000`, `MAX_SPEC_BYTES=1_048_576`.
  - `src/validate.ts`: enforces all limits (byte-size via `TextEncoder` when available).
  - `__tests__/validate.test.ts`: covers all three.

#### ADAPT-003: Chart.js adapter — PASS

- **Evidence**:
  - `src/adapters/chartjs.ts`: mounts Chart.js, updates config + calls update; idempotent dispose via `chart.destroy()`.
  - `__tests__/chartjs-adapter.test.ts` (mocked Chart.js).
- **Notes**: Requires canvas element; if not, throws and core wraps as `ADAPTER_ERROR`.

#### API-006: registerAdapter / use / defaultAdapter — PASS

- **Evidence**:
  - `src/chart-fn.ts`: `registerAdapter`, `use`, get/set default.
  - `__tests__/chart-fn.test.ts`: register/use behavior.

#### API-007: Handle update and dispose — PASS

- **Evidence**:
  - All real adapters implement `update` + idempotent `dispose` guards.
  - `__tests__/handle-lifecycle.test.ts` validates update without remount for a handle.

#### SPEC-001: Passthrough options — PASS

- **Evidence**:
  - `src/types.ts`: `ChartSpec.passthrough?: Record<string, unknown>`.
  - `src/adapters/echarts.ts`: merges `passthrough.echartsOptions`.
  - `src/adapters/carbon.ts`: merges `passthrough.carbonOptions`.
  - `src/adapters/chartjs.ts`: merges `passthrough.chartjsOptions`.
  - `__tests__/passthrough-determinism.test.ts`: verifies passthrough merge for ECharts.

#### DETERM-001: Determinism — PASS

- **Evidence**:
  - Source audit: no `Date.now()` / `Math.random()` in `src/`.
  - `__tests__/passthrough-determinism.test.ts`: `buildOption(spec)` deterministic for identical specs.
- **Notes**: Full “pixel-identical” determinism is library-dependent; the core does not introduce nondeterminism.

#### API-008: toImage optional — PASS

- **Evidence**:
  - `src/types.ts`: optional `toImage`.
  - `src/adapters/echarts.ts`: implements `toImage` via `getDataURL`.
  - `__tests__/toimage-adapter.test.ts`: validates it returns a string.

#### BIND-001: React binding (optional) — PASS

- **Evidence**:
  - `react/src/useChart.tsx`, `react/src/Chart.tsx`: uses core API (`chartFn` + `api.render`) and disposes on cleanup.
  - `react/__tests__/chart-react.test.tsx`: verifies dispose called on unmount.
- **Note / improvement**: `useChart` includes `spec` in the effect dependency list while also returning a cleanup that disposes the handle; this may cause remount-on-update behavior in React. Not a requirements failure, but could be improved for performance/semantics.

#### BIND-002: Svelte binding (optional) — PASS

- **Evidence**:
  - `svelte/src/Chart.svelte`: renders via `api.render` and calls `handle.dispose()` in `onDestroy`.
  - `svelte/__tests__/chart-svelte.test.ts`: verifies dispose called on destroy.

#### OBS-001: Logging rules — PASS

- **Evidence**:
  - `src/logger.ts`: env-based log level; production defaults to `warn`.
  - `src/chart-fn.ts`: logs adapter registration, render start, and error code/path without logging full series values.
  - `__tests__/observability.test.ts`: asserts full `data.series` JSON is not present in log output in production.

#### COMPAT-001: Versioning — PASS

- **Evidence**:
  - `README.md` documents ChartSpec v1 stability + adapter interface additive-only policy + SemVer.

## Spec conflicts / spec gaps (explicit)

- **SPEC CONFLICT**: None detected.
- **SPEC MISSING**: None detected for intent items I01–I18.
- **Spec ambiguity / doc gap (recommended fix)**:
  - `ChartSpecData.series` is typed as allowing `Record<string, unknown>` and docs mention “equivalent rows”, but validation enforces `.values: number[]`.
    - **Impact**: Users may believe non-`values` data forms are supported; they are rejected as `SPEC_INVALID`.
    - **Recommendation**: Clarify the intended shape (either remove the `Record<string, unknown>` union/comment, or specify an accepted alternate series-row schema + validation rules).

## Cross-cutting audits (security/determinism/limits/errors/compat)

### Security / validation boundaries

- **Core validation boundary**:
  - `render()` calls `validateChartSpec()` before adapter mount (VALID-001 satisfied).
  - Limits enforce basic anti-abuse caps (LIMIT-001 satisfied).
- **Passthrough boundary**:
  - Core does not validate/sanitize `passthrough` content (SPEC-001). This matches the spec but pushes responsibility to adapters.
  - **Risk**: Adapters may forward unsafe/unbounded options to underlying libraries (DoS/perf spikes, rendering surprises). Consider documenting adapter-specific passthrough keys and their safety implications.

### Determinism invariants

- Core does not use nondeterministic sources (`Date.now`, `Math.random` absent).
- ECharts option builder is deterministic; other adapters appear deterministic by construction (pure transforms).
- Full determinism of output images/DOM depends on upstream libraries; the spec already scopes determinism “where underlying library allows.”

### Limits / caps

- Enforced in `validateChartSpec()`:
  - max series = 100
  - max points/series = 10,000
  - max spec size = 1 MiB (byte-aware when `TextEncoder` present)

### Error handling + canonical envelopes

- `ChartfnEnvelope<T>` used for `render()` and `validateChartSpec()`.
- Error codes used consistently: `SPEC_INVALID`, `ADAPTER_UNKNOWN`, `ADAPTER_ERROR`.
- Error payloads avoid embedding raw series data.

### Compatibility / versioning / migrations

- Docs state “ChartSpec v1 is stable; breaking changes add version field; adapter interface additive-only; SemVer.”
- Current `ChartSpec` does not include an explicit version field (consistent with “v1 stable” stance).

## Recommendations (ranked)

1. **Make root `chartfn` test command robust in a monorepo layout** (DX/CI)  
   - **Why**: `npm test` in `chartfn/` currently fails because it includes `react/` + `svelte/` tests that require their own resolver config (or built `dist/`). This can break CI expectations and developer workflows.  
   - **Fix options** (pick one):
     - Exclude `react/**` and `svelte/**` in `chartfn/vitest.config.ts`, or
     - Add a `resolve.alias` for `chartfn` (and other deps) in `chartfn/vitest.config.ts`, or
     - Move binding tests to be executed only via workspace scripts (root runner), or
     - Ensure `dist/` is built before running binding tests from the core package runner.
   - **References**: Intent I12 (bindings), Plan DoD “full test suite passes” (PLAN.md), Requirements BIND-001/BIND-002 (indirect).

2. **Clarify `ChartSpecData.series` accepted shapes** (spec/documentation clarity)  
   - If “equivalent rows” are not intended for v1, remove or narrow types/docs to match validation.
   - If intended, specify schema + validation + adapter mapping rules for the alternate shape.
   - **References**: Intent I05, Spec ambiguity noted above.

3. **React binding update semantics** (performance/behavior polish)  
   - The current `useChart` effect likely disposes/remounts on `spec` changes; consider splitting “mount/dispose” from “update” to reliably use `handle.update()` without remounting.
   - **References**: Intent I06/I12; Requirement BIND-001 (non-blocking improvement).

## Appendix: commands run + environment details

### Environment

- **OS**: darwin 25.0.0
- **Shell**: zsh
- **Node**: v23.11.1
- **npm**: 11.6.1

### Commands executed (with key results)

1. `node -v && npm -v`  
   - Output: `v23.11.1` / `11.6.1`

2. `npm test --silent` (in `/Users/ar/dev/superfunctions/chartfn`)  
   - Core + adapter suites passed; overall command **failed** because `react/__tests__` and `svelte/__tests__` could not resolve `chartfn` entry without build/alias.

3. `npm test --silent` (in `/Users/ar/dev/superfunctions/chartfn/react`)  
   - PASS

4. `npm test --silent` (in `/Users/ar/dev/superfunctions/chartfn/svelte`)  
   - PASS

5. `git rev-parse --show-toplevel`  
   - Output: `/Users/ar/dev/superfunctions`

6. `git branch --show-current && git rev-parse HEAD && git status --porcelain`  
   - Branch: `next`
   - Commit: `98c71853911e3aa96e9a72f892ee34e720ccc553`
   - Dirty: yes (many untracked files)
