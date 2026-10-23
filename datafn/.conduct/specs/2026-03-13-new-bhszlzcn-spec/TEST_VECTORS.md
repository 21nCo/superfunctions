# Test Vectors

## TV-ARCH-001-P
- Vector ID: TV-ARCH-001-P
- Description: Core share ACL works with no plugins configured.
- Input:
```json
{
  "serverConfig": { "plugins": [] },
  "mutation": {
    "resource": "notes",
    "version": 1,
    "operation": "share",
    "id": "note_1",
    "shareWith": { "principalId": "user:bob", "level": "viewer" }
  },
  "actorId": "alice"
}
```
- Expected output:
```json
{ "ok": true, "result": { "ok": true } }
```
- Negative variant(s): N/A

## TV-ARCH-001-N
- Vector ID: TV-ARCH-001-N
- Description: Plugin-disabled environment still denies unauthorized share.
- Input:
```json
{
  "serverConfig": { "plugins": [] },
  "mutation": {
    "resource": "notes",
    "version": 1,
    "operation": "share",
    "id": "note_1",
    "shareWith": { "principalId": "user:charlie", "level": "viewer" }
  },
  "actorId": "bob"
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "FORBIDDEN", "message": "Authorization denied", "details": { "path": "operation" } }
}
```
- Negative variant(s): N/A

## TV-ARCH-002-P
- Vector ID: TV-ARCH-002-P
- Description: Shared-with-me query returns cross-namespace rows via global permissions table.
- Input:
```json
{
  "query": {
    "resource": "notes",
    "version": 1,
    "operation": "find",
    "metadata": { "accessMode": "sharedWithMe" }
  },
  "actorId": "bob"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": [
    { "id": "note_1", "__ns": "user:alice" },
    { "id": "note_9", "__ns": "org:acme" }
  ]
}
```
- Negative variant(s): N/A

## TV-ARCH-002-N
- Vector ID: TV-ARCH-002-N
- Description: Query fails when global table missing required columns.
- Input:
```json
{
  "migrationState": { "permissionsGlobal": { "columns": ["resourceId", "principalId"] } },
  "query": { "resource": "notes", "version": 1, "operation": "find", "metadata": { "accessMode": "sharedWithMe" } }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "INTERNAL", "message": "Missing required permissions schema", "details": { "path": "__datafn_permissions_global" } }
}
```
- Negative variant(s): N/A

## TV-ARCH-003-P
- Vector ID: TV-ARCH-003-P
- Description: Visibility is server-managed and set to shared after first grant.
- Input:
```json
{
  "mutation": {
    "resource": "collections",
    "version": 1,
    "operation": "share",
    "id": "col_1",
    "shareWith": { "principalId": "user:bob", "level": "editor" }
  },
  "initialRecord": { "id": "col_1", "visibility": null }
}
```
- Expected output:
```json
{ "ok": true, "result": { "record": { "id": "col_1", "visibility": "shared" } } }
```
- Negative variant(s): N/A

## TV-ARCH-003-N
- Vector ID: TV-ARCH-003-N
- Description: Client cannot write arbitrary visibility value.
- Input:
```json
{
  "mutation": {
    "resource": "collections",
    "version": 1,
    "operation": "merge",
    "id": "col_1",
    "record": { "visibility": "cross-shared" }
  }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "DFQL_VISIBILITY_INVALID", "message": "Invalid visibility value", "details": { "path": "record.visibility" } }
}
```
- Negative variant(s): N/A

## TV-ARCH-004-P
- Vector ID: TV-ARCH-004-P
- Description: Namespace mode and shared-with-me mode both use same tri-state visibility model.
- Input:
```json
{
  "queries": [
    { "resource": "docs", "version": 1, "operation": "find", "metadata": { "accessMode": "namespace" } },
    { "resource": "docs", "version": 1, "operation": "find", "metadata": { "accessMode": "sharedWithMe" } }
  ],
  "actorId": "bob"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "namespace": [{ "id": "d1", "visibility": null }],
    "sharedWithMe": [{ "id": "d9", "visibility": "shared", "__ns": "user:alice" }]
  }
}
```
- Negative variant(s): N/A

