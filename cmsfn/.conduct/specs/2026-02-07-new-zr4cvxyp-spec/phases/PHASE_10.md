# PHASE_10: Releases (batch publish + scheduling)

## Phase goal

Implement releases as named batches of draft documents with deterministic publish behavior, including optional scheduling.

## In scope

- Server endpoints:
  - `POST /cmsfn/releases/create`
  - `POST /cmsfn/releases/list`
  - `POST /cmsfn/releases/add`
  - `POST /cmsfn/releases/publish`
- Release storage model and deterministic ordering
- Publish orchestration calling ContentFn publish per doc:
  - enforce permissions and workflow gates
  - return deterministic summary of successes/failures

## Out of scope

- Complex transactional semantics across multiple docs (documented best-effort is acceptable but must be deterministic)

## Deliverables

- `cmsfn/server/src/http/releases.ts`
- `cmsfn/server/src/storage/releases.ts`
- `cmsfn/server/src/releases/publishRelease.ts`
- Studio UI minimal pane:
  - `cmsfn/studio/src/panes/releases/ReleasesPane.tsx`
- Tests implementing:
  - TV-REL-CREATE-001
  - TV-REL-ADD-001
  - TV-REL-PUBLISH-001
  - TV-REL-PUBLISH-002

## Requirements covered

- REL-001
- WF-001 (publish gating)
- ROLE-001 (release.manage + doc.publish)

## Implementation tasks

1. Implement release CRUD storage and deterministic ordering (createdAt desc, releaseId asc).
2. Implement create/list/add endpoints with validation.
3. Implement publish:
   - evaluate workflow gate per doc
   - publish sequentially in deterministic order (sorted docIds)
   - collect failures deterministically
4. Add tests for successful and failing publish cases.

## Verification steps

- Run release tests.
- Confirm publish result ordering is stable.

## Stop condition

- Releases work end-to-end and publish results are deterministic.

