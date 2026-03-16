# TV-ARCH-001
- Description: Repository layout proves the sharing demo is a separate example app.
- Input:
  - Inspect `datafn/examples/`.
- Expected output:
  - `datafn/examples/sharing-app/README.md` exists.
  - `datafn/examples/sharing-app/client/package.json` exists.
  - `datafn/examples/sharing-app/server/package.json` exists.
- Negative variant(s):
  - If share demo implementation files exist only under `datafn/examples/todo-app`, the vector fails.

# TV-SCHEMA-001
- Description: Example server schema is minimal and share-focused.
- Input:
  - Read `datafn/examples/sharing-app/server/src/schema.datafn.ts`.
- Expected output:
  - A single `documents` resource is present.
  - `documents` uses `timestamps`, `audit`, and `shareable`.
  - `shareable.visibilityDefault` is `private`.
  - `shareable.crossNsShareable` is `false`.
- Negative variant(s):
  - If the schema omits `shareable` or sets `crossNsShareable: true`, the vector fails.

# TV-AUTH-001
- Description: Valid demo identity resolves to deterministic server context.
- Input:
```http
GET /demo/context
x-demo-workspace-id: acme
x-demo-user-id: user:alice
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "workspaceId": "acme",
    "namespace": "org:acme",
    "actorId": "user:alice",
    "effectivePrincipals": ["team:design", "user:alice"]
  }
}
```
- Negative variant(s):
  - `x-demo-user-id: user:mallory` returns `DEMO_IDENTITY_INVALID`.

# TV-AUTH-002
- Description: Missing or malformed demo identity is rejected before business actions run.
- Input:
```http
POST /datafn/query
x-demo-workspace-id: acme
Content-Type: application/json

{ "resource": "documents", "version": 1 }
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "DEMO_IDENTITY_INVALID",
    "message": "Invalid demo identity"
  }
}
```
- Negative variant(s):
  - `x-demo-workspace-id: unknown` also returns `DEMO_IDENTITY_INVALID`.

# TV-BOOT-001
- Description: Bootstrap metadata is static and sorted.
- Input:
```http
GET /demo/bootstrap
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "defaultWorkspaceId": "acme",
    "defaultUserId": "user:alice",
    "workspaces": [
      {
        "id": "acme",
        "namespace": "org:acme",
        "users": ["user:alice", "user:bob", "user:charlie"]
      },
      {
        "id": "globex",
        "namespace": "org:globex",
        "users": ["user:alice", "user:bob", "user:charlie"]
      }
    ]
  }
}
```
- Negative variant(s):
  - If the workspace list ordering changes nondeterministically between calls, the vector fails.

# TV-CTX-001
- Description: Membership resolution differs by namespace.
- Input:
```http
GET /demo/context
x-demo-workspace-id: globex
x-demo-user-id: user:alice
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "workspaceId": "globex",
    "namespace": "org:globex",
    "actorId": "user:alice",
    "effectivePrincipals": ["user:alice"]
  }
}
```
- Negative variant(s):
  - If `team:design` appears for `user:alice` in `globex`, the vector fails because it leaks `acme` membership assumptions.

# TV-RESET-001
- Description: Reset reseeds the baseline scenario deterministically.
- Input:
```http
POST /demo/reset
Content-Type: application/json

{ "scenario": "baseline" }
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "scenario": "baseline",
    "documentCounts": {
      "org:acme": 2,
      "org:globex": 1
    },
    "membershipCounts": {
      "org:acme": 2,
      "org:globex": 2
    }
  }
}
```
- Negative variant(s):
  - `{ "scenario": "custom" }` returns `DEMO_RESET_FAILED` or a deterministic validation failure.

# TV-DOC-001
- Description: Permitted actor can create a private document through the example UI.
- Input:
  - Reset baseline.
  - Open the client as `acme / user:alice`.
  - Create document title `Quarterly Notes`, content `Draft`.
- Expected output:
  - The visible document list contains `Quarterly Notes`.
  - The selected document shows owner `user:alice`.
  - The permissions inspector shows no additional grants.
- Negative variant(s):
  - If the create flow writes only to local UI state and the document disappears on reload/pull, the vector fails.

# TV-DOC-002
- Description: Viewer cannot edit a record.
- Input:
  - Alice shares `Quarterly Notes` to `user:bob` as `viewer`.
  - Bob opens the document and attempts to save edited content.
- Expected output:
  - The save attempt fails.
  - The UI surfaces `FORBIDDEN`.
  - The stored content remains unchanged after reload.
- Negative variant(s):
  - If Bob can save the edit successfully under viewer access, the vector fails.

# TV-SHARE-001
- Description: Record-level share grants read access to the grantee.
- Input:
  - Alice shares `doc:acme-private-alice` to `user:bob` as `viewer`.
- Expected output:
  - Bob sees the document in `acme`.
  - `getPermissions(id)` shows `user:bob -> viewer`.
  - Bob cannot see the document in `globex`.