## TV-ARCH-004-N
- Vector ID: TV-ARCH-004-N
- Description: Unsupported visibility token cross-shared is rejected at schema validation.
- Input:
```json
{
  "schema": {
    "resources": [
      {
        "name": "docs",
        "version": 1,
        "capabilities": [{ "shareable": { "visibilityDefault": "cross-shared", "levels": ["viewer"], "crossNsShareable": true } }],
        "fields": [{ "name": "title", "type": "string", "required": true }]
      }
    ]
  }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "INVALID_CAPABILITY_CONFIG", "message": "Invalid visibility default", "details": { "path": "resources.capabilities" } }
}
```
- Negative variant(s): N/A

## TV-ARCH-005-P
- Vector ID: TV-ARCH-005-P
- Description: Principal IDs are opaque and accepted with type prefixes.
- Input:
```json
{
  "mutation": {
    "resource": "goals",
    "version": 1,
    "operation": "share",
    "id": "goal_1",
    "shareWith": { "principalId": "team:engineering", "level": "viewer" }
  },
  "actorId": "user:owner"
}
```
- Expected output:
```json
{ "ok": true, "result": { "grantedTo": "team:engineering" } }
```
- Negative variant(s): N/A

## TV-ARCH-005-N
- Vector ID: TV-ARCH-005-N
- Description: Empty principalId is rejected.
- Input:
```json
{
  "mutation": {
    "resource": "goals",
    "version": 1,
    "operation": "share",
    "id": "goal_1",
    "shareWith": { "principalId": "", "level": "viewer" }
  }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "DFQL_PRINCIPAL_INVALID", "message": "principalId must be non-empty string", "details": { "path": "shareWith.principalId" } }
}
```
- Negative variant(s): N/A

## TV-ARCH-006-P
- Vector ID: TV-ARCH-006-P
- Description: Effective principals include hierarchy parents after cache resolution.
- Input:
```json
{
  "actorId": "bob",
  "memberships": ["project:atlas"],
  "hierarchy": [
    { "principalId": "project:atlas", "parentPrincipalId": "org:acme" }
  ],
  "permission": { "resourceId": "obj_1", "principalId": "org:acme", "level": "viewer" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "effectiveLevel": "viewer", "effectivePrincipals": ["project:atlas", "org:acme", "user:bob"] } }
```
- Negative variant(s): N/A

## TV-ARCH-006-N
- Vector ID: TV-ARCH-006-N
- Description: Hierarchy cycle triggers deterministic error.
- Input:
```json
{
  "actorId": "bob",
  "memberships": ["team:a"],
  "hierarchy": [
    { "principalId": "team:a", "parentPrincipalId": "team:b" },
    { "principalId": "team:b", "parentPrincipalId": "team:a" }
  ]
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "DFQL_INVALID", "message": "Principal hierarchy cycle detected", "details": { "path": "__datafn_principal_hierarchy" } }
}
```
- Negative variant(s): N/A

## TV-API-001-P
- Vector ID: TV-API-001-P
- Description: Legacy userId share payload canonicalizes to principalId.
- Input:
```json
{
  "mutation": {
    "resource": "notes",
    "version": 1,
    "operation": "share",
    "id": "note_1",
    "shareWith": { "userId": "bob", "level": "editor" }
  }
}
```
- Expected output:
```json
{ "ok": true, "result": { "canonical": { "shareWith": { "principalId": "user:bob", "level": "editor" } } } }
```
- Negative variant(s): N/A

## TV-API-001-N
- Vector ID: TV-API-001-N
- Description: shareWith object lacking userId and principalId fails.
- Input:
```json
{
  "mutation": { "resource": "notes", "version": 1, "operation": "share", "id": "note_1", "shareWith": { "level": "viewer" } }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "DFQL_PRINCIPAL_INVALID", "message": "Either shareWith.userId or shareWith.principalId is required", "details": { "path": "shareWith" } }
}
```
- Negative variant(s): N/A

## TV-API-002-P
- Vector ID: TV-API-002-P
- Description: Scope-level share grants access to current and future records.
- Input:
```json
{
  "mutations": [
    {
      "resource": "cycleLogs",
      "version": 1,
      "operation": "share",
      "scope": "resource",
      "shareWith": { "principalId": "user:partner", "level": "viewer" }
    },
    {
      "resource": "cycleLogs",
      "version": 1,
      "operation": "insert",
      "id": "cycle_2026_03",
      "record": { "day": 3 }
    }
  ],
  "queryActor": "partner"
}
```
- Expected output:
```json
{ "ok": true, "result": { "visibleToPartner": ["cycle_2026_03"] } }
```
- Negative variant(s): N/A

