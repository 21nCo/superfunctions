# CompFn Implementation Plan

## Architecture sketch

- **compfn (core)**: Types (Control, Framework, Evidence, Check, Readiness, AuditorPack, CompfnError, CompfnEnvelope), CompFnConfig, compFn(config) → CompFnAPI. Storage layer using @superfunctions/db adapter (namespace compfn). No direct dependency on authfn/secfn; adapters are injected.
- **Storage**: Tables/collections: controls, frameworks, evidence, checks (check_definitions). Evidence and controls are key entities; frameworks reference controls; checks reference controlId and adapter/config.
- **Adapters**: Separate modules or packages per superfunction (secfn, authfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn). Each implements EvidenceAdapter (name, runCheck({ checkId, controlId, method?, customConfig? }) → AdapterEvidence). Core invokes adapters when running checks; adapter output is persisted via evidence.create().
- **Optional server**: HTTP router (e.g. Express/Hono) mounting routes for controls, frameworks, evidence, checks, readiness, export; same envelope contract. Optional; can be in same package or @compfn/server.
- **Optional CLI**: Commands init, run-checks, export, attest; calls core API or HTTP. Optional; package @compfn/cli or compfn-cli.
- **Bundles**: Data files (JSON/TS) defining one or more frameworks with requirements and optionally control definitions; loadable via API or import.

## Dependency graph

- Phase 00 (types + storage schema) has no dependency on other compfn phases.
- Phase 01 (controls CRUD) depends on Phase 00.
- Phase 02 (frameworks CRUD + validation) depends on Phase 01 (control IDs must exist).
- Phase 03 (evidence) depends on Phase 01 (controlId validation).
- Phase 04 (checks create/run) depends on Phase 03 (store evidence); uses adapter interface from Phase 07 for run.
- Phase 05 (readiness) depends on Phase 02 and Phase 03 (frameworks, evidence).
- Phase 06 (export) depends on Phase 02 and Phase 03.
- Phase 07 (adapters interface + secfn + authfn) can start after Phase 00 (interface only); implementation of run(check) that calls adapter depends on Phase 04.
- Phase 08 (framework bundle) depends on Phase 02 (frameworks.create); data only.
- Phase 09 (observability, limits, compat) depends on Phase 03, 04, 06; cross-cutting.
- Phase 10 (HTTP) depends on Phase 01–06.
- Phase 11 (CLI) depends on Phase 01–06 and optionally 10.
- Phase 12 (provider docs) depends on Phase 05.

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|-------|------|----------------------|--------------|
| 00 | Types and storage schema | CompfnError, CompfnEnvelope, Control, Framework, Evidence, CheckDefinition, EvidenceAdapter types; DB schema (controls, frameworks, evidence, checks) | Unit tests for types; schema migration or create runs |
| 01 | Controls CRUD | controls.create, get, list, update, delete; validation | TV-CTRL-* |
| 02 | Frameworks CRUD and validation | frameworks.create, get, list, update, delete; requirement controlIds must exist | TV-FW-* |
| 03 | Evidence create and list | evidence.create (with controlId/type/outcome/payload/size), get, list; immutability (no update/delete) | TV-EVID-* |
| 04 | Checks create and run | checks.create, get, list, run, delete; run creates evidence; mock adapter | TV-CHECK-* |
| 05 | Readiness | readiness.forControl, forFramework; deterministic status | TV-READY-* |
| 06 | Export | export.auditorPack({ frameworkId?, since? }); size cap | TV-EXPORT-* |
| 07 | Adapters | EvidenceAdapter interface; secfn adapter; authfn adapter; plug into run() | TV-ADAPT-* |
| 08 | Framework bundle | At least one framework bundle (SOC 2 or ISO 27001); loadable | TV-BUNDLE-001 |
| 09 | Observability and limits | Logging rules; payload/export caps; schema versioning doc | TV-OBS-001, TV-LIMIT-*, COMPAT-001 |
| 10 | Optional HTTP API | Routes for controls, frameworks, evidence, checks, readiness, export; envelope responses | TV-HTTP-001 |
| 11 | Optional CLI | init, run-checks, export, attest | TV-CLI-* |
| 12 | Provider and compatibility | Document provider usage (productFn/flowfn); final INTENT_AUDIT | TV-PROVIDER-001, INTENT_AUDIT |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase are implemented.
2. All verification steps (tests or manual steps) for that phase pass.
3. No regressions in previous phases (full test suite passes).
4. Phase report (if required) is written in the spec folder.
