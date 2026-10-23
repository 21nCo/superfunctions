# Phase Completion Report — PHASE_02

## Metadata

- **exact timestamp**: 2026-02-09T07:47:24Z (UTC)
- **agent_name**: unknown-agent
- **model name/version**: unknown
- **launcher**: Cursor
- **workspace/project absolute path**: /Users/ar/dev/superfunctions/cifn
- **OS + shell**: darwin 25.0.0, zsh
- **repo metadata**: (branch/commit/dirty not captured in this run)

## Phase: PHASE_02

## Status: PASS

## Requirements summary

Requirements delivered: PIPE-002, PIPE-005, PIPE-011, PIPE-012, LIMIT-001

### PIPE-002
- **Status**: PASS
- **Acceptance criteria evidence**: Schema enforces `additionalProperties: false` at top level and job level; step is `oneOf` runStep | usesStep (no step that is neither run nor uses). Unknown top-level keys and unknown job-level keys fail schema validation with PIPELINE_INVALID. TV-PIPE-005 (unknown top-level key) and pipeline.test.ts "rejects pipeline with additional properties" pass.

### PIPE-005
- **Status**: PASS
- **Acceptance criteria evidence**: `on.schedule` accepts oneOf: object `{cron}` or array `[{cron}]` in schema. Parser exports `normalizeParsedPipeline()` which converts object to single-element array. Validator normalizes schedule in-place and validates cron expressions. Canonical PipelineSpec always has `on.schedule` as array. TV-PIPE-010 (schedule array accepted), TV-PIPE-011 (schedule object normalized to array), TV-PIPE-012 (invalid cron rejected with PIPELINE_INVALID) implemented and passing.

### PIPE-011
- **Status**: PASS
- **Acceptance criteria evidence**: Each `uses` action has a dedicated step schema with required keys and `additionalProperties: false`: checkout (with optional repository/ref/token), cache/restore and cache/save (key required; path/paths allowed), artifact/upload (name, path required; name maxLength 256), artifact/download (name required, maxLength 256), testfn/run (with optional framework/testPattern/reporter/outputPath), hostfn/deploy (environment required, ci optional). TV-PIPE-014 (unknown `with` key rejected), TV-PIPE-015 (missing required path for artifact/upload rejected) pass.

### PIPE-012
- **Status**: PASS
- **Acceptance criteria evidence**: Caps enforced at validation: jobs ≤ 100, steps/job ≤ 100, needs depth ≤ 10 (validator.ts); document size ≤ 500KB (parser.ts). All errors use code PIPELINE_INVALID. TV-LIMIT-001 (doc size), TV-LIMIT-002 (jobs/steps/depth) and TV-LIMIT-003 (artifact name 257, cache key 1025) covered; schema maxLength 256/1024 enforces artifact name and cache key caps.

### LIMIT-001
- **Status**: PASS
- **Acceptance criteria evidence**: Each cap has unit tests: TV-LIMIT-001 (500KB doc), TV-LIMIT-002 (101 jobs, 101 steps, depth 11), TV-LIMIT-003 (artifact name 257 chars, cache key 1025 chars). Cap violations return PIPELINE_INVALID. limits.test.ts TV-LIMIT-003 (GET /runs limit > 100 → BAD_REQUEST) and TV-LIMIT-004 (parse benchmark) remain passing.

## Test status

- **Control-plane** (`npm -w cifn/typescript/control-plane test`): 124 tests passed (5 files).
- **pipeline.test.ts**: TV-PIPE-010 (schedule array), TV-PIPE-011 (schedule object normalized), TV-PIPE-012 (invalid cron), TV-PIPE-014 (unknown with key), TV-PIPE-015 (missing required with), TV-LIMIT-003 (artifact name length, cache key length); all existing tests retained and passing.
- **limits.test.ts**: No changes required; TV-LIMIT-001/002/003/004 covered; all pass.

## Deliverables summary

### Files changed/added

- `cifn/schemas/pipeline.schema.json` — schedule oneOf object/array; step oneOf per action with strict `with` schemas and additionalProperties: false; artifact name maxLength 256, cache key maxLength 1024.
- `cifn/typescript/control-plane/src/pipeline/types.ts` — OnTriggers.schedule typed as `ScheduleTrigger[]`.
- `cifn/typescript/control-plane/src/pipeline/parser.ts` — `normalizeParsedPipeline()` added; converts on.schedule object to single-element array.
- `cifn/typescript/control-plane/src/pipeline/validator.ts` — `normalizeScheduleInPlace()`, `isValidCronExpression()`; cron semantic validation; schedule normalized after schema pass.
- `cifn/typescript/control-plane/src/pipeline/pipeline.test.ts` — parseAndValidate uses normalize; TV-PIPE-010/011/012/014/015 and TV-LIMIT-003 tests added; testfn/run and hostfn/deploy with shapes updated to framework, environment/ci.
- `cifn/typescript/control-plane/src/api/routes.ts` — normalizeParsedPipeline applied before validate for inline pipelineSpec and for parsed doc.
- `cifn/typescript/control-plane/src/triggers/webhook.ts` — normalizeParsedPipeline applied before validate after parse(doc).

### Files deleted

- None.

## Verification summary

- **Phase verification steps executed**: `npm -w cifn/typescript/control-plane test` — all tests pass.
- **Test execution results**: 124 tests passed (pipeline 38, triggers 23, queue 20, limits 6, api 37). Schedule object and array inputs yield identical canonical spec (array). Invalid `with` keys and missing required fields fail validation with PIPELINE_INVALID.

## Notes

- Canonical normalized schedule shape: `on.schedule` is always `Array<{ cron: string }>` (single-element when user provides object).
- Each action’s `with` schema: checkout (optional repository, ref, token); cache/restore and cache/save (key required, path or paths optional; key maxLength 1024); artifact/upload (name, path required; name maxLength 256); artifact/download (name required, path optional; name maxLength 256); testfn/run (optional framework, testPattern, reporter, outputPath); hostfn/deploy (environment required, ci optional). All have additionalProperties: false.
- Cron validation: 5-field format (minute hour day month day-of-week); invalid expressions (e.g. "not-a-cron") rejected with PIPELINE_INVALID.
- PHASE_02 is not the final phase (max phase is PHASE_10); tracker.csv not updated.

## Ready for next phase?

Yes. No blockers.

## Blockers

None.
