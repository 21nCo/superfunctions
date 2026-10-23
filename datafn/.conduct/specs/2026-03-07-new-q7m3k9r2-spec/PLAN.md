# PLAN

## Architecture sketch

```text
@datafn/core
  - types.ts            -> relation capability schema types
  - capabilities.ts     -> relation capability field defs/helpers (new or extended)
  - schema.ts           -> relation capability validation + collision checks

@datafn/cli
  - drizzle-codegen.ts  -> join-table capability columns
  - codegen.ts          -> join-table interface emission for capability-only relations
  - tests               -> snapshot/behavior coverage

@datafn/server
  - execution/mutation/relations.ts -> relate/modifyRelation strip+inject semantics
  - execution/mutation/execute.ts   -> shared strip/inject helper reuse (if centralized)
  - execution/sync/push.ts          -> push parity
  - execution/sync/{pull,clone}.ts  -> output parity verification
  - tests                           -> relation runtime + sync parity

@datafn/docs + examples
  - docs: relation capability reference + migration notes
  - example schema/codegen output updates
```

## Dependency graph

```text
Phase 00 (schema/API contract)
  -> Phase 01 (core helpers + validation wiring)
    -> Phase 02 (CLI codegen + type generation)
      -> Phase 03 (server mutation execution)
        -> Phase 04 (sync/change-tracking parity)
          -> Phase 05 (docs/examples)
            -> Phase 06 (full regression + readiness report)
```

## Phases overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| 00 | Lock relation capability contract | `relations[].capabilities` type + validation/error contract | Core unit tests for schema validation and deterministic resolution |
| 01 | Implement core relation capability helpers | Capability field defs + collision checks + exported helper API | `@datafn/core` tests |
| 02 | Persisted shape parity in codegen | Join-table capability columns + typed interfaces | CLI snapshot tests + TypeScript compile checks |
| 03 | Runtime mutation parity | relate/modifyRelation strip+inject behavior | Server mutation relation tests |
| 04 | Sync parity | push/pull/clone/change-tracking includes capability fields | Server sync tests |
| 05 | Consumer clarity | docs and example schema updates | docs build + example generated artifacts check |
| 06 | System-level confidence | cross-package regression and compatibility checks | targeted vitest suites + smoke commands |

## Definition of Done (global)
No phase is complete unless:
1. All requirements mapped to that phase have passing verification steps.
2. New/updated tests from that phase pass locally.
3. Existing relevant regression suites continue passing.
4. Any generated artifacts are deterministic across two consecutive runs.
5. Phase report includes concrete evidence (commands + pass/fail outcome).
