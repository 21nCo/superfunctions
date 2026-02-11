# PHASE_06: Workflow states + publish/unpublish UX (gated)

## Phase goal

Implement workflow metadata on drafts and gate publishing/unpublishing based on workflow state and role permissions.

## In scope

- Workflow state UI:
  - set state to `draft`, `in_review`, `approved`
  - store `_cms` metadata in draft documents deterministically
- Publish/unpublish UI actions:
  - call ContentFn publish/unpublish
  - enforce role permissions (`doc.publish`, `doc.unpublish`)
  - enforce workflow gating rules

## Out of scope

- Releases (PHASE_10)

## Deliverables

- `cmsfn/studio/src/workflow/WorkflowControls.tsx`
- `cmsfn/studio/src/workflow/writeCmsMetadata.ts`
- `cmsfn/studio/src/publish/PublishButton.tsx`
- `cmsfn/server/src/publish/gates.ts` (deterministic gate rules)
- Tests implementing:
  - TV-WF-STATE-001
  - TV-WF-PUBLISH-GATE-001
  - TV-WORKFLOW-DRAFT-001
  - TV-WORKFLOW-PUBLISH-001
  - TV-WORKFLOW-UNPUBLISH-001
  - TV-ROLE-DENY-001

## Requirements covered

- DOC-003
- WF-001
- ROLE-001 (publish permissions)

## Implementation tasks

1. Define workflow rules deterministically (config-driven).
2. Store workflow metadata under reserved `_cms` object in draft documents using ContentFn patch.
3. Implement publish action:
   - check role allows `doc.publish`
   - check workflow state is allowed (e.g., approved)
   - call ContentFn publish
4. Implement unpublish similarly with permission checks.
5. Add tests for:
   - gating denies publish when in_review without override
   - role deny blocks publish deterministically

## Verification steps

- Run workflow tests and confirm `_cms` metadata shape and publish gating.

## Stop condition

- Workflow states are stored deterministically and publish/unpublish are correctly gated and tested.

