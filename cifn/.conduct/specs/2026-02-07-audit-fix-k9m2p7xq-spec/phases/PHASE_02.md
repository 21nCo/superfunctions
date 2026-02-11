# Phase 02 — Pipeline schema hardening (schedule + `with` shapes + caps)

## Phase goal (1 sentence)

Update pipeline schema + validator to match intent and close validation/security gaps: schedule normalization, strict `with` shapes per action, and all caps enforced.

## In scope

- Accept + normalize `on.schedule` object/array into canonical array form.
- Enforce step-type-specific `with` shapes and reject unknown `with` keys.
- Enforce caps at parse/validation time (size/count/depth/expression length, artifact/cache key length).

## Out of scope

- Runtime evaluation of `if` and `${{ }}` (Phase 03).
- Runner auth changes (Phase 04).

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/schemas/pipeline.schema.json`
  - `cifn/typescript/control-plane/src/pipeline/parser.ts`
  - `cifn/typescript/control-plane/src/pipeline/validator.ts`
  - `cifn/typescript/control-plane/src/pipeline/pipeline.test.ts`
  - `cifn/typescript/control-plane/src/limits/limits.test.ts`

## Requirements covered

- PIPE-002
- PIPE-005
- PIPE-011
- PIPE-012
- LIMIT-001

## Implementation tasks (ordered checklist)

- [ ] Update `schemas/pipeline.schema.json`:
  - [ ] `on.schedule` accepts `oneOf`: object `{cron}` or array `[{cron}]`.
  - [ ] Each `uses` action has a `with` schema with:
    - [ ] required keys
    - [ ] `additionalProperties: false`
  - [ ] Enforce artifact name length ≤ 256 and cache key length ≤ 1024 (schema or semantic).
- [ ] Update `pipeline/parser.ts` to normalize schedule:
  - [ ] If schedule is object, convert to single-element array.
  - [ ] Canonical PipelineSpec always uses array form.
- [ ] Update `pipeline/validator.ts`:
  - [ ] Apply semantic validation for cron correctness if JSON Schema is insufficient.
  - [ ] Apply caps enforcement (jobs/steps/depth/doc size) and ensure error is `PIPELINE_INVALID`.
- [ ] Extend tests:
  - [ ] TV-PIPE-010/011 (schedule accepted + normalized)
  - [ ] TV-PIPE-012 (invalid cron rejected)
  - [ ] TV-PIPE-014/015 (unknown `with` key, missing required fields rejected)
  - [ ] TV-LIMIT-001/002/003 (caps)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
- Expected:
  - All tests pass.
  - schedule object and array inputs yield identical canonical spec.
  - Invalid `with` keys fail validation pre-execution.

## Stop condition (what to report back before starting the next phase)

Report:

- The canonical normalized schedule shape.
- A short summary of each action’s `with` schema (required keys + rejected extras).
- Evidence that all control-plane tests are green.