- Negative variant(s):
  - Sharing to an empty principal or invalid principal returns `DFQL_PRINCIPAL_INVALID`.

# TV-SHARE-002
- Description: Editor upgrade enables merge but not owner-only actions.
- Input:
  - Alice upgrades Bob’s grant on `doc:acme-private-alice` from `viewer` to `editor`.
  - Bob edits the content and then tries to share the document to `user:charlie`.
- Expected output:
  - The content edit succeeds.
  - The permission inspector shows `user:bob -> editor`.
  - The share attempt fails with `FORBIDDEN`.
- Negative variant(s):
  - If the grant remains `viewer` after upgrade or if Bob can reshare as editor, the vector fails.

# TV-SHARE-003
- Description: Unshare removes access and permission rows.
- Input:
  - Alice unshares `doc:acme-private-alice` from Bob.
- Expected output:
  - Bob no longer sees the document in `acme`.
  - `getPermissions(id)` no longer lists Bob.
  - A repeated unshare does not create duplicate side effects.
- Negative variant(s):
  - If Bob still sees the document after a pull or reload, the vector fails.

# TV-SHARE-004
- Description: Resource-scope grant to `team:design` uses memberships in the current namespace.
- Input:
  - In `acme`, Alice applies a resource-scope viewer grant for `team:design`.
  - Bob and Charlie each refresh the visible list in `acme`.
- Expected output:
  - Bob gains visibility to documents covered by the scope grant.
  - Charlie does not gain visibility because he is not in `team:design` for `acme`.
  - The permission inspector or scope panel shows the active team grant.
- Negative variant(s):
  - If Charlie gains access in `acme` without membership, the vector fails.

# TV-SHARE-005
- Description: Cross-workspace share attempt is denied.
- Input:
  - In `acme`, Alice attempts to share a document to a principal selection explicitly marked as out-of-workspace for `globex`.
- Expected output:
  - The action fails with a deterministic error.
  - The document remains visible only in `acme`.
  - No new permission row appears for the rejected grant.
- Negative variant(s):
  - If the grant succeeds or causes the record to appear in `globex`, the vector fails.

# TV-ISO-001
- Description: Workspace switching changes visible records without leaking data.
- Input:
  - Open the client as `user:bob`.
  - View documents in `acme`, then switch to `globex`.
- Expected output:
  - `acme` view shows `doc:acme-team-brief` and no `globex` private docs.
  - `globex` view shows `doc:globex-private-bob` and no `acme` docs.
  - The context panel namespace changes from `org:acme` to `org:globex`.
- Negative variant(s):
  - If records from `acme` remain visible after switching to `globex`, the vector fails.

# TV-UI-001
- Description: Persona switcher updates local and server context.
- Input:
  - In one browser tab, switch from `acme/user:alice` to `acme/user:bob`.
- Expected output:
  - The context panel updates actor and effective principals.
  - The visible document list updates to Bob’s authorized view.
  - The client local namespace changes to `demo:acme:user:bob`.
- Negative variant(s):
  - If the UI label changes but subsequent server requests still resolve as Alice, the vector fails.

# TV-SYNC-001
- Description: Grant backfill reaches a second browser context.
- Input:
  - Context A: Alice in `acme` creates a document.
  - Context B: Bob in `acme` stays open with sync enabled.
  - Alice shares the document to Bob as `viewer`.
  - Bob triggers pull or waits for the documented sync action.
- Expected output:
  - Bob receives the existing document after the grant.
  - Bob’s activity/status panel reports a sync success.
  - The document content matches Alice’s original content.
- Negative variant(s):
  - If Bob never receives the document after pull, the vector fails.

# TV-SYNC-002
- Description: Revoke tombstone removes a shared record from a second browser context.
- Input:
  - Continue from TV-SYNC-001.
  - Alice revokes Bob’s access.
  - Bob triggers pull or waits for the documented sync action.
- Expected output:
  - Bob’s visible document list removes the record.
  - The activity/status panel reports a sync-driven removal.
  - Reloading does not restore the revoked document.
- Negative variant(s):
  - If Bob retains the record locally after revoke and pull, the vector fails.

# TV-E2E-001
- Description: Playwright suite covers the main example behaviors with deterministic reset.
- Input:
  - Run the example’s documented Playwright command from `datafn/examples/sharing-app`.
- Expected output:
  - The suite runs without requiring PostgreSQL or other external services.
  - The suite includes tests for record share, grant upgrade, revoke, team scope grant, workspace isolation, and multi-context sync flows.
- Negative variant(s):
  - If the suite depends on manual pre-seeding or external infrastructure, the vector fails.

# TV-DOCS-001
- Description: README teaches the modeling decisions and run steps.
- Input:
  - Read `datafn/examples/sharing-app/README.md`.
- Expected output:
  - The README explains workspace -> namespace mapping.
  - The README explains actor vs principal.
  - The README includes run commands for server, client, reset, and Playwright.
  - The README includes at least one manual walkthrough sequence.
- Negative variant(s):
  - If the README only contains generic setup instructions and does not explain the model, the vector fails.