## TV-API-002-N
- Vector ID: TV-API-002-N
- Description: Scope share with record id present fails validation.
- Input:
```json
{
  "mutation": {
    "resource": "cycleLogs",
    "version": 1,
    "operation": "share",
    "scope": "resource",
    "id": "cycle_1",
    "shareWith": { "principalId": "user:partner", "level": "viewer" }
  }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "DFQL_SHARE_SCOPE_INVALID", "message": "resource scope share must omit id", "details": { "path": "id" } }
}
```
- Negative variant(s): N/A

## TV-API-003-P
- Vector ID: TV-API-003-P
- Description: Shared-with-me query returns rows from multiple namespaces.
- Input:
```json
{
  "query": {
    "resource": "collections",
    "version": 1,
    "operation": "find",
    "metadata": { "accessMode": "sharedWithMe", "namespaceFilter": ["user:alice", "org:acme"] }
  },
  "actorId": "bob"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": [
    { "id": "col_trip", "__ns": "user:alice" },
    { "id": "col_plan", "__ns": "org:acme" }
  ]
}
```
- Negative variant(s): N/A

## TV-API-003-N
- Vector ID: TV-API-003-N
- Description: Namespace mode does not leak cross-namespace shared rows.
- Input:
```json
{
  "query": {
    "resource": "collections",
    "version": 1,
    "operation": "find",
    "metadata": { "accessMode": "namespace" }
  },
  "namespace": "user:bob",
  "actorId": "bob"
}
```
- Expected output:
```json
{ "ok": true, "result": [] }
```
- Negative variant(s): N/A

## TV-API-004-P
- Vector ID: TV-API-004-P
- Description: Owner can inspect direct/scope/inherited grants.
- Input:
```json
{
  "query": { "resource": "accounts", "version": 1, "operation": "getPermissions", "id": "acct_1" },
  "actorId": "alice"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": [
    { "principalId": "user:bob", "level": "editor", "grantKind": "record" },
    { "principalId": "team:home", "level": "viewer", "grantKind": "scope" },
    { "principalId": "user:charlie", "level": "viewer", "grantKind": "relation_inherited", "sourceRef": "household:hh_1" }
  ]
}
```
- Negative variant(s): N/A

## TV-API-004-N
- Vector ID: TV-API-004-N
- Description: Non-owner permission inspection denied.
- Input:
```json
{
  "query": { "resource": "accounts", "version": 1, "operation": "getPermissions", "id": "acct_1" },
  "actorId": "bob"
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Authorization denied", "details": { "path": "operation" } } }
```
- Negative variant(s): N/A

## TV-AUTH-001-P
- Vector ID: TV-AUTH-001-P
- Description: Actor is present in mutation, transact, push, pull handlers.
- Input:
```json
{ "actorId": "bob", "run": ["mutation", "transact", "push", "pull", "clone", "reconcile"] }
```
- Expected output:
```json
{ "ok": true, "result": { "actorObservedInAll": true } }
```
- Negative variant(s): N/A

## TV-AUTH-001-N
- Vector ID: TV-AUTH-001-N
- Description: Missing actor on private shareable push is denied.
- Input:
```json
{
  "endpoint": "push",
  "actorId": null,
  "mutation": { "resource": "notes", "version": 1, "operation": "merge", "id": "note_1", "record": { "title": "x" } },
  "resourceConfig": { "shareable": { "visibilityDefault": "private", "levels": ["viewer", "editor", "owner"] } }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Actor required for private shareable operation", "details": { "path": "operation" } } }
```
- Negative variant(s): N/A

## TV-AUTH-002-P
- Vector ID: TV-AUTH-002-P
- Description: Push and mutation parity for editor merge operation.
- Input:
```json
{
  "actorId": "bob",
  "grant": { "resource": "notes", "id": "note_1", "principalId": "user:bob", "level": "editor" },
  "operations": [
    { "endpoint": "mutation", "operation": "merge", "id": "note_1", "record": { "title": "m1" } },
    { "endpoint": "push", "operation": "merge", "id": "note_1", "record": { "title": "m1" } }
  ]
}
```
- Expected output:
```json
{ "ok": true, "result": { "mutationAllowed": true, "pushAllowed": true } }
```
- Negative variant(s): N/A

