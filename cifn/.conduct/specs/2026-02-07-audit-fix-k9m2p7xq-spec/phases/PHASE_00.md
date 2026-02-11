# Phase 00 — Contract alignment (envelopes, codes, dashboard runId)

## Phase goal (1 sentence)

Align the control-plane API and dashboard/clients to a single, precise v1 contract: **JSON envelope everywhere**, **canonical error code set**, and **run identifier is `runId`**.

## In scope

- Make every control-plane endpoint return the canonical JSON envelope (including runner heartbeat).
- Resolve error-code drift by enforcing the canonical error code set (including `UNAUTHORIZED`).
- Fix dashboard API contract mismatch (`run.id` vs `runId`) and ensure navigation works.
- Update/extend tests to lock the contract.

## Out of scope

- Implementing `pipelineRef` fetching (Phase 01).
- Implementing expression/`if` runtime semantics (Phase 03).
- Runner-scoped auth (Phase 04).
- Real flowfn/filefn/secfn/logfn production adapters (Phase 06).

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/typescript/control-plane/src/api/envelope.ts`
  - `cifn/typescript/control-plane/src/api/auth.ts`
  - `cifn/typescript/control-plane/src/api/routes.ts`
  - `cifn/typescript/control-plane/src/api/api.test.ts`
  - `cifn/typescript/dashboard/src/api.ts`
  - `cifn/typescript/dashboard/src/pages/RunList.tsx`
  - `cifn/typescript/dashboard/src/pages/RunDetail.tsx`
  - `cifn/typescript/dashboard/src/pages/LogsView.tsx`
  - `cifn/typescript/dashboard/src/pages/ArtifactsList.tsx`
  - `cifn/typescript/dashboard/src/api.test.ts`

## Requirements covered

- API-001
- API-009
- API-011
- DASH-001

## Implementation tasks (ordered checklist)

- [ ] Update `envelope.ts` to:
  - [ ] Define the canonical error-code union exactly as in `SPEC.md`.
  - [ ] Ensure all helpers produce `{ok:true,data}` or `{ok:false,error}`.
- [ ] Update `auth.ts` to return `UNAUTHORIZED` for missing/invalid API auth.
- [ ] Update `routes.ts` runner heartbeat:
  - [ ] Replace any 204/no-body behavior with `200` + `{ ok:true, data:{ job:null } }` when no job.
  - [ ] Ensure error responses use canonical codes only.
- [ ] Update/extend API tests (`api.test.ts`) to include:
  - [ ] TV-API-006 (success envelope)
  - [ ] TV-API-007 (error envelope + code set)
  - [ ] TV-RUNNER-006 (heartbeat returns job:null envelope)
- [ ] Update dashboard API client (`dashboard/src/api.ts`):
  - [ ] Use `runId` as the identifier end-to-end.
  - [ ] Remove/avoid any reliance on `id`.
- [ ] Update dashboard pages to route/navigate by `runId`.
- [ ] Add/adjust dashboard tests to cover TV-DASH-001 at least at the API-client contract level (and basic render sanity).

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
  - `npm -w cifn/typescript/dashboard test`
- Expected:
  - All tests pass.
  - API heartbeat no-job response is a JSON envelope with `job:null`.
  - Dashboard unit tests validate `runId` usage.

## Stop condition (what to report back before starting the next phase)

Report:

- The final canonical error-code set as implemented.
- Example heartbeat no-job JSON response.
- Evidence (test output summary) that control-plane and dashboard tests are green.

