# CmsFn Test Vectors

Golden inputs and expected outputs. Vectors mix server endpoint behavior and UI invariants, but all MUST be deterministic.

## Placeholders

- `<ISO>`: ISO 8601 UTC timestamp
- `<TOKEN>`: preview token string
- `<ROLE_ID>`: role id
- `<RELEASE_ID>`: release id

---

## Envelope / status

### TV-ENV-OK-001 (Positive: canonical success envelope)

**Input**:
- `GET /cmsfn/status`

**Expected output**:
- `{ "ok": true, "result": { "serverTime": "<ISO>", "capabilities": ["..."], "datasets": ["..."] } }`

---

### TV-ENV-ERR-001 (Negative: canonical error envelope)

**Input**:
- `POST /cmsfn/roles/delete` body `{ "roleId": "" }`

**Expected output**:

```json
{
  "ok": false,
  "error": { "code": "VALIDATION_FAILED", "message": "Invalid roleId", "details": { "path": "roleId" } }
}
```

---

### TV-STATUS-001 (Positive: cmsfn status includes datasets)

**Input**:
- `GET /cmsfn/status`

**Expected output**:
- `ok=true`
- `result.datasets` contains the configured datasets in deterministic order.

---

### TV-STATUS-002 (Negative: status forbidden when protected)

**Precondition**:
- Configure CmsFn to require auth for status and deny it.

**Input**:
- `GET /cmsfn/status`

**Expected output**:
- `ok=false`, `error.code="PERMISSION_DENIED"` (or `AUTH_REQUIRED`).

---

### TV-STATUS-CONTENTFN-DOWN-001 (Negative: contentfn unavailable)

**Precondition**:
- ContentFn base URL unreachable.

**Input**:
- Any CmsFn endpoint that depends on ContentFn (e.g. opening a document list).

**Expected output**:
- `ok=false`, `error.code="CONTENTFN_UNAVAILABLE"`.

---

## Studio + desk

### TV-STUDIO-BOOT-001 (Positive: studio boots)

**Input**:
- Load Studio root route `/studio`.

**Expected output**:
- Desk navigation renders (no blank state) and shows configured groups/lists/singletons.

---

### TV-DESK-STRUCT-001 (Positive: deterministic desk structure)

**Input**:
- Load Studio twice with the same `CmsfnStudioConfig`.

**Expected output**:
- Desk node ordering and labels are identical in both loads.

---

### TV-DESK-STRUCT-002 (Negative: invalid desk config fails deterministically)

**Input**:
- Start Studio with an invalid desk node (e.g., unknown `kind`).

**Expected output**:
- Studio shows a deterministic configuration error state and does not render a partially broken navigation tree.

---

### TV-DATASET-SCOPE-001 (Positive: dataset scoping)

**Input**:
- Select dataset `prod` and open a document list; then select dataset `staging` and open the same list.

**Expected output**:
- CFQL queries sent to ContentFn use the selected dataset name only.

---

### TV-DATASET-SCOPE-002 (Negative: cross-dataset open denied)

**Input**:
- Attempt to open a document editor for a doc ID known to exist only in another dataset.

**Expected output**:
- Studio shows not-found or denied state; no cross-dataset content is displayed.

---

## Lists

### TV-LIST-QUERY-001 (Positive: list uses CFQL deterministically)

**Input**:
- Open a document list pane for types `["post"]`.

**Expected output**:
- Studio issues a CFQL query to ContentFn with:
  - `dataset` equal to selected dataset
  - `types=["post"]`
  - `limit` bounded by config/server limits
  - deterministic ordering (explicit `orderBy` or ContentFn default)

---

### TV-LIST-PAGINATION-001 (Positive: list pagination uses opaque cursor)

**Precondition**:
- The list contains at least 3 items.

**Input**:
- Load first page with `limit=2`, then click “Next page”.