## TV-AUTH-002-N
- Vector ID: TV-AUTH-002-N
- Description: Viewer delete denied on both mutation and push.
- Input:
```json
{
  "actorId": "bob",
  "grant": { "resource": "notes", "id": "note_1", "principalId": "user:bob", "level": "viewer" },
  "operations": [
    { "endpoint": "mutation", "operation": "delete", "id": "note_1" },
    { "endpoint": "push", "operation": "delete", "id": "note_1" }
  ]
}
```
- Expected output:
```json
{
  "ok": false,
  "error": { "code": "FORBIDDEN", "message": "Authorization denied", "details": { "path": "operation" } }
}
```
- Negative variant(s): N/A

## TV-AUTH-003-P
- Vector ID: TV-AUTH-003-P
- Description: Transaction with allowed edits succeeds and matches standalone sequence.
- Input:
```json
{
  "actorId": "owner",
  "transact": [
    { "resource": "notes", "version": 1, "operation": "merge", "id": "note_1", "record": { "title": "A" } },
    { "resource": "notes", "version": 1, "operation": "share", "id": "note_1", "shareWith": { "principalId": "user:bob", "level": "viewer" } }
  ]
}
```
- Expected output:
```json
{ "ok": true, "result": { "transactOutcome": "matches-non-transactional" } }
```
- Negative variant(s): N/A

## TV-AUTH-003-N
- Vector ID: TV-AUTH-003-N
- Description: Transaction aborts when second step forbidden and does not commit partial state.
- Input:
```json
{
  "actorId": "editor",
  "transact": [
    { "resource": "notes", "version": 1, "operation": "merge", "id": "note_1", "record": { "title": "B" } },
    { "resource": "notes", "version": 1, "operation": "share", "id": "note_1", "shareWith": { "principalId": "user:x", "level": "viewer" } }
  ]
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Authorization denied", "details": { "path": "[1].operation" } } }
```
- Negative variant(s): N/A

## TV-AUTH-004-P
- Vector ID: TV-AUTH-004-P
- Description: Pull returns only actor-visible rows for private shareable records.
- Input:
```json
{
  "actorId": "bob",
  "namespace": "org:acme",
  "pull": { "clientId": "c1", "cursors": { "notes": "0" } }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "changes": [
      { "resource": "notes", "id": "note_bob_visible", "op": "upsert" }
    ],
    "excludedIds": ["note_alice_private"]
  }
}
```
- Negative variant(s): N/A

## TV-AUTH-004-N
- Vector ID: TV-AUTH-004-N
- Description: Clone leak check ensures inaccessible row is absent.
- Input:
```json
{
  "actorId": "bob",
  "namespace": "org:acme",
  "clone": { "resources": ["notes"] }
}
```
- Expected output:
```json
{ "ok": true, "result": { "notes": [{ "id": "note_bob_visible" }], "mustNotContain": ["note_alice_private"] } }
```
- Negative variant(s): N/A

## TV-AUTH-005-P
- Vector ID: TV-AUTH-005-P
- Description: Relation expansion returns authorized child fields only.
- Input:
```json
{
  "query": {
    "resource": "collections",
    "version": 1,
    "operation": "find",
    "select": ["id", "items.id", "items.title"],
    "filters": { "id": "col_1" }
  },
  "actorId": "bob"
}
```
- Expected output:
```json
{ "ok": true, "result": [{ "id": "col_1", "items": [{ "id": "n1", "title": "allowed" }] }] }
```
- Negative variant(s): N/A

## TV-AUTH-005-N
- Vector ID: TV-AUTH-005-N
- Description: Unauthorized child field access is rejected.
- Input:
```json
{
  "query": {
    "resource": "collections",
    "version": 1,
    "operation": "find",
    "select": ["id", "items.secretField"],
    "filters": { "id": "col_1" }
  },
  "actorId": "bob"
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Read access denied", "details": { "path": "select[1]" } } }
```
- Negative variant(s): N/A

