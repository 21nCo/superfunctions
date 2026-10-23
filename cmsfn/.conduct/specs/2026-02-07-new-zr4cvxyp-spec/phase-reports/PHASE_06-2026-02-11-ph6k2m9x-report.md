# PHASE_06 Completion Report: Workflow states + publish/unpublish UX (gated)

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_06  
**Date**: 2026-02-11  

## Summary

Implemented workflow metadata on drafts (`_cms`), deterministic publish/unpublish gating (role + workflow state), and studio UI for workflow state and publish/unpublish.

## Deliverables

### Server

- **`server/src/publish/gates.ts`** — `canPublish(state, hasDocPublishOverride)`, `canUnpublish()`. Publish allowed only for `approved`/`published`, or `in_review` when role has doc.publish; draft state never publishable.
- **`server/src/publish/contentfnClient.ts`** — Server-side ContentFn client: `getDraftDoc`, `contentfnPublish`, `contentfnUnpublish` (fetch to config.contentfn.baseUrl).
- **`server/src/http/publish.ts`** — Full `handlePublish` (validate body, authorize doc.publish, fetch draft, gate by state, call ContentFn publish) and `handleUnpublish` (authorize doc.unpublish, call ContentFn unpublish). Replaces use of stub in routes.
- **`server/src/index.ts`** — Publish route now uses `handlePublish` with `contentfnBaseUrl`; added POST `/cmsfn/unpublish` with `handleUnpublish`.
- **`server/src/__tests__/roles.test.ts`** — TV-ROLE-DENY-001 body updated to use `id` instead of `docId`.
- **`server/src/__tests__/publish.test.ts`** — New: TV-WF-PUBLISH-GATE-001 (draft state gate denies; in_review without doc.publish denies), unpublish permission denied.

### Studio

- **`studio/src/workflow/writeCmsMetadata.ts`** — `writeCmsMetadata(state, options?)` returns `CmsfnWorkflowMetadata` with workflow, state, updatedAt, optional assignees.
- **`studio/src/workflow/WorkflowControls.tsx`** — Buttons for draft / in_review / approved; on change patches doc with `_cms` via ContentFn patch; `data-workflow-controls`, `data-current-state`.
- **`studio/src/publish/cmsfnClient.ts`** — `publishDoc`, `unpublishDoc` calling POST `/cmsfn/publish` and `/cmsfn/unpublish`.
- **`studio/src/publish/PublishButton.tsx`** — Publish / Unpublish button; calls CmsFn server; `data-publish-button`, `data-unpublish-button`, `data-publish-error`.
- **`studio/src/panes/editor/DocumentEditorPane.tsx`** — Optional `cmsfnApiUrl`, `isPublished`; renders `WorkflowControls` and `PublishButton` when `cmsfnApiUrl` set; `data-draft-indicator` when state is draft.
- **`studio/src/panes/list/DocumentListPane.tsx`** — Optional `onOpenDoc(docId)`; list items can be buttons that open the editor.
- **`studio/src/app.tsx`** — `selectedDocId` state; when set, shows `DocumentEditorPane` with back button; list pane uses `onOpenDoc` to set `selectedDocId`; editor receives `config.cmsfn?.apiUrl`.

### Core

- **`core/src/desk/types.ts`** — Optional `cmsfn?: { apiUrl: string }` on `CmsfnStudioConfig` for studio → CmsFn server publish/unpublish.

### Tests

- **TV-WF-STATE-001** — `writeCmsMetadata("in_review")` shape; WorkflowControls patch includes `_cms.workflow` and `_cms.state="in_review"` (studio workflow.test.tsx).
- **TV-WF-PUBLISH-GATE-001** — Draft state + doc.publish → PERMISSION_DENIED (gate); in_review without doc.publish → PERMISSION_DENIED (server publish.test.ts).
- **TV-WORKFLOW-DRAFT-001** — DocumentEditorPane shows workflow controls and `data-draft-indicator` for draft (studio workflow.test.tsx).
- **TV-WORKFLOW-PUBLISH-001** — PublishButton click calls POST /cmsfn/publish with dataset and id (studio workflow.test.tsx).
- **TV-WORKFLOW-UNPUBLISH-001** — PublishButton (isPublished) click calls POST /cmsfn/unpublish (studio workflow.test.tsx).
- **TV-ROLE-DENY-001** — Already covered in server roles.test.ts (POST /cmsfn/publish with role denying doc.publish → PERMISSION_DENIED).

## Verification

- `cmsfn/server`: `npm run build` and `npm run test` — 13 tests (status, roles, publish).
- `cmsfn/studio`: `npm run build` and `npm run test` — 18 tests (list, studio, editor, workflow).
- `cmsfn/core`: `npm run build` — success.

## Deviations / notes

- `publishStub.ts` left in tree but no longer used by index; routes use full `handlePublish`/`handleUnpublish`.
- Studio editor is shown when a list doc is opened (onOpenDoc); `isPublished` is not derived (could be set by parent or future published-doc check).

## Stop condition

- Workflow states are stored deterministically in `_cms`; publish/unpublish are gated by role and workflow and tested.
