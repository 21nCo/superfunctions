# ChartFn Intent Audit

## Purpose

Exhaustive audit mapping every intent item from chartfn.intent.md to SPEC.md sections, REQUIREMENTS.md IDs, and TEST_VECTORS.md vectors. Ensures full scope coverage.

---

## Intent inventory (from chartfn.intent.md)

| # | Intent summary |
|---|----------------|
| I01 | Unified API: ChartSpec + ChartAdapter; app code describes in ChartSpec, adapters translate |
| I02 | Interface + Adapters: Core defines ChartSpec and ChartAdapter; ECharts, Carbon, Chart.js adapters |
| I03 | Switch or use multiple: defaultAdapter + register multiple; per-render adapter override; same app can use Carbon and ECharts |
| I04 | Chart types: Defined set (bar, line, area, pie, scatter, etc.) via ChartSpec; adapters map to library |
| I05 | Data shape: series, dimensions, labels; library-agnostic; compatible with datafn etc. |
| I06 | Adapter contract: mount(container, spec) → handle; update(spec); optional toImage(); no app code using library APIs for common path |
| I07 | Escape hatch: ChartSpec MAY include passthrough (e.g. echartsOptions) per adapter |
| I08 | Determinism: Same ChartSpec + same adapter → deterministic output where library allows |
| I09 | Errors: Invalid spec → defined error; unknown adapter → defined error; adapter runtime errors → envelope |
| I10 | Packaging: initFunction chartFn, namespace chartfn; core + adapter packages or subpaths |
| I11 | Environments: Browser primary; optional Node/SSR for toImage |
| I12 | Framework bindings optional: React and/or Svelte; use core chartFn(); phased delivery allowed but specified |
| I13 | Adapters to implement: ECharts, Carbon, Chart.js; each fully tested |
| I14 | No MVP subset: Full scope; priorities for sequencing only |
| I15 | Integration with superfunctions: Align with plugfn/datafn patterns |
| I16 | Observability: What MUST be logged and what MUST NOT (e.g. raw data) specified |
| I17 | Versioning: ChartSpec version and adapter stability; compatibility strategy stated |
| I18 | Limits: Max payload, max series, caps defined |

---

## Intent → Spec coverage

| Intent | SPEC.md section | Requirement IDs | Test vectors |
|--------|-----------------|-----------------|--------------|
| I01 | Overview, Public API, ChartSpec / ChartAdapter | API-002, API-003, API-004 | TV-SPEC-VALID-001, TV-ADAPTER-INTERFACE-001, TV-RENDER-001 |
| I02 | Public API, Data formats | API-003, ADAPT-001, ADAPT-002, ADAPT-003 | TV-ADAPTER-INTERFACE-001, TV-ECHARTS-*, TV-CARBON-*, TV-CHARTJS-001 |
| I03 | Public API (render options.adapter, registerAdapter, defaultAdapter) | API-001, API-004, API-006 | TV-API-CONFIG-001/002, TV-RENDER-001/002/004, TV-REGISTER-001, TV-USE-001 |
| I04 | Public API (ChartType), Glossary | API-002 | TV-SPEC-VALID-001, TV-SPEC-INVALID-003 |
| I05 | Public API (ChartSpecData: series, dimensions?, labels?) | API-002 | TV-SPEC-VALID-001 |
| I06 | Public API (ChartAdapter, ChartAdapterHandle: mount, update, dispose; toImage optional) | API-003, API-007, API-008 | TV-ADAPTER-INTERFACE-001, TV-HANDLE-UPDATE-001, TV-HANDLE-DISPOSE-001, TV-TOIMAGE-001 |
| I07 | Public API (ChartSpec.passthrough), Semantics | SPEC-001 | TV-PASSTHROUGH-001 |
| I08 | Invariants (Determinism) | DETERM-001 | TV-DETERM-001 |
| I09 | Public API (ChartfnError, envelope), Validation | API-005, VALID-001 | TV-ENVELOPE-001/002/003, TV-SPEC-INVALID-*, TV-RENDER-003/004, TV-VALID-BEFORE-ADAPTER-001 |
| I10 | Overview, Non-goals; package structure in PLAN | API-001, packaging in PLAN.md | N/A (docs/structure) |
| I11 | Overview (Target environments), Semantics | All render/adapter requirements | All render vectors; toImage in API-008 |
| I12 | Goals, Undefined (framework bindings optional) | BIND-001, BIND-002 | TV-REACT-001, TV-SVELTE-001 |
| I13 | Goals, Public API (adapters) | ADAPT-001, ADAPT-002, ADAPT-003 | TV-ECHARTS-*, TV-CARBON-*, TV-CHARTJS-001 |
| I14 | Non-goals (no MVP), REQUIREMENTS (all in scope) | All requirements; priorities P0/P1/P2 for sequencing | All vectors |
| I15 | Overview (Existing systems), Glossary | Same patterns as plugfn/datafn (Adapter interface) | N/A (design alignment) |
| I16 | Observability (SPEC.md), Limits | OBS-001 | TV-OBS-001 |
| I17 | Compatibility / versioning (SPEC.md) | COMPAT-001 | Documentation audit |
| I18 | Limits / caps (SPEC.md) | LIMIT-001 | TV-LIMIT-SERIES-001, TV-LIMIT-POINTS-001, TV-LIMIT-SIZE-001 |

---

## Missing intent items

**No missing intent items.** Every numbered intent (I01–I18) is covered by at least one SPEC.md section, one or more requirement IDs, and (where applicable) test vectors. Framework bindings (I12) are in scope with requirements BIND-001, BIND-002 and phases 07–08; observability (I16) and versioning (I17) are in SPEC and requirements OBS-001, COMPAT-001 with phase 09.

---

## Verification

- Intent inventory: 18 items extracted from chartfn.intent.md.
- Each item mapped to: SPEC section, requirement IDs, test vectors (or N/A for structural/docs).
- All requirements in REQUIREMENTS.md trace to at least one intent item.
- All test vectors in TEST_VECTORS.md trace to at least one requirement and intent.
- INTENT_AUDIT states: **No missing intent items.**
