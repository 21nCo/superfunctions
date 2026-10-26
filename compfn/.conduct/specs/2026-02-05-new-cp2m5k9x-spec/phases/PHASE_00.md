# PHASE_00: Types and storage schema

## Phase goal

Implement core types (CompfnError, CompfnEnvelope, Control, Framework, Evidence, CheckDefinition, EvidenceAdapter, AuditorPack, etc.) and storage schema for controls, frameworks, evidence, and checks using @superfunctions/db adapter pattern. No CRUD or business logic yet.

## In scope

- CompfnErrorCode, CompfnError, CompfnEnvelope<T>
- Control, CreateControlInput, UpdateControlInput
- Framework, FrameworkRequirement, CreateFrameworkInput
- Evidence, EvidenceType, CreateEvidenceInput
- CheckDefinition, RunCheckResult
- ControlReadiness, FrameworkReadiness, ReadinessStatus
- AuditorPack
- CompFnConfig, CompFnAPI interface (method signatures only)
- EvidenceAdapter interface
- DB schema: compfn_controls, compfn_frameworks, compfn_evidence, compfn_checks (or equivalent for adapter)
- Constants: default evidencePayloadMaxBytes (524288), exportMaxBytes (50 MiB), max requirements per framework (1000), max controlIds per requirement (100)

## Out of scope

- compFn() implementation, CRUD implementations, checks.run, readiness computation, export logic, adapters

## Deliverables

- `src/types.ts` (or split: errors.ts, control.ts, framework.ts, evidence.ts, check.ts, readiness.ts, export.ts)
- `src/constants.ts` – limit constants
- `src/storage/schema.ts` or migration – table definitions for controls, frameworks, evidence, checks
- `src/storage/adapter.ts` or use @superfunctions/db adapter directly with schema
- Unit test that instantiates schema / runs migration (no business logic tests yet)

## Requirements covered

- API-002 (error and envelope types), part of LIMIT-001 (constants), part of API-001 (types for config and API surface)

## Implementation tasks

1. Create package scaffold (package.json, tsconfig) if not present.
2. Define CompfnErrorCode and CompfnError in types.
3. Define CompfnEnvelope<T> in types.
4. Define Control, CreateControlInput, UpdateControlInput.
5. Define Framework, FrameworkRequirement, CreateFrameworkInput.
6. Define EvidenceType, Evidence, CreateEvidenceInput.
7. Define CheckDefinition, RunCheckResult.
8. Define ControlReadiness, FrameworkReadiness, ReadinessStatus.
9. Define AuditorPack.
10. Define CompFnConfig, EvidenceAdapter, and CompFnAPI interface (all method signatures returning Promise<CompfnEnvelope<...>>).
11. Define constants: EVIDENCE_PAYLOAD_MAX_BYTES_DEFAULT = 524288, EXPORT_MAX_BYTES_DEFAULT = 50 * 1024 * 1024, MAX_REQUIREMENTS_PER_FRAMEWORK = 1000, MAX_CONTROL_IDS_PER_REQUIREMENT = 100.
12. Define storage schema (tables: controls, frameworks, evidence, checks) with columns matching types; namespace compfn.
13. Add test or script that creates/migrates schema (e.g. drizzle schema or raw SQL) and exits successfully.

## Verification steps

- Run `npm run build` (or tsc); no type errors.
- Run schema migration or create; no errors.
- Types exportable; CompFnAPI interface compiles.

## Stop condition

- All types and schema exist; build succeeds; schema can be created. No missing intent items for types/schema.