## TV-AUTH-006-P
- Vector ID: TV-AUTH-006-P
- Description: ownerField runtime check allows owner write.
- Input:
```json
{
  "resource": "objectives",
  "permissions": { "ownerField": "ownerId" },
  "record": { "id": "obj_1", "ownerId": "alice" },
  "actorId": "alice",
  "mutation": { "operation": "merge", "id": "obj_1", "record": { "title": "x" } }
}
```
- Expected output:
```json
{ "ok": true, "result": { "updated": true } }
```
- Negative variant(s): N/A

## TV-AUTH-006-N
- Vector ID: TV-AUTH-006-N
- Description: ownerField denies non-owner write.
- Input:
```json
{
  "resource": "objectives",
  "permissions": { "ownerField": "ownerId" },
  "record": { "id": "obj_1", "ownerId": "alice" },
  "actorId": "bob",
  "mutation": { "operation": "merge", "id": "obj_1", "record": { "title": "x" } }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Authorization denied", "details": { "path": "operation" } } }
```
- Negative variant(s): N/A

## TV-REL-001-P
- Vector ID: TV-REL-001-P
- Description: Parent share grants inherited child visibility.
- Input:
```json
{
  "parent": { "resource": "collections", "id": "col_1" },
  "child": { "resource": "notes", "id": "note_1" },
  "relationInheritance": true,
  "grant": { "principalId": "user:bob", "level": "viewer" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "bobCanReadChild": true, "grantKind": "relation_inherited" } }
```
- Negative variant(s): N/A

## TV-REL-001-N
- Vector ID: TV-REL-001-N
- Description: Inherited access disappears after parent unshare.
- Input:
```json
{
  "unshare": { "resource": "collections", "id": "col_1", "shareWith": { "principalId": "user:bob" } },
  "query": { "resource": "notes", "version": 1, "operation": "find", "filters": { "id": "note_1" } },
  "actorId": "bob"
}
```
- Expected output:
```json
{ "ok": true, "result": [] }
```
- Negative variant(s): N/A

## TV-REL-002-P
- Vector ID: TV-REL-002-P
- Description: Relate into shared parent succeeds with editor permission and consent flag.
- Input:
```json
{
  "actorId": "bob",
  "mutation": {
    "resource": "collections",
    "version": 1,
    "operation": "relate",
    "id": "col_1",
    "relations": { "items": [{ "$ref": "note_2", "consent": true }] }
  },
  "grant": { "resource": "collections", "id": "col_1", "principalId": "user:bob", "level": "editor" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "related": true } }
```
- Negative variant(s): N/A

## TV-REL-002-N
- Vector ID: TV-REL-002-N
- Description: Relate without required consent is rejected.
- Input:
```json
{
  "actorId": "bob",
  "mutation": {
    "resource": "collections",
    "version": 1,
    "operation": "relate",
    "id": "col_1",
    "relations": { "items": [{ "$ref": "note_2" }] }
  },
  "relationConfig": { "requireRelateConsent": true }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "DFQL_RELATION_INHERITANCE_FORBIDDEN", "message": "Relate consent required", "details": { "path": "relations.items[0].consent" } } }
```
- Negative variant(s): N/A

## TV-SYNC-001-P
- Vector ID: TV-SYNC-001-P
- Description: Unshare emits revoke tombstone in pull.
- Input:
```json
{
  "timeline": [
    { "seq": 10, "op": "share", "id": "note_1", "principalId": "user:bob" },
    { "seq": 11, "op": "unshare", "id": "note_1", "principalId": "user:bob" }
  ],
  "pull": { "actorId": "bob", "cursor": "10" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "changes": [{ "resource": "notes", "id": "note_1", "op": "delete", "reason": "revoked" }], "nextCursor": "11" } }
```
- Negative variant(s): N/A

## TV-SYNC-001-N
- Vector ID: TV-SYNC-001-N
- Description: Missing tombstone on revoke fails invariant check.
- Input:
```json
{
  "timeline": [
    { "seq": 10, "op": "share", "id": "note_1", "principalId": "user:bob" },
    { "seq": 11, "op": "unshare", "id": "note_1", "principalId": "user:bob" }
  ],
  "pullImplementation": { "emitsTombstones": false }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "DFQL_REVOKE_TOMBSTONE_REQUIRED", "message": "Revoke requires tombstone emission", "details": { "path": "pull" } } }
```
- Negative variant(s): N/A

