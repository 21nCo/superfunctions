# CmsFn Requirements

## Table of Contents

### P0 (Core Studio + security)

- STUDIO-001: Studio boots with deterministic desk structure
- STUDIO-002: Dataset selection and scoping
- SCHEMA-001: Schema-driven editor rendering
- SCHEMA-002: Client-side pre-validation + server authoritative validation
- DOC-001: Document list panes query via ContentFn CFQL deterministically
- DOC-002: Document editor saves via ContentFn patch with concurrency handling
- DOC-003: Draft/published workflow UX and operations
- PREVIEW-001: Preview integration with token minting and live updates
- MEDIA-001: Media library upload/browse/insert asset refs
- REF-001: Reference picker UX with deterministic search/browse
- WF-001: Workflow states and publish gating
- REL-001: Releases (create/add/list/publish) with deterministic behavior
- ROLE-001: Roles model and server-side permission enforcement
- AUDIT-001: Audit/events viewer (ContentFn events + webhook delivery status)
- OPS-001: Import/export triggers with dataset isolation
- STATUS-001: CmsFn status endpoint and ContentFn capability checks
- OBS-001: Observability and log redaction rules
- LIMIT-001: Limits enforcement for uploads, richtext, releases
- ENV-001: Canonical envelope and error codes

### P1 (Ergonomics + extensibility)

- PLUG-001: Field widget extension interface
- DESK-001: Desk custom panes (history, diff, webhook viewer)
- COLLAB-001: Multi-session live update behavior via realtime feed

---

## P0 Requirements

### STUDIO-001: Studio boots with deterministic desk structure

**Priority**: P0  
**Statement**: The Studio MUST render the desk structure defined by `CmsfnStudioConfig.desk` deterministically (same config → same rendered navigation tree).  
**Rationale**: Editors depend on stable navigation and predictable document access.  
**Acceptance criteria**:
- Given a fixed config, the desk tree renders identically across sessions.
- Group ordering equals config ordering.
- Singleton nodes always open the configured dataset/type/id document.
**Test vectors**: TV-STUDIO-BOOT-001, TV-DESK-STRUCT-001, TV-DESK-STRUCT-002  
**Notes**: “Deterministic” includes stable keys/IDs for nodes derived from config.

---

### STUDIO-002: Dataset selection and scoping

**Priority**: P0  
**Statement**: The Studio MUST scope all operations by the selected dataset and MUST prevent cross-dataset reads/writes.  
**Rationale**: Dataset isolation is required for prod/staging separation and multi-tenant usage.  
**Acceptance criteria**:
- Switching dataset changes list/editor queries to use that dataset only.
- Attempting to open a document from another dataset fails with a permission or not-found envelope, not cross-reading content.
**Test vectors**: TV-DATASET-SCOPE-001, TV-DATASET-SCOPE-002  
**Notes**: Cross-dataset operations may be enabled only via explicit admin tooling; otherwise denied.

---

### SCHEMA-001: Schema-driven editor rendering

**Priority**: P0  
**Statement**: The Studio MUST render document editors from the ContentFn schema for the document’s `_type` and MUST map ContentFn field types to widgets deterministically.  
**Rationale**: Schema-driven rendering is the core of a Sanity-like Studio.  
**Acceptance criteria**:
- For each ContentFn field type (primitive/object/array/reference/richtext/asset), the editor renders a widget.
- Required fields are visually indicated.
- Reference and asset widgets show canonical reference shapes.
**Test vectors**: TV-EDITOR-RENDER-001, TV-EDITOR-RENDER-002  
**Notes**: Custom widgets are covered by PLUG-001 (P1).

---

### SCHEMA-002: Client-side pre-validation + server authoritative validation

**Priority**: P0  
**Statement**: The Studio SHOULD run client-side pre-validation for UX, but server-side validation (ContentFn) MUST be treated as authoritative and MUST surface deterministic errors in the UI.  
**Rationale**: Prevent invalid writes while keeping server as source of truth.  
**Acceptance criteria**:
- Invalid required fields show a local validation state before saving.
- If ContentFn rejects with `VALIDATION_FAILED`, Studio shows the error with field path mapping.
**Test vectors**: TV-EDITOR-VALIDATE-001, TV-EDITOR-VALIDATE-002  
**Notes**: The mapping from ContentFn `details.path` to UI fields must be deterministic.

