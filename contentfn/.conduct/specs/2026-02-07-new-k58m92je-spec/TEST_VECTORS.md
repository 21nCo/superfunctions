# ContentFn Test Vectors

Golden inputs and expected outputs for ContentFn. Vectors are written primarily against the HTTP API, but are equally applicable to the SDK.

## Conventions (determinism + placeholders)

Some server-generated values (timestamps, revision IDs, event IDs) are represented with placeholders:
- `<ISO>`: an ISO 8601 UTC timestamp string.
- `<REV>`: a revision string.
- `<HASH>`: a deterministic schema hash string.
- `<CURSOR>`: an opaque cursor string.
- `<ASSET_ID>`: an asset identifier string.
- `<WEBHOOK_ID>`: a webhook identifier string.

Unless explicitly fixed, tests MUST validate **shape + invariants** (e.g., `_id` equality, ordering rules, error codes) rather than exact server-generated values.

## Fixture schema used by multiple vectors

`schemaV1`:

```json
{
  "version": 1,
  "documentTypes": [
    {
      "name": "author",
      "fields": [
        { "name": "name", "type": { "kind": "primitive", "type": "string" }, "required": true }
      ]
    },
    {
      "name": "post",
      "fields": [
        { "name": "title", "type": { "kind": "primitive", "type": "string" }, "required": true },
        { "name": "views", "type": { "kind": "primitive", "type": "number" }, "required": false },
        { "name": "author", "type": { "kind": "reference", "to": ["author"] }, "required": false },
        { "name": "body", "type": { "kind": "richtext" }, "required": false },
        { "name": "heroImage", "type": { "kind": "asset", "assetType": "image" }, "required": false }
      ]
    }
  ]
}
```

---

## API / Envelope

### TV-API-CONFIG-001 (Positive: server exposes required namespaces)

**Input**:
- Start server with DB adapter and call `GET /contentfn/status`

**Expected output**:
- `{ "ok": true, "result": { "serverTime": "<ISO>", "capabilities": ["..."], "limits": { "...": "..." } } }`
- `capabilities` includes at least `content.schema`, `content.docs`, `content.assets`, `content.webhooks` (and `content.realtime` when enabled).

---

### TV-API-CONFIG-002 (Negative: server cannot start without DB adapter)

**Input**:
- Attempt to construct/start the ContentFn server without providing `config.db`.

**Expected output**:
- Startup fails deterministically (before serving requests) with a clear error message (implementation-defined) indicating the DB adapter is required.

---

### TV-ENV-OK-001 (Positive: canonical success envelope)

**Input**:
- `POST /contentfn/datasets/list` with body `{}`.

**Expected output**:

```json
{ "ok": true, "result": { "datasets": [] } }
```

---

### TV-ENV-ERR-001 (Negative: canonical error envelope)

**Input**:
- `POST /contentfn/datasets/create` with body `{ "dataset": "" }`.