**Expected output**:
- Studio passes the `nextCursor` returned by ContentFn back to ContentFn unchanged (opaque).
- Studio does not parse or mutate cursor values.

---

### TV-LIST-QUERY-002 (Negative: list query error surfaced deterministically)

**Precondition**:
- ContentFn returns an error for the list query (e.g., `QUERY_INVALID`).

**Input**:
- Open the list pane.

**Expected output**:
- Studio shows a deterministic error state (no crash) and exposes a retry action.

---

## Editor rendering + validation + save

### TV-EDITOR-RENDER-001 (Positive: schema widgets render)

**Precondition**:
- ContentFn schema contains types with primitive, object, array, reference, richtext, asset fields.

**Input**:
- Open editor for each type.

**Expected output**:
- Each field renders a corresponding widget deterministically.

---

### TV-EDITOR-RENDER-002 (Negative: unknown type cannot render)

**Input**:
- Attempt to open editor for `_type="unknownType"`.

**Expected output**:
- Studio shows an error state; server returns `NOT_FOUND` or `VALIDATION_FAILED` deterministically.

---

### TV-EDITOR-VALIDATE-001 (Positive: client-side required validation)

**Input**:
- Clear a required field and attempt to save.

**Expected output**:
- Local validation shows error before sending patch.

---

### TV-EDITOR-VALIDATE-002 (Negative: server-side validation failed surfaced)

**Precondition**:
- Bypass local validation (e.g. direct patch with invalid value) or rely on server constraints.

**Input**:
- Save which triggers ContentFn `VALIDATION_FAILED`.

**Expected output**:
- Studio surfaces error with field path mapping and does not claim success.

---

### TV-EDITOR-SAVE-001 (Positive: save uses docs.patch with ifRev)

**Input**:
- Edit a field and save.

**Expected output**:
- Network call to ContentFn `docs.patch` includes `ifRev` and patch ops.

---

### TV-EDITOR-CONFLICT-001 (Negative: REV_CONFLICT conflict UI)

**Precondition**:
- Two sessions open the same doc; session A saves; session B attempts to save with stale rev.

**Input**:
- Session B saves.

**Expected output**:
- Conflict UI shown; deterministic options: refresh, attempt re-apply; ContentFn returns `REV_CONFLICT`.

---

## Workflow + publish

### TV-WORKFLOW-DRAFT-001 (Positive: draft indicator)

**Input**:
- Open a draft doc.

**Expected output**:
- UI indicates “Draft” state; published state is distinct.

---

### TV-WORKFLOW-PUBLISH-001 (Positive: publish)

**Input**:
- Click Publish for a draft doc in allowed workflow state.

**Expected output**:
- ContentFn publish is called; UI updates to reflect published state.

---

### TV-WORKFLOW-UNPUBLISH-001 (Positive: unpublish)

**Input**:
- Click Unpublish.

**Expected output**:
- ContentFn unpublish is called; published state removed while draft remains editable.

---

## Preview

### TV-PREVIEW-TOKEN-001 (Positive: preview token minted)

**Input**:
- `POST /cmsfn/preview/token` with `{ dataset:"prod", docId:"post-1" }`

**Expected output**:
- `ok=true`, `result.token="<TOKEN>"`, `result.expiresAt="<ISO>"`.

---

### TV-PREVIEW-LIVE-001 (Positive: preview updates on draft changes)

**Precondition**:
- Preview enabled and realtime connected.

**Input**:
- Edit draft content; observe preview frame.

**Expected output**:
- Preview refreshes deterministically (by message or reload strategy) after draft change event.

---

### TV-PREVIEW-DISABLED-001 (Negative: preview not configured)

**Precondition**:
- Preview disabled in config.

**Input**:
- Attempt to open preview.

**Expected output**:
- `ok=false`, `error.code="PREVIEW_NOT_CONFIGURED"` (or UI shows deterministic disabled state).

---

## Media

### TV-MEDIA-UPLOAD-001 (Positive: asset upload)