---

### DOC-001: Document list panes query via ContentFn CFQL deterministically

**Priority**: P0  
**Statement**: Document list panes MUST query ContentFn via CFQL and MUST respect deterministic ordering and pagination rules.  
**Rationale**: Lists must be stable and consistent with the backend.  
**Acceptance criteria**:
- Lists use CFQL with explicit `orderBy` or rely on ContentFn defaults.
- Pagination uses opaque cursors; Studio never parses cursors.
**Test vectors**: TV-LIST-QUERY-001, TV-LIST-PAGINATION-001, TV-LIST-QUERY-002  
**Notes**: List projections should be minimal (title/updatedAt/etc.) for performance.

---

### DOC-002: Document editor saves via ContentFn patch with concurrency handling

**Priority**: P0  
**Statement**: The Studio MUST save edits using ContentFn patch operations and MUST handle `REV_CONFLICT` deterministically.  
**Rationale**: Efficient saves and correct conflict handling are essential for multi-user editing.  
**Acceptance criteria**:
- Saving performs `docs.patch` with `ifRev` from the last loaded document.
- On `REV_CONFLICT`, Studio shows a conflict UI that offers refresh and deterministic re-apply when possible.
**Test vectors**: TV-EDITOR-SAVE-001, TV-EDITOR-CONFLICT-001  
**Notes**: “Deterministic re-apply” means the same local changes are re-applied in the same order when replay is chosen.

---

### DOC-003: Draft/published workflow UX and operations

**Priority**: P0  
**Statement**: The Studio MUST support draft editing and publishing/unpublishing via ContentFn and MUST clearly indicate which perspective is being edited/viewed.  
**Rationale**: Editorial workflows depend on clear draft vs published states.  
**Acceptance criteria**:
- Editor shows draft state; publish action publishes the corresponding document id.
- Unpublish removes published representation but keeps draft.
- Preview links reflect the draft perspective by default.
**Test vectors**: TV-WORKFLOW-DRAFT-001, TV-WORKFLOW-PUBLISH-001, TV-WORKFLOW-UNPUBLISH-001, TV-WF-PUBLISH-GATE-001  
**Notes**: Scheduled publishing is covered by REL-001 and WF-001 gating.

---

### PREVIEW-001: Preview integration with token minting and live updates

**Priority**: P0  
**Statement**: When preview is enabled, the Studio MUST support live preview of draft content using ContentFn realtime events and MUST mint short-lived preview tokens via the CmsFn server.  
**Rationale**: Live preview is a hallmark of Sanity-like experiences.  
**Acceptance criteria**:
- Studio can request a preview token and open a preview URL for a doc.
- Draft edits cause preview to update (via realtime events).
- Missing preview config returns `PREVIEW_NOT_CONFIGURED`.
**Test vectors**: TV-PREVIEW-TOKEN-001, TV-PREVIEW-LIVE-001, TV-PREVIEW-DISABLED-001  
**Notes**: Token format is implementation-defined but must be unforgeable.

---

### MEDIA-001: Media library upload/browse/insert asset refs

**Priority**: P0  
**Statement**: The Studio MUST provide a media library that uploads and browses ContentFn assets and inserts canonical asset references into documents.  
**Rationale**: Asset management is core CMS functionality.  
**Acceptance criteria**:
- Upload uses ContentFn assets API and enforces upload size limits.
- Browse lists assets deterministically (order documented).
- Insert creates `{ "_type":"asset", "_ref":"<id>", "assetType":"image|file" }`.
**Test vectors**: TV-MEDIA-UPLOAD-001, TV-MEDIA-BROWSE-001, TV-MEDIA-INSERT-001, TV-LIMIT-UPLOAD-001  
**Notes**: Image transforms are undefined unless configured.

---

### REF-001: Reference picker UX with deterministic search/browse

