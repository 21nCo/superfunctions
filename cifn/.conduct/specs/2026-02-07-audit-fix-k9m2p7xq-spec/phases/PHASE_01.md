# Phase 01 — `pipelineRef` resolution + repo-backed run creation

## Phase goal (1 sentence)

Implement repo-backed run creation so that `POST /api/v1/runs` with `pipelineRef` fully works, including default config path fallback and deterministic failure modes.

## In scope

- Implement `pipelineRef` resolver (repo/ref/configPath → pipeline document string).
- Support default config path search order when configPath omitted.
- Update `POST /api/v1/runs` to accept:
  - `pipelineRef` (required for real webhook/cron usage)
  - `pipelineSpec` (still allowed for dev/test)
- Ensure webhook trigger code paths use `pipelineRef` (not inline pipelineSpec).

## Out of scope

- schedule normalization + schema changes (Phase 02).
- Expression evaluation and `if` runtime semantics (Phase 03).
- Runner-scoped auth (Phase 04).

## Deliverables (explicit list of files/modules)

- Create:
  - `cifn/typescript/control-plane/src/pipeline/resolver.ts`
- Modify:
  - `cifn/typescript/control-plane/src/api/routes.ts`
  - `cifn/typescript/control-plane/src/triggers/webhook.ts`
  - `cifn/typescript/control-plane/src/triggers/triggers.test.ts`
  - `cifn/typescript/control-plane/src/api/api.test.ts`

## Requirements covered

- PIPE-006
- API-002
- RUN-010
- INT-005 (webhook path: verified webhook → pipelineRef)

## Implementation tasks (ordered checklist)

- [ ] Create `pipeline/resolver.ts` with an interface like:
  - [ ] `resolvePipelineDoc(pipelineRef): Promise<{ doc: string, resolvedConfigPath: string }>`
  - [ ] Resolution strategy:
    - [ ] If configured to use git: clone repo@ref to temp dir, read configPath/default paths.
    - [ ] If configured to use plugfn: fetch file contents via provider API (optional in this phase if git is primary).
  - [ ] Deterministic configPath fallback order:
    - [ ] `.ci/pipeline.yml`, `.ci/pipeline.yaml`, `cifn.yml`, `cifn.yaml`
- [ ] Update `POST /runs` handler (`api/routes.ts`):
  - [ ] Accept either `pipelineRef` or `pipelineSpec`.
  - [ ] For pipelineRef: call resolver, then parse+validate.
  - [ ] For pipelineSpec: validate directly.
  - [ ] Error mapping:
    - [ ] missing both → 400 `BAD_REQUEST`
    - [ ] resolver failure (missing file, clone error) → 422 `RUN_CREATE_FAILED`
    - [ ] schema/semantic validation failure → 422 `PIPELINE_INVALID`
- [ ] Update webhook trigger (`triggers/webhook.ts`) to construct `pipelineRef` from payload (repo URL + ref) and call run creation using pipelineRef.
- [ ] Add/extend tests:
  - [ ] TV-API-001, TV-API-004, TV-API-005, TV-API-003
  - [ ] TV-INT-005 (webhook creates run via pipelineRef)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
- Expected:
  - All tests pass.
  - `POST /runs` supports pipelineRef and pipelineSpec.
  - Webhook path uses pipelineRef and works under test harness.

## Stop condition (what to report back before starting the next phase)

Report:

- The exact default configPath resolution order implemented.
- The exact error mapping behavior for resolver failures vs validation failures.
- Evidence (test output summary) that control-plane tests are green.