**Expected output**:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Dataset name is invalid",
    "details": { "path": "dataset" }
  }
}
```

---

## Datasets

### TV-DS-CREATE-001 (Positive: create dataset)

**Input**:
- `POST /contentfn/datasets/create` body:

```json
{ "dataset": "prod" }
```

**Expected output**:

```json
{ "ok": true, "result": { "dataset": "prod" } }
```

---

### TV-DS-CREATE-002 (Negative: invalid dataset name)

**Input**:
- `POST /contentfn/datasets/create` body:

```json
{ "dataset": "Prod!" }
```

**Expected output**:
- `ok=false`, `error.code="VALIDATION_FAILED"`, `error.details.path="dataset"`.

---

### TV-DS-CREATE-003 (Negative: duplicate dataset)

**Precondition**:
- Run TV-DS-CREATE-001.

**Input**:
- `POST /contentfn/datasets/create` body `{ "dataset": "prod" }`

**Expected output**:
- `ok=false`, `error.code="DATASET_ALREADY_EXISTS"`, `error.details.dataset="prod"`.

---

### TV-DS-ISOLATION-001 (Positive: dataset isolation)

**Precondition**:
- Create datasets `prod` and `staging`.
- Upsert `schemaV1` into both.

**Input**:
- `POST /contentfn/docs/create` in `prod`:

```json
{ "dataset": "prod", "id": "post-1", "type": "post", "doc": { "title": "Hello" } }
```

- Then `POST /contentfn/docs/get` in `staging`:

```json
{ "dataset": "staging", "id": "post-1", "perspective": "published" }
```

**Expected output**:
- Create in `prod` succeeds.
- Get in `staging` returns `ok=false`, `error.code="DOCUMENT_NOT_FOUND"` (or `DATASET_NOT_FOUND` if staging missing).

---

### TV-DS-DELETE-001 (Positive: delete dataset makes it unavailable)

**Precondition**:
- Create dataset `prod`.

**Input**:
- `POST /contentfn/datasets/delete` body `{ "dataset": "prod" }`
- Then `POST /contentfn/schema/get` body `{ "dataset": "prod" }`

**Expected output**:
- delete: `{ "ok": true, "result": {} }`
- get schema: `ok=false`, `error.code="DATASET_NOT_FOUND"`.

---

## Schema

### TV-SCHEMA-UPSERT-001 (Positive: upsert schema)

**Precondition**:
- Create dataset `prod`.

**Input**:
- `POST /contentfn/schema/upsert` body:

```json
{ "dataset": "prod", "schema": { "version": 1, "documentTypes": [ { "name": "post", "fields": [ { "name": "title", "type": { "kind": "primitive", "type": "string" }, "required": true } ] } ] } }
```

**Expected output**:
- `{ "ok": true, "result": { "schemaHash": "<HASH>" } }`

---

### TV-SCHEMA-GET-001 (Positive: get schema)

**Precondition**:
- Upsert `schemaV1` into dataset `prod`.

**Input**:
- `POST /contentfn/schema/get` body:

```json
{ "dataset": "prod" }
```

**Expected output**:
- `{ "ok": true, "result": <schemaV1 JSON> }`

---

### TV-SCHEMA-UPSERT-002 (Negative: invalid schema)

**Precondition**:
- Create dataset `prod`.

**Input**:
- `POST /contentfn/schema/upsert` body:

```json
{
  "dataset": "prod",
  "schema": {
    "version": 1,
    "documentTypes": [
      { "name": "post", "fields": [ { "name": "title", "type": { "kind": "primitive", "type": "string" }, "required": true } ] },
      { "name": "post", "fields": [] }
    ]
  }
}
```

**Expected output**:
- `ok=false`, `error.code="SCHEMA_INVALID"` (or `VALIDATION_FAILED`), and `error.details.path` points to the duplicated type name.

---

### TV-SCHEMA-VERSION-001 (Negative: decreasing schema version)

**Precondition**:
- Upsert schema version 2 into `prod`.

**Input**:
- `POST /contentfn/schema/upsert` body:

```json
{ "dataset": "prod", "schema": { "version": 1, "documentTypes": [] } }
```

**Expected output**:
- `ok=false`, `error.code="SCHEMA_VERSION_CONFLICT"`.

---

### TV-SCHEMA-VERSION-002 (Negative: same version, different content)

**Precondition**:
- Upsert `schemaV1` (version 1) into `prod`.

**Input**:
- Upsert a different schema also claiming version 1.

**Expected output**:
- `ok=false`, `error.code="SCHEMA_VERSION_CONFLICT"`.

---

## Documents (create/get/delete + perspectives)

### TV-DOC-CREATE-001 (Positive: create published doc)

**Precondition**:
- Dataset `prod` exists and has `schemaV1`.

**Input**:
- `POST /contentfn/docs/create` body:

```json
{ "dataset": "prod", "id": "post-1", "type": "post", "doc": { "title": "Hello", "views": 1 } }
```

**Expected output**:
- `ok=true`
- `result._id="post-1"`, `result._type="post"`
- `result._rev="<REV>"`, `result._createdAt="<ISO>"`, `result._updatedAt="<ISO>"`
- `result.title="Hello"`, `result.views=1`

---

### TV-DOC-CREATE-002 (Negative: missing required field)

**Precondition**:
- Dataset `prod` exists and has `schemaV1` where `post.title` is required.

**Input**:
- `POST /contentfn/docs/create` body:

```json
{ "dataset": "prod", "id": "post-2", "type": "post", "doc": { "views": 1 } }
```

**Expected output**:
- `ok=false`, `error.code="VALIDATION_FAILED"`, `error.details.path` includes `title`.

---

### TV-DOC-GET-001 (Positive: get existing doc)

**Precondition**:
- Run TV-DOC-CREATE-001.

**Input**:
- `POST /contentfn/docs/get` body:

```json
{ "dataset": "prod", "id": "post-1", "perspective": "published" }
```

**Expected output**:
- `ok=true`, `result._id="post-1"`, `result.title="Hello"`.

---

### TV-DOC-GET-002 (Negative: get missing doc)

**Input**:
- `POST /contentfn/docs/get` body `{ "dataset": "prod", "id": "missing", "perspective": "published" }`

**Expected output**:
- `ok=false`, `error.code="DOCUMENT_NOT_FOUND"`.

---

### TV-DOC-DELETE-001 (Positive: delete doc)

**Precondition**:
- Create `post-1`.

**Input**:
- `POST /contentfn/docs/delete` body `{ "dataset": "prod", "id": "post-1", "purge": true }`
- Then get `post-1`.

**Expected output**:
- delete: `ok=true`
- get: `ok=false`, `error.code="DOCUMENT_NOT_FOUND"`.

---

### TV-DOC-DRAFT-ID-001 (Positive: create draft uses drafts. prefix)

**Precondition**:
- Dataset `prod` exists and has `schemaV1`.

**Input**:
- `POST /contentfn/docs/create` body:

```json
{ "dataset": "prod", "id": "post-3", "type": "post", "asDraft": true, "doc": { "title": "Draft" } }
```

**Expected output**:
- `ok=true`, `result._id="drafts.post-3"`.

---

### TV-DOC-PERSPECTIVE-001 (Positive: draft perspective returns draft only)

**Precondition**:
- Create draft `drafts.post-3` (TV-DOC-DRAFT-ID-001).

**Input**:
- `POST /contentfn/docs/get` body `{ "dataset": "prod", "id": "drafts.post-3", "perspective": "draft" }`

**Expected output**:
- `ok=true`, `result._id="drafts.post-3"`, `result.title="Draft"`.

---

### TV-DOC-PERSPECTIVE-002 (Negative: draft perspective missing)

**Precondition**:
- Ensure no draft exists for `post-999`.

**Input**:
- `POST /contentfn/docs/get` body `{ "dataset": "prod", "id": "drafts.post-999", "perspective": "draft" }`

**Expected output**:
- `ok=false`, `error.code="DOCUMENT_NOT_FOUND"`.

---

## Publish / unpublish

### TV-DOC-PUBLISH-001 (Positive: publish draft to published)

**Precondition**:
- Draft exists: `drafts.post-3` with title "Draft".

**Input**:
- `POST /contentfn/docs/publish` body `{ "dataset": "prod", "id": "post-3" }`

**Expected output**:
- `ok=true`, `result._id="post-3"`, `result._publishedAt="<ISO>"`, `result.title="Draft"`.

---

### TV-DOC-PUBLISH-002 (Negative: publish without draft)

**Precondition**:
- Ensure draft `drafts.post-404` does not exist.

**Input**:
- `POST /contentfn/docs/publish` body `{ "dataset": "prod", "id": "post-404" }`

**Expected output**:
- `ok=false`, `error.code="DOCUMENT_NOT_FOUND"` (or `VALIDATION_FAILED` with clear message).

---

### TV-DOC-UNPUBLISH-001 (Positive: unpublish removes published only)

**Precondition**:
- Publish `post-3` (TV-DOC-PUBLISH-001) and keep draft `drafts.post-3`.

**Input**:
- `POST /contentfn/docs/unpublish` body `{ "dataset": "prod", "id": "post-3" }`
- Then:
  - `POST /contentfn/docs/get` body `{ "dataset": "prod", "id": "post-3", "perspective": "published" }`
  - `POST /contentfn/docs/get` body `{ "dataset": "prod", "id": "drafts.post-3", "perspective": "draft" }`

**Expected output**:
- unpublish: `ok=true`
- get published: `ok=false`, `error.code="DOCUMENT_NOT_FOUND"`
- get draft: `ok=true`, draft still present.

---

## Patch + optimistic concurrency

### TV-PATCH-SET-001 (Positive: set field via patch)

**Precondition**:
- Create `post-1` with title "Hello" and capture `_rev` as `rev0`.

**Input**:
- `POST /contentfn/docs/patch` body:

```json
{
  "dataset": "prod",
  "id": "post-1",
  "ifRev": "rev0",
  "ops": [{ "op": "set", "path": "title", "value": "Hello 2" }]
}
```

**Expected output**:
- `ok=true`, `result.title="Hello 2"`, `result._rev` differs from `rev0`.

---

### TV-PATCH-UNSET-001 (Positive: unset field via patch)

**Precondition**:
- Create `post-1` with `views=1` and capture current rev.

**Input**:
- Patch:

```json
{ "dataset": "prod", "id": "post-1", "ops": [{ "op": "unset", "path": "views" }] }
```

**Expected output**:
- `ok=true`, result does not contain `views` (or contains `views=null` only if documented).

---

### TV-PATCH-NONNUM-001 (Negative: inc/dec non-numeric)

**Precondition**:
- Create `post-1` with `title="Hello"`.

**Input**:
- `POST /contentfn/docs/patch`:

```json
{ "dataset": "prod", "id": "post-1", "ops": [{ "op": "inc", "path": "title", "value": 1 }] }
```

**Expected output**:
- `ok=false`, `error.code="PATCH_INVALID"`, `error.details.path="title"`.

---

### TV-PATCH-INVALID-001 (Negative: invalid patch path)

**Precondition**:
- Create `post-1`.

**Input**:

```json
{ "dataset": "prod", "id": "post-1", "ops": [{ "op": "set", "path": "body.0.notAPath", "value": 1 }] }
```

**Expected output**:
- `ok=false`, `error.code="PATCH_INVALID"`, `error.details.path` includes the invalid path.

---

### TV-REV-CONFLICT-001 (Negative: revision conflict)

**Precondition**:
- Create `post-1` and capture `_rev` as `rev0`.
- Apply a patch without `ifRev` (or with `ifRev=rev0`) to advance the document to `rev1`.

**Input**:
- Patch again using stale `ifRev=rev0`.

**Expected output**:
- `ok=false`, `error.code="REV_CONFLICT"`, `error.details.expectedRev="rev0"`, `error.details.actualRev="rev1"` (field names may vary but both revs must be present).

---

## History + restore

### TV-HIST-LIST-001 (Positive: list history)

**Precondition**:
- Create `post-1` and patch it at least once.

**Input**:
- `POST /contentfn/docs/history` body `{ "dataset": "prod", "id": "post-1", "limit": 10 }`

**Expected output**:
- `ok=true`, `result.revisions` array length >= 2, each item has `_rev` and `_updatedAt`.

---

### TV-RESTORE-001 (Positive: restore revision writes draft)

**Precondition**:
- Create and patch `post-1`; list history and select an older `revOld`.

**Input**:
- `POST /contentfn/docs/restore` body `{ "dataset": "prod", "id": "post-1", "rev": "revOld" }`

**Expected output**:
- `ok=true`, `result._id` equals `drafts.post-1` (or a documented draft target), and content matches the selected revision.

---

### TV-RESTORE-002 (Negative: restore unknown revision)

**Input**:
- `POST /contentfn/docs/restore` body `{ "dataset": "prod", "id": "post-1", "rev": "does-not-exist" }`

**Expected output**:
- `ok=false`, `error.code="VALIDATION_FAILED"` (or `DOCUMENT_NOT_FOUND`) with clear message.

---

## Query (CFQL)

### TV-QRY-001 (Positive: filter + order + limit)

**Precondition**:
- Create `post-1` title "A" and `post-2` title "B".

**Input**:
- `POST /contentfn/query` body:

```json
{
  "dataset": "prod",
  "types": ["post"],
  "filter": { "field": "title", "op": "in", "value": ["A", "B"] },
  "orderBy": [{ "field": "title", "direction": "asc" }],
  "limit": 1
}
```

**Expected output**:
- `ok=true`, `result.data.length=1`, `result.data[0].title="A"`, `result.nextCursor` is string or null.

---

### TV-QRY-PROJECTION-001 (Positive: projection fields)

**Precondition**:
- Create `post-1` with `title` and `views`.

**Input**:

```json
{
  "dataset": "prod",
  "types": ["post"],
  "projection": { "fields": ["_id", "title"] },
  "orderBy": [{ "field": "_id", "direction": "asc" }],
  "limit": 10
}
```

**Expected output**:
- Each returned document includes `_id` and `title`.
- Returned documents do not include `views` (unless system fields inclusion rules override; must be deterministic and documented).

---

### TV-QRY-INVALID-001 (Negative: invalid operator)

**Input**:
- Query with an unknown operator:

```json
{ "dataset": "prod", "types": ["post"], "filter": { "field": "title", "op": "wat", "value": "A" } }
```

**Expected output**:
- `ok=false`, `error.code="QUERY_INVALID"`, `error.details.path` includes `filter.op`.

---

### TV-QRY-ORDER-DEFAULT-001 (Positive: default ordering)

**Precondition**:
- Create two posts with different `_updatedAt` values (via patching one).

**Input**:
- Query without `orderBy`:

```json
{ "dataset": "prod", "types": ["post"], "limit": 10 }
```

**Expected output**:
- Result is ordered by `_updatedAt desc`, then `_id asc` as tie-breaker.

---

### TV-QRY-ORDER-TIEBREAK-001 (Positive: _id asc tie-break)

**Precondition**:
- Create two posts such that `orderBy` field values are equal.

**Input**:
- Query ordered by that field, without `_id`:

```json
{ "dataset": "prod", "types": ["post"], "orderBy": [{ "field": "views", "direction": "asc" }], "limit": 10 }
```

**Expected output**:
- When `views` ties, ordering between tied items is `_id asc`.

---

### TV-QRY-CURSOR-001 (Positive: cursor pagination)

**Precondition**:
- Create at least 3 posts titled A, B, C.

**Input**:
- Page 1:

```json
{ "dataset": "prod", "types": ["post"], "orderBy": [{ "field": "title", "direction": "asc" }], "limit": 2 }
```

- Page 2: repeat query with `cursor=<CURSOR>` returned from page 1.

**Expected output**:
- Page 1 returns A,B and a non-null `nextCursor`.
- Page 2 returns C and `nextCursor=null`.

---

## References

### TV-REF-ENCODE-001 (Positive: canonical reference shape round-trip)

**Precondition**:
- Create author `author-1` name "Ada".

**Input**:
- Create post referencing author:

```json
{
  "dataset": "prod",
  "id": "post-10",
  "type": "post",
  "doc": {
    "title": "With ref",
    "author": { "_type": "reference", "_ref": "author-1", "_weak": false }
  }
}
```

**Expected output**:
- `ok=true`
- Getting `post-10` returns `author` field identical in shape to the input reference object.

---

### TV-REF-EXPAND-001 (Positive: expand reference)

**Precondition**:
- Create author `author-1` and post `post-10` referencing it.

**Input**:

```json
{
  "dataset": "prod",
  "types": ["post"],
  "filter": { "field": "_id", "op": "eq", "value": "post-10" },
  "projection": {
    "fields": ["_id", "title", "author"],
    "expand": {
      "authorDoc": { "field": "author", "projection": { "fields": ["_id", "name"] } }
    }
  },
  "limit": 1
}
```

**Expected output**:
- `ok=true`
- Returned document includes an `authorDoc` object with `_id="author-1"` and `name="Ada"`.

---

### TV-REF-EXPAND-002 (Negative: expand depth exceeded)

**Precondition**:
- Server configured with `maxExpandDepth=1`.

**Input**:
- Query that attempts nested expansion depth 2.

**Expected output**:
- `ok=false`, `error.code="QUERY_TOO_COMPLEX"` (or deterministic truncation if explicitly documented; if truncation is used, this vector must change accordingly).

---

### TV-REF-CYCLE-001 (Positive: cycle-safe expansion)

**Precondition**:
- Create docs A and B that reference each other (A.ref=B, B.ref=A).

**Input**:
- Query A with expansion depth 3.

**Expected output**:
- Query terminates and returns a deterministic truncated structure (no infinite recursion).

---

## Assets

### TV-ASSET-UPLOAD-001 (Positive: upload asset)

**Precondition**:
- Dataset `prod` exists.

**Input**:
- `POST /contentfn/assets/upload` body:

```json
{
  "dataset": "prod",
  "filename": "hello.txt",
  "contentType": "text/plain",
  "bytesBase64": "aGVsbG8="
}
```

**Expected output**:
- `ok=true`, `result.assetId="<ASSET_ID>"`, `result.url` is a string.

---

### TV-ASSET-UPLOAD-002 (Negative: payload too large)

**Precondition**:
- Server configured with `maxPayloadBytes` small enough to reject the request.

**Input**:
- Upload request whose JSON body exceeds `maxPayloadBytes`.

**Expected output**:
- `ok=false`, `error.code="PAYLOAD_TOO_LARGE"`.

---

### TV-ASSET-GET-001 (Positive: get uploaded asset)

**Precondition**:
- Upload asset (TV-ASSET-UPLOAD-001) capturing `assetId`.

**Input**:
- `POST /contentfn/assets/get` body `{ "dataset": "prod", "assetId": "<ASSET_ID>" }`

**Expected output**:
- `ok=true`, `result.assetId` matches, `result.url` matches stable asset URL, `result.metadata` is an object.

---

### TV-ASSET-GET-002 (Negative: missing asset)

**Input**:
- `POST /contentfn/assets/get` body `{ "dataset": "prod", "assetId": "missing" }`

**Expected output**:
- `ok=false`, `error.code="ASSET_NOT_FOUND"`.

---

## Webhooks

### TV-WH-REGISTER-001 (Positive: register webhook)

**Precondition**:
- Dataset `prod` exists.

**Input**:
- `POST /contentfn/webhooks/register` body:

```json
{ "dataset": "prod", "url": "https://example.com/hook", "events": ["doc.published"], "secret": "shh" }
```

**Expected output**:
- `ok=true`, `result.webhookId="<WEBHOOK_ID>"`.

---

### TV-WH-REGISTER-002 (Negative: invalid webhook url)

**Input**:
- `POST /contentfn/webhooks/register` body `{ "dataset": "prod", "url": "not-a-url", "events": ["doc.published"] }`

**Expected output**:
- `ok=false`, `error.code="VALIDATION_FAILED"`, `error.details.path="url"`.

---

### TV-WH-DELIVERY-001 (Positive: publish triggers webhook)

**Precondition**:
- Register webhook listening to `doc.published` with `secret`.
- Provide a test webhook receiver that records requests.

**Input**:
- Publish `post-3` (TV-DOC-PUBLISH-001).

**Expected output**:
- Receiver gets a request whose JSON body matches the webhook payload schema in `SPEC.md` and includes header `X-ContentFn-Signature: v1=<hex>`.

---

## Realtime

### TV-RT-SUBSCRIBE-001 (Positive: subscribe to doc events)

**Precondition**:
- Realtime enabled.

**Input**:
- Connect to realtime transport and subscribe to `{ dataset:"prod", docId:"post-3" }` (transport-specific).

**Expected output**:
- Subscription ack (implementation-defined).
- On publish/patch, client receives event messages containing `eventId`, `type`, `dataset`, `timestamp`, and `document._id="post-3"`.

---

### TV-RT-SUBSCRIBE-002 (Negative: unauthorized subscribe)

**Precondition**:
- Authorization requires auth for realtime.

**Input**:
- Attempt to subscribe without auth context.

**Expected output**:
- Deterministic denial with `AUTH_REQUIRED` or `PERMISSION_DENIED`.

---

### TV-RT-EVENTS-001 (Positive: publish emits doc.published)

**Precondition**:
- Realtime connected and subscribed to dataset events.

**Input**:
- Publish a document.

**Expected output**:
- Receive a message with `type="doc.published"` for that dataset/doc.

---

## Authorization

### TV-AUTH-ALLOW-001 (Positive: authorize allows operation)

**Precondition**:
- Server configured with `authorize` that returns true for `docs.get`.

**Input**:
- `POST /contentfn/docs/get` for a valid document.

**Expected output**:
- `ok=true` with document content.

---

### TV-AUTH-DENY-001 (Negative: authorize denies operation)

**Precondition**:
- Server configured with `authorize` that returns false for `docs.get`.

**Input**:
- `POST /contentfn/docs/get` for any document.

**Expected output**:
- `ok=false`, `error.code="PERMISSION_DENIED"`, and response MUST NOT include document body.

---

## Limits

### TV-LIMIT-PAYLOAD-001 (Negative: oversized request payload)

**Precondition**:
- `maxPayloadBytes` set to a small value.

**Input**:
- Send a request whose JSON body exceeds the limit (e.g., a massive `doc` field).

**Expected output**:
- `ok=false`, `error.code="PAYLOAD_TOO_LARGE"`.

---

### TV-LIMIT-PATCHOPS-001 (Negative: too many patch ops)

**Precondition**:
- `maxPatchOps=2`.

**Input**:
- Patch with 3 ops.

**Expected output**:
- `ok=false`, error code is `VALIDATION_FAILED` (or `PAYLOAD_TOO_LARGE`) deterministically as documented.

---

## Observability

### TV-OBS-LOGGING-001 (Positive: mutation logs exclude document body)

**Precondition**:
- Logger captures structured logs.

**Input**:
- Create or patch a document whose body includes a field `secret="abc"`.

**Expected output**:
- A mutation log entry exists containing dataset + doc ID + action, and does NOT include the raw field `secret` value.

---

### TV-OBS-LOGGING-002 (Negative: raw bytes are not logged)

**Precondition**:
- Logger captures structured logs.

**Input**:
- Upload an asset with bytes `aGVsbG8=`.

**Expected output**:
- Logs may include size/type but MUST NOT include the base64 bytes string.

---

## Status

### TV-STATUS-001 (Positive: status returns time/capabilities/limits)

**Input**:
- `GET /contentfn/status`

**Expected output**:
- `ok=true`, `result.serverTime="<ISO>"`, `result.capabilities` array, `result.limits` object.

---

### TV-STATUS-002 (Negative: status forbidden when protected)

**Precondition**:
- Server configured to authorize status and deny it.

**Input**:
- `GET /contentfn/status`

**Expected output**:
- `ok=false`, `error.code="PERMISSION_DENIED"` (or `AUTH_REQUIRED`).

---

## Import / export

### TV-IMP-EXPORT-001 (Positive: export dataset artifact)

**Precondition**:
- Dataset `prod` exists with schema and at least one document.

**Input**:
- Export command or endpoint (implementation-defined): `POST /contentfn/datasets/export` body `{ "dataset":"prod" }`

**Expected output**:
- `ok=true` and result contains a deterministic artifact with schema + documents + assets metadata + revision references.

---

### TV-IMP-IMPORT-001 (Positive: import into new dataset)

**Precondition**:
- Have an exported artifact from TV-IMP-EXPORT-001.

**Input**:
- Import endpoint `POST /contentfn/datasets/import` body `{ "dataset":"prod2", "artifact": <artifact> }`

**Expected output**:
- `ok=true` and querying key documents in `prod2` yields the same results as in `prod`.

---

### TV-IMP-IMPORT-002 (Negative: malformed import artifact)

**Input**:
- Import with invalid artifact (missing schema or documents array).

**Expected output**:
- `ok=false`, `error.code="VALIDATION_FAILED"`.

---

## Search / match

### TV-QRY-MATCH-001 (Positive: match filter returns hits when enabled)

**Precondition**:
- Search enabled and indexed.
- Create a post with title "Hello world".

**Input**:

```json
{ "dataset": "prod", "types": ["post"], "filter": { "field": "title", "op": "match", "value": "world" } }
```

**Expected output**:
- `ok=true` and result includes the post.

---

### TV-QRY-MATCH-002 (Negative: match fails deterministically when disabled)

**Precondition**:
- Search disabled.

**Input**:
- Same query as TV-QRY-MATCH-001.

**Expected output**:
- `ok=false`, `error.code="QUERY_INVALID"` with a message indicating match/search is not configured.

---

## CLI

### TV-CLI-001 (Positive: validate schema)

**Input**:
- `contentfn schema validate ./schema.json`

**Expected output**:
- Exit code 0, prints `ok` and the computed schema hash.

---

### TV-CLI-002 (Positive: export + import)

**Input**:
- `contentfn dataset export --dataset prod --out ./prod.export.json`
- `contentfn dataset import --dataset prod2 --in ./prod.export.json`

**Expected output**:
- Both commands exit 0; `prod2` contains the same documents (by `_id`) as `prod`.

---

### TV-CLI-003 (Negative: invalid CLI input)

**Input**:
- `contentfn schema upsert --dataset prod --file ./missing.json`

**Expected output**:
- Non-zero exit code; prints a clear error message indicating missing file.