**Priority**: P0  
**Statement**: Reference fields MUST be editable via a reference picker that queries ContentFn deterministically and shows bounded previews of candidate documents.  
**Rationale**: References are essential for content graphs.  
**Acceptance criteria**:
- Picker lists candidates by type and filter.
- Picker uses deterministic ordering and pagination.
- Selecting creates a canonical reference object.
**Test vectors**: TV-REF-PICKER-001, TV-REF-PICKER-002  
**Notes**: The `match` operator support depends on ContentFn SEARCH-001.

---

### WF-001: Workflow states and publish gating

**Priority**: P0  
**Statement**: CmsFn MUST enforce workflow state gating on publishing and MUST store workflow state deterministically in draft documents under reserved `_cms` metadata.  
**Rationale**: Review/approval workflows are expected in editorial tooling.  
**Acceptance criteria**:
- Draft has `_cms.workflow` and `_cms.state`.
- Publish action is denied with `PERMISSION_DENIED` or `CONFLICT` when workflow state disallows it for the role.
**Test vectors**: TV-WF-STATE-001, TV-WF-PUBLISH-GATE-001  
**Notes**: Workflow definitions are deterministic config artifacts.

---

### REL-001: Releases (create/add/list/publish) with deterministic behavior

**Priority**: P0  
**Statement**: CmsFn MUST support releases that group draft changes and publish them deterministically, including optional scheduled publish time.  
**Rationale**: Coordinated publishes are common CMS needs.  
**Acceptance criteria**:
- Create/list/add works and persists release metadata.
- Publishing a release attempts to publish all included docs and returns a deterministic summary of successes/failures.
- Release publish respects workflow gating and role permissions.
**Test vectors**: TV-REL-CREATE-001, TV-REL-ADD-001, TV-REL-PUBLISH-001, TV-REL-PUBLISH-002  
**Notes**: Atomicity constraints must be documented; behavior must be deterministic under partial failure.

---

### ROLE-001: Roles model and server-side permission enforcement

**Priority**: P0  
**Statement**: CmsFn MUST provide role CRUD and MUST enforce permissions server-side for all privileged actions.  
**Rationale**: UI-only permission checks are insufficient; enforcement is required.  
**Acceptance criteria**:
- Roles list/upsert/delete functions under authorization.
- Denied actions return `PERMISSION_DENIED` without leaking content.
**Test vectors**: TV-ROLE-UPSERT-001, TV-ROLE-DENY-001, TV-ROLE-LIST-001  
**Notes**: Integration with `authfn` identity is deployment-defined; roles operate on subjects.

---

### AUDIT-001: Audit/events viewer (ContentFn events + webhook delivery status)

**Priority**: P0  
**Statement**: CmsFn MUST provide an audit surface that allows authorized users to view ContentFn events and webhook delivery status without exposing raw document bodies.  
**Rationale**: Operators need insight into publishing and integrations.  
**Acceptance criteria**:
- Audit events endpoint returns event metadata (type, id, timestamp, doc id) only.
- Webhook audit returns delivery attempts and statuses.
- Unauthorized access is denied.
**Test vectors**: TV-AUDIT-EVENTS-001, TV-AUDIT-WEBHOOKS-001, TV-AUDIT-DENY-001  
**Notes**: ContentFn must store event/webhook queue metadata.

---

### OPS-001: Import/export triggers with dataset isolation

**Priority**: P0  
**Statement**: CmsFn MUST allow authorized users to trigger ContentFn dataset export/import and MUST preserve dataset isolation.  
**Rationale**: Editors/operators need operational controls for backups and migrations.  
**Acceptance criteria**:
- Export returns an artifact or a job handle deterministically.
- Import rejects malformed artifacts.
- Cross-dataset import attempts are denied or fail deterministically.
**Test vectors**: TV-OPS-EXPORT-001, TV-OPS-IMPORT-001, TV-OPS-IMPORT-002  
**Notes**: Large imports may be async; if async, job semantics must be deterministic.

---

### STATUS-001: CmsFn status endpoint and ContentFn capability checks