## TV-SYNC-002-P
- Vector ID: TV-SYNC-002-P
- Description: Grant backfill reveals historical row after new grant.
- Input:
```json
{
  "history": [
    { "seq": 1, "op": "insert", "resource": "notes", "id": "old_1" },
    { "seq": 20, "op": "share", "resource": "notes", "id": "old_1", "principalId": "user:bob" }
  ],
  "pull": { "actorId": "bob", "cursor": "19" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "changes": [{ "resource": "notes", "id": "old_1", "op": "upsert", "reason": "grant_backfill" }] } }
```
- Negative variant(s): N/A

## TV-SYNC-002-N
- Vector ID: TV-SYNC-002-N
- Description: Duplicate backfill event does not duplicate local data.
- Input:
```json
{
  "localState": [{ "resource": "notes", "id": "old_1" }],
  "changes": [
    { "resource": "notes", "id": "old_1", "op": "upsert", "reason": "grant_backfill" },
    { "resource": "notes", "id": "old_1", "op": "upsert", "reason": "grant_backfill" }
  ]
}
```
- Expected output:
```json
{ "ok": true, "result": { "rowCount": 1 } }
```
- Negative variant(s): N/A

## TV-SYNC-003-P
- Vector ID: TV-SYNC-003-P
- Description: Cursor and apply are deterministic under grant/revoke churn.
- Input:
```json
{
  "changes": [
    { "serverSeq": 100, "resource": "notes", "id": "n1", "op": "upsert" },
    { "serverSeq": 101, "resource": "notes", "id": "n1", "op": "delete" }
  ],
  "applyTwice": true
}
```
- Expected output:
```json
{ "ok": true, "result": { "finalRows": [], "cursor": "101", "deterministic": true } }
```
- Negative variant(s): N/A

## TV-SYNC-003-N
- Vector ID: TV-SYNC-003-N
- Description: Non-monotonic cursor advancement is rejected.
- Input:
```json
{
  "currentCursor": "101",
  "incoming": { "nextCursor": "99", "changes": [] }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "CONFLICT", "message": "Non-monotonic cursor", "details": { "path": "nextCursor" } } }
```
- Negative variant(s): N/A

## TV-SYNC-004-P
- Vector ID: TV-SYNC-004-P
- Description: Actor feed includes membership change that grants visibility.
- Input:
```json
{
  "actor": "bob",
  "membershipChange": { "principalId": "team:fin", "op": "add", "seq": 201 },
  "resourceGrant": { "resource": "accounts", "resourceNs": "org:acme", "principalId": "team:fin", "level": "viewer" },
  "pull": { "cursor": "200" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "actorFeed": [{ "type": "membership_added", "principalId": "team:fin" }], "visibilityChanged": true } }
```
- Negative variant(s): N/A

## TV-SYNC-004-N
- Vector ID: TV-SYNC-004-N
- Description: Actor feed must not include unrelated principal updates.
- Input:
```json
{
  "actor": "bob",
  "unrelatedChange": { "principalId": "team:secret", "member": "mallory", "seq": 301 },
  "pull": { "cursor": "300" }
}
```
- Expected output:
```json
{ "ok": true, "result": { "actorFeed": [] } }
```
- Negative variant(s): N/A

## TV-PERF-001-P
- Vector ID: TV-PERF-001-P
- Description: Query plan uses permission indexes for shared-with-me lookup.
- Input:
```json
{
  "sql": "EXPLAIN SELECT ... FROM __datafn_permissions_global WHERE principalId='user:bob'",
  "indexes": ["idx_perm_principal", "idx_perm_resource_ns_principal"]
}
```
- Expected output:
```json
{ "ok": true, "result": { "usesIndex": true } }
```
- Negative variant(s): N/A

## TV-PERF-001-N
- Vector ID: TV-PERF-001-N
- Description: Missing index triggers performance guard failure.
- Input:
```json
{
  "sql": "EXPLAIN SELECT ... FROM __datafn_permissions_global WHERE principalId='user:bob'",
  "indexes": []
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "INTERNAL", "message": "Required ACL index missing", "details": { "path": "db.indexes" } } }
```
- Negative variant(s): N/A