**Input**:
- Upload a file in media library.

**Expected output**:
- ContentFn assets.upload called; UI shows new asset entry.

---

### TV-MEDIA-BROWSE-001 (Positive: deterministic asset browse)

**Input**:
- Open media library list twice without changes.

**Expected output**:
- Asset ordering is identical.

---

### TV-MEDIA-INSERT-001 (Positive: insert asset ref)

**Input**:
- Select an asset and insert into a document.

**Expected output**:
- Document contains canonical asset ref object with `_type` and `_ref`.

---

## References

### TV-REF-PICKER-001 (Positive: pick reference)

**Input**:
- Open reference picker for a field and select a doc.

**Expected output**:
- Document stores canonical reference object.

---

### TV-REF-PICKER-002 (Negative: reference denied by permissions)

**Precondition**:
- Role denies `doc.read` for referenced type.

**Input**:
- Open reference picker.

**Expected output**:
- Picker shows deterministic “no access” state; server denies.

---

## Workflow state gating

### TV-WF-STATE-001 (Positive: _cms state stored)

**Input**:
- Move a doc to “in_review”.

**Expected output**:
- Draft document contains `_cms.workflow` and `_cms.state="in_review"`.

---

### TV-WF-PUBLISH-GATE-001 (Negative: publish blocked by workflow)

**Precondition**:
- Doc state is `in_review` and role lacks override.

**Input**:
- Attempt publish.

**Expected output**:
- Denied deterministically with `PERMISSION_DENIED` or `CONFLICT`.

---

## Releases

### TV-REL-CREATE-001 (Positive: create release)

**Input**:
- `POST /cmsfn/releases/create` `{ "dataset":"prod", "name":"Launch", "publishAt": null }`

**Expected output**:
- `ok=true`, `result.releaseId="<RELEASE_ID>"`.

---

### TV-REL-ADD-001 (Positive: add doc to release)

**Input**:
- `POST /cmsfn/releases/add` `{ "dataset":"prod", "releaseId":"<RELEASE_ID>", "docId":"post-1" }`

**Expected output**:
- `ok=true`

---

### TV-REL-PUBLISH-001 (Positive: publish release)

**Input**:
- `POST /cmsfn/releases/publish` `{ "dataset":"prod", "releaseId":"<RELEASE_ID>" }`

**Expected output**:
- `ok=true`, result includes deterministic summary with published doc IDs.

---

### TV-REL-PUBLISH-002 (Negative: publish release with failing doc)

**Precondition**:
- Release contains one doc that fails workflow gate or ContentFn validation.

**Input**:
- Publish release.

**Expected output**:
- `ok=false` OR `ok=true` with `result.failures` (implementation-defined but must be deterministic and documented).

---

## Roles

### TV-ROLE-UPSERT-001 (Positive: upsert role)

**Input**:
- `POST /cmsfn/roles/upsert` with a valid role definition.

**Expected output**:
- `ok=true`, role is returned/stored.

---

### TV-ROLE-LIST-001 (Positive: list roles)

**Input**:
- `POST /cmsfn/roles/list` `{ "dataset":"prod" }`

**Expected output**:
- `ok=true`, roles returned in deterministic order.

---

### TV-ROLE-DENY-001 (Negative: denied action)

**Precondition**:
- Role denies `doc.publish`.

**Input**:
- Attempt publish.

**Expected output**:
- `ok=false`, `error.code="PERMISSION_DENIED"`.

---

## Audit

### TV-AUDIT-EVENTS-001 (Positive: read event metadata)

**Input**:
- `POST /cmsfn/audit/events` `{ "dataset":"prod", "limit": 10 }`

**Expected output**:
- `ok=true`, list includes event metadata without raw document body fields.

---

### TV-AUDIT-WEBHOOKS-001 (Positive: read webhook delivery status)

**Input**:
- `POST /cmsfn/audit/webhooks` `{ "dataset":"prod", "limit": 10 }`