**Priority**: P0  
**Statement**: CmsFn MUST expose `/cmsfn/status` and MUST check required ContentFn capabilities at startup and per-request where necessary, failing with `CONTENTFN_UNAVAILABLE` when missing.  
**Rationale**: CmsFn depends on ContentFn features; failures must be explicit.  
**Acceptance criteria**:
- Status returns configured datasets and capability summary.
- When ContentFn is unreachable, CmsFn returns `CONTENTFN_UNAVAILABLE`.
**Test vectors**: TV-STATUS-001, TV-STATUS-002, TV-STATUS-CONTENTFN-DOWN-001  
**Notes**: Capability requirements include schema/docs/assets and realtime when preview is enabled.

---

### OBS-001: Observability and log redaction rules

**Priority**: P0  
**Statement**: CmsFn MUST log key operations but MUST NOT log raw document bodies, raw asset bytes, or auth secrets by default.  
**Rationale**: Prevent leaking sensitive data while enabling operations.  
**Acceptance criteria**:
- Logs contain action/dataset/subject metadata.
- Logs do not contain document field content or asset bytes.
**Test vectors**: TV-OBS-001, TV-OBS-002  
**Notes**: Structured logging format is implementation-defined.

---

### LIMIT-001: Limits enforcement for uploads, richtext, releases

**Priority**: P0  
**Statement**: CmsFn MUST enforce configured limits and return deterministic limit error codes.  
**Rationale**: Prevent abuse and maintain predictable performance.  
**Acceptance criteria**:
- Oversized uploads are rejected with `PAYLOAD_TOO_LARGE`.
- Richtext exceeding block limits is rejected with `VALIDATION_FAILED`.
- Releases exceeding max size are rejected deterministically.
**Test vectors**: TV-MEDIA-UPLOAD-001, TV-EDITOR-SAVE-001, TV-REL-CREATE-001, TV-LIMIT-UPLOAD-001, TV-LIMIT-RICHTEXT-001, TV-LIMIT-RELEASE-001  
**Notes**: ContentFn may also enforce limits; CmsFn must pre-check and surface UX errors.

---

### ENV-001: Canonical envelope and error codes

**Priority**: P0  
**Statement**: All CmsFn server endpoints MUST use the canonical envelope and error codes defined in `SPEC.md`.  
**Rationale**: Consistent error handling and testing.  
**Acceptance criteria**:
- All endpoints return `{ ok:true,result }` on success and `{ ok:false,error }` on failure.
- Errors include `code`, `message`, and `details` with `path` when relevant.
**Test vectors**: TV-ENV-OK-001, TV-ENV-ERR-001  
**Notes**: UI-only operations without server endpoints are exempt.

---

## P1 Requirements

### PLUG-001: Field widget extension interface

**Priority**: P1  
**Statement**: CmsFn SHOULD provide a deterministic extension interface for registering custom field widgets for schema fields.  
**Rationale**: Schema-driven CMSs require extensibility.  
**Acceptance criteria**:
- Developers can register a widget for `(typeName, fieldName)` or field type.
- Widget registration order conflicts resolve deterministically.
**Test vectors**: TV-PLUG-001, TV-PLUG-002  
**Notes**: Extension system must not allow arbitrary code execution in server context unless explicitly enabled.

---

### DESK-001: Desk custom panes (history, diff, webhook viewer)

**Priority**: P1  
**Statement**: CmsFn SHOULD support additional deterministic panes including history and webhook/audit views.  
**Rationale**: Operational transparency is important.  
**Acceptance criteria**:
- History pane reads ContentFn history and renders revisions list deterministically.
- Webhook pane shows delivery attempts deterministically.
**Test vectors**: TV-DESK-PANES-001, TV-DESK-PANES-002  
**Notes**: Diff UI is optional unless explicitly required; if included, it must be deterministic.

---

### COLLAB-001: Multi-session live update behavior via realtime feed

**Priority**: P1  
**Statement**: CmsFn SHOULD update lists and open editors in response to realtime events to reflect remote changes deterministically.  
**Rationale**: Editors expect near-real-time updates.  
**Acceptance criteria**:
- When another session publishes a doc, lists update to reflect state change.
- Open editors show a deterministic “remote changed” banner.
**Test vectors**: TV-COLLAB-001, TV-COLLAB-002  
**Notes**: True multi-cursor collaboration is undefined unless explicitly required.

