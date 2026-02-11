# Phase 00: Pipeline schema and validation

## Phase goal
Deliver a JSON Schema for pipeline config, a parser (YAML/JSON), and a validator so that valid pipelines produce a PipelineSpec and invalid ones fail with PIPELINE_INVALID.

## In scope
- JSON Schema for pipeline: name, on (push, pull_request, schedule, workflow_dispatch), env, jobs (runs-on, needs, if, env, steps).
- Step types: run, uses (checkout, cache/restore, cache/save, artifact/upload, artifact/download, testfn/run, hostfn/deploy) with allowed `with` shape.
- Parser: YAML and JSON input → in-memory object.
- Validator: schema validation + semantic checks (cyclic needs, unknown uses, limits: jobs ≤ 100, steps ≤ 100, needs depth ≤ 10, doc size ≤ 500 KB).
- Output: PipelineSpec (typed structure) or validation error with code PIPELINE_INVALID.

## Out of scope
- Control plane API, runners, flowfn, filefn, secfn, logfn, expressions evaluation at runtime.

## Deliverables
- `cifn/schemas/pipeline.schema.json` (full schema).
- `cifn/typescript/control-plane/src/pipeline/parser.ts` (parse YAML/JSON).
- `cifn/typescript/control-plane/src/pipeline/validator.ts` (schema + semantic).
- `cifn/typescript/control-plane/src/pipeline/types.ts` (PipelineSpec, Run, Job, Step types).
- Unit tests for parser and validator (golden valid/invalid pipelines).

## Requirements covered
- PIPE-001, PIPE-002, PIPE-003, PIPE-004, PIPE-007, PIPE-008, PIPE-010, SEC-003, LIMIT-001 (validation part).

## Implementation tasks
1. Create `cifn/schemas` and `cifn/typescript/control-plane/src/pipeline`.
2. Define TypeScript types: PipelineSpec, OnTrigger, JobSpec, StepSpec (run | uses + with).
3. Write `pipeline.schema.json` with all top-level and nested keys; add `oneOf` or enum for step types and uses.
4. Implement `parse(input: string, format: 'yaml' | 'json'): unknown`; handle YAML via js-yaml or equivalent.
5. Implement `validate(obj: unknown): { ok: true, spec: PipelineSpec } | { ok: false, code: 'PIPELINE_INVALID', message: string, details?: object }`.
6. In validator: run JSON Schema validate; then check cyclic needs (graph cycle), needs depth ≤ 10, jobs count ≤ 100, steps per job ≤ 100; reject unknown `uses`.
7. Add tests: TV-PIPE-001, TV-PIPE-002, TV-PIPE-003, TV-PIPE-004, TV-PIPE-005, TV-PIPE-006, TV-PIPE-007, TV-LIMIT-001, TV-LIMIT-002 (and TV-RUN-003 for cyclic needs).

## Verification steps
- Run: `cd cifn/typescript/control-plane && npm test` (or `npx vitest run`). All pipeline parser/validator tests pass.
- Run: `node -e "const v = require('./dist/pipeline/validator'); const r = v.validate(validPipeline); console.log(r.ok && r.spec.jobs.build)"` → truthy for valid pipeline.
- Run: `node -e "const v = require('./dist/pipeline/validator'); const r = v.validate(invalidPipeline); console.log(!r.ok && r.code === 'PIPELINE_INVALID')"` → true for invalid pipeline.

## Stop condition
- Schema file exists and validates against sample pipelines; parser and validator in place; test vectors TV-PIPE-001 through TV-PIPE-007 and TV-LIMIT-001, TV-LIMIT-002, TV-RUN-003 pass. Report: "Phase 00 complete; pipeline schema and validation ready for Phase 01."