## TV-PERF-002-P
- Vector ID: TV-PERF-002-P
- Description: Pull merge remains bounded under multi-resource high change volume.
- Input:
```json
{
  "resources": 12,
  "changesPerResource": 50000,
  "pullAlgo": "k-way-merge",
  "memoryCapMb": 256
}
```
- Expected output:
```json
{ "ok": true, "result": { "peakMemoryMb": 256, "ordered": true } }
```
- Negative variant(s): N/A

## TV-PERF-002-N
- Vector ID: TV-PERF-002-N
- Description: Flatten+sort implementation exceeds memory cap and fails.
- Input:
```json
{
  "resources": 12,
  "changesPerResource": 50000,
  "pullAlgo": "flatten-sort",
  "memoryCapMb": 256
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "LIMIT_EXCEEDED", "message": "Pull assembly memory cap exceeded", "details": { "path": "pull" } } }
```
- Negative variant(s): N/A

## TV-PERF-003-P
- Vector ID: TV-PERF-003-P
- Description: Actor-targeted WS invalidation wakes only affected clients.
- Input:
```json
{
  "change": { "resource": "notes", "id": "n1", "affectedPrincipals": ["user:bob"] },
  "clients": ["alice", "bob", "charlie"]
}
```
- Expected output:
```json
{ "ok": true, "result": { "wokenClients": ["bob"] } }
```
- Negative variant(s): N/A

## TV-PERF-003-N
- Vector ID: TV-PERF-003-N
- Description: Fallback namespace broadcast is allowed but marked degraded.
- Input:
```json
{
  "change": { "namespace": "org:acme" },
  "wsMode": "namespace-broadcast"
}
```
- Expected output:
```json
{ "ok": true, "result": { "wokenClients": "all-in-namespace", "degraded": true } }
```
- Negative variant(s): N/A

## TV-COMP-001-P
- Vector ID: TV-COMP-001-P
- Description: v1 grants migrate to v2 global grants with equivalent access.
- Input:
```json
{
  "v1Rows": [
    { "table": "__datafn_permissions_notes", "__ns": "user:alice", "resourceId": "n1", "userId": "bob", "level": "viewer" }
  ],
  "migration": "run"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "v2Rows": [
      { "resourceType": "notes", "resourceNs": "user:alice", "resourceId": "n1", "principalId": "user:bob", "level": "viewer" }
    ],
    "equivalentAccess": true
  }
}
```
- Negative variant(s): N/A

## TV-COMP-001-N
- Vector ID: TV-COMP-001-N
- Description: Migration refuses duplicate conflicting grants.
- Input:
```json
{
  "v1Rows": [
    { "resourceId": "n1", "userId": "bob", "level": "viewer" },
    { "resourceId": "n1", "userId": "bob", "level": "owner" }
  ]
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "CONFLICT", "message": "Conflicting duplicate grants", "details": { "path": "migration.v1Rows" } } }
```
- Negative variant(s): N/A

## TV-COMP-002-P
- Vector ID: TV-COMP-002-P
- Description: Legacy table API still works with SPV2 backend.
- Input:
```json
{
  "clientCall": "table('notes').share('n1','bob','viewer')",
  "sdkVersion": "compatible"
}
```
- Expected output:
```json
{ "ok": true, "result": { "canonicalPrincipalId": "user:bob" } }
```
- Negative variant(s): N/A

## TV-COMP-002-N
- Vector ID: TV-COMP-002-N
- Description: Invalid legacy level still fails with deterministic validation.
- Input:
```json
{
  "clientCall": "table('notes').share('n1','bob','admin')"
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "DFQL_INVALID", "message": "Invalid DFQL: shareWith.level must be one of [viewer, editor, owner]", "details": { "path": "shareWith.level" } } }
```
- Negative variant(s): N/A

## TV-PY-001-P
- Vector ID: TV-PY-001-P
- Description: Python and TS deny/allow matrix matches for share operations.
- Input:
```json
{
  "cases": [
    { "actor": "owner", "operation": "share", "expect": "allow" },
    { "actor": "viewer", "operation": "share", "expect": "deny" }
  ],
  "compare": ["ts", "py"]
}
```
- Expected output:
```json
{ "ok": true, "result": { "parity": true } }
```
- Negative variant(s): N/A