**Expected output**:
- `ok=true`, list includes webhookId, status, attempt, timestamps.

---

### TV-AUDIT-DENY-001 (Negative: audit access denied)

**Input**:
- Call audit endpoint without permission.

**Expected output**:
- `ok=false`, `error.code="PERMISSION_DENIED"` (or `AUTH_REQUIRED`).

---

## Ops import/export

### TV-OPS-EXPORT-001 (Positive: trigger export)

**Input**:
- `POST /cmsfn/ops/export` `{ "dataset":"prod" }`

**Expected output**:
- `ok=true` and returns an artifact or a deterministic job handle.

---

### TV-OPS-IMPORT-001 (Positive: trigger import)

**Input**:
- `POST /cmsfn/ops/import` `{ "dataset":"prod2", "artifact": { "...": "..." } }`

**Expected output**:
- `ok=true`

---

### TV-OPS-IMPORT-002 (Negative: malformed artifact)

**Input**:
- Import with malformed artifact.

**Expected output**:
- `ok=false`, `error.code="VALIDATION_FAILED"`.

---

## Observability

### TV-OBS-001 (Positive: logs redact doc bodies)

**Input**:
- Perform editor save.

**Expected output**:
- Logs contain action metadata but not raw doc fields.

---

### TV-OBS-002 (Negative: logs do not contain auth secrets)

**Input**:
- Login and perform actions.

**Expected output**:
- Logs do not contain tokens/passwords/secrets.

---

## Limits

### TV-LIMIT-UPLOAD-001 (Negative: oversized upload)

**Input**:
- Upload a file exceeding max upload bytes.

**Expected output**:
- Rejected deterministically with `PAYLOAD_TOO_LARGE`.

---

### TV-LIMIT-RICHTEXT-001 (Negative: richtext too large)

**Input**:
- Attempt to save a richtext field exceeding max blocks.

**Expected output**:
- Rejected with `VALIDATION_FAILED`.

---

### TV-LIMIT-RELEASE-001 (Negative: release too large)

**Input**:
- Add docs to a release beyond max size.

**Expected output**:
- Rejected deterministically (`VALIDATION_FAILED` or `CONFLICT`, documented).

---

## Extensions

### TV-PLUG-001 (Positive: register custom widget)

**Input**:
- Register a custom widget for a field.

**Expected output**:
- Widget is used consistently for that field.

---

### TV-PLUG-002 (Negative: widget conflict resolved deterministically)

**Input**:
- Register two widgets for the same field.

**Expected output**:
- Deterministic resolution rule applies (first wins/last wins, documented).

---

## Collaboration

### TV-COLLAB-001 (Positive: list updates on publish event)

**Input**:
- Session A publishes a doc; Session B is viewing a list.

**Expected output**:
- Session B list updates deterministically after realtime event.

---

### TV-COLLAB-002 (Negative: editor shows remote-changed banner)

**Input**:
- Session A patches a doc; Session B has it open.

**Expected output**:
- Session B shows deterministic remote-changed UI.

---

## Desk panes

### TV-DESK-PANES-001 (Positive: history pane shows revisions)

**Precondition**:
- ContentFn history endpoint is available and the document has at least 2 revisions.

**Input**:
- Open the History pane for a document.

**Expected output**:
- Studio requests ContentFn `docs.history` and renders revisions in deterministic order (most recent first).

**Negative variant**:
- If permissions deny audit/history access, Studio shows deterministic “no access” state and does not render revision content.

---

### TV-DESK-PANES-002 (Positive: webhook/audit pane shows delivery attempts)

**Precondition**:
- Webhooks are configured and at least one delivery attempt exists.

**Input**:
- Open the Webhooks/Audit pane for a dataset.

**Expected output**:
- Studio requests CmsFn audit endpoints and renders delivery attempts deterministically (stable ordering and pagination).

**Negative variant**:
- Without `audit.read` permission, the pane is denied deterministically.