## TV-PY-001-N
- Vector ID: TV-PY-001-N
- Description: Python allow-by-default behavior is rejected by conformance suite.
- Input:
```json
{
  "pyBehavior": { "missingPermissions": "allow" },
  "case": { "actor": "eve", "operation": "merge", "resource": "privateNotes" }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Python parity violation", "details": { "path": "python.authz" } } }
```
- Negative variant(s): N/A

## TV-SEC-001-P
- Vector ID: TV-SEC-001-P
- Description: Security logs redact sensitive fields while preserving audit metadata.
- Input:
```json
{
  "mutation": {
    "resource": "cycleLogs",
    "operation": "insert",
    "record": { "symptoms": "private", "mood": "private" }
  },
  "logging": "enabled"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "logEntry": {
      "resource": "cycleLogs",
      "operation": "insert",
      "record": "[REDACTED]"
    }
  }
}
```
- Negative variant(s): N/A

## TV-SEC-001-N
- Vector ID: TV-SEC-001-N
- Description: Plaintext sensitive payload in logs fails policy check.
- Input:
```json
{
  "observedLog": { "resource": "cycleLogs", "record": { "symptoms": "private detail" } }
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "INTERNAL", "message": "Sensitive payload leakage in logs", "details": { "path": "logs.record" } } }
```
- Negative variant(s): N/A

## TV-USE-001-P
- Vector ID: TV-USE-001-P
- Description: Use-case matrix validates canonical pattern for all listed domains.
- Input:
```json
{
  "domains": ["Collections", "Memotron", "Selftron", "Pointron", "Finatron", "Feedtron", "Compoundum"],
  "patternCheck": "namespace+visibility+grant+sync"
}
```
- Expected output:
```json
{ "ok": true, "result": { "allDomainsMapped": true } }
```
- Negative variant(s): N/A

## TV-USE-001-N
- Vector ID: TV-USE-001-N
- Description: Missing pattern for one listed domain fails conformance.
- Input:
```json
{
  "domains": ["Collections", "Memotron", "Selftron", "Pointron", "Finatron", "Feedtron", "Compoundum"],
  "missing": ["Finatron"]
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "INTERNAL", "message": "Use-case mapping incomplete", "details": { "path": "domains.Finatron" } } }
```
- Negative variant(s): N/A

## TV-DOC-001-P
- Vector ID: TV-DOC-001-P
- Description: Docs include beginner-friendly explanation and offline revoke/grant walkthrough.
- Input:
```json
{
  "docs": ["sharing-v2.mdx", "sync-sharing.mdx"],
  "check": ["glossary", "examples", "forbidden examples", "offline revoke flow"]
}
```
- Expected output:
```json
{ "ok": true, "result": { "coverage": "complete" } }
```
- Negative variant(s): N/A

## TV-DOC-001-N
- Vector ID: TV-DOC-001-N
- Description: Docs use unexplained abbreviations and fail readability gate.
- Input:
```json
{
  "docs": ["sharing-v2.mdx"],
  "contains": ["ACL", "RLS"],
  "definitions": []
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "INTERNAL", "message": "Documentation clarity gate failed", "details": { "path": "docs.glossary" } } }
```
- Negative variant(s): N/A

## TV-TEST-001-P
- Vector ID: TV-TEST-001-P
- Description: Conformance suite passes all P0 vectors and produces report.
- Input:
```json
{
  "run": "conformance",
  "requiredPriority": "P0"
}
```
- Expected output:
```json
{ "ok": true, "result": { "report": { "p0Passed": true, "reportPath": ".conduct/reports/spv2-conformance.json" } } }
```
- Negative variant(s): N/A

## TV-TEST-001-N
- Vector ID: TV-TEST-001-N
- Description: Release gate blocks when any P0 vector fails.
- Input:
```json
{
  "run": "conformance",
  "failedVectors": ["TV-AUTH-002-N"],
  "requiredPriority": "P0"
}
```
- Expected output:
```json
{ "ok": false, "error": { "code": "CONFLICT", "message": "Release blocked: P0 conformance failed", "details": { "path": "conformance" } } }
```
- Negative variant(s): N/A
