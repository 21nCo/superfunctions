# Requirement Index
- EXAPP-001
- DATA-001
- AUTH-001
- AUTH-002
- AUTH-003
- API-001
- API-002
- UI-001
- UI-002
- UI-003
- SHARE-001
- SHARE-002
- SHARE-003
- ISO-001
- SYNC-001
- TEST-001
- DOC-001

## EXAPP-001
- ID: EXAPP-001
- Priority: P0
- Statement: The implementation MUST add a new dedicated example at `datafn/examples/sharing-app` instead of expanding `datafn/examples/todo-app` into the sharing demonstration.
- Rationale: The current todo example already teaches local-first sync/search flows; a focused sharing example keeps the teaching model clear and the E2E surface stable.
- Acceptance criteria:
  - A new example root exists at `datafn/examples/sharing-app`.
  - The new example has separate `client` and `server` directories plus an example-level README.
  - `datafn/examples/todo-app` does not become the implementation home for the new sharing flows.
- Test vectors: TV-ARCH-001
- Notes: Documentation cross-links from the todo app are allowed.

## DATA-001
- ID: DATA-001
- Priority: P0
- Statement: The example server MUST define a single `documents` resource using `timestamps`, `audit`, and `shareable` capabilities with `visibilityDefault: "private"` and `crossNsShareable: false`.
- Rationale: The example should teach one clear mental model with private-by-default collaboration inside a workspace.
- Acceptance criteria:
  - The schema includes one shareable `documents` resource with `viewer`, `editor`, and `owner` levels.
  - The schema denies positive cross-namespace sharing by configuration.
  - No second primary business resource is required to understand the example.
- Test vectors: TV-SCHEMA-001, TV-SHARE-005
- Notes: Helper/demo endpoints do not count as business resources.

## AUTH-001
- ID: AUTH-001
- Priority: P0
- Statement: The example server MUST derive namespace from the selected workspace and actor from the selected user on every protected request.
- Rationale: The example’s core teaching goal is the difference between workspace isolation and actor-specific authorization.
- Acceptance criteria:
  - `x-demo-workspace-id: acme` resolves to `org:acme`.
  - `x-demo-user-id: user:alice` resolves to `actorId = user:alice`.
  - Two users in `acme` share the same namespace but different actors.
  - Invalid or missing headers fail before hitting DataFn mutation/query handling.
- Test vectors: TV-AUTH-001, TV-AUTH-002
- Notes: The client may keep a different local namespace for browser storage; this requirement concerns server resolution.

## AUTH-002
- ID: AUTH-002
- Priority: P0
- Statement: The example server MUST seed deterministic principal memberships per workspace namespace and expose the resolved effective principals in `/demo/context`.
- Rationale: Consumers need to see how group membership affects access decisions without having to reverse-engineer internal tables.
- Acceptance criteria:
  - `org:acme` resolves `team:design` for Alice and Bob, but not Charlie.
  - `org:globex` uses its own membership set independent of `org:acme`.
  - `/demo/context` returns sorted `effectivePrincipals`.
  - The context output matches the permissions behavior seen in document access.
- Test vectors: TV-CTX-001, TV-SHARE-004, TV-ISO-001
- Notes: Principal IDs remain opaque strings; no principal type enum is required.

## AUTH-003
- ID: AUTH-003
- Priority: P0
- Statement: The browser client MUST carry the selected demo identity on every remote DataFn and `/demo/context` request and MUST switch local client context when workspace or actor changes.
- Rationale: The example must show both server-derived collaboration and per-person local offline isolation.
- Acceptance criteria:
  - Changing workspace or actor updates the effective remote identity immediately.
  - Changing workspace or actor switches the local DataFn client namespace to `demo:{workspaceId}:{userId}`.
  - Visible document results update without a full page reload.
  - Invalid identity selections cannot be sent from the UI.
- Test vectors: TV-UI-001, TV-AUTH-002
- Notes: The implementation may use a custom remote adapter or equivalent wrapper.

## API-001
- ID: API-001
- Priority: P0
- Statement: The example server MUST provide deterministic `/demo/bootstrap`, `/demo/context`, and `/demo/reset` endpoints using canonical `{ ok, result }` and `{ ok, error }` envelopes.
- Rationale: Manual walkthroughs and Playwright both need a stable control surface outside the core DataFn routes.
- Acceptance criteria:
  - `GET /demo/bootstrap` returns the known workspaces, users, and principal metadata.
  - `GET /demo/context` returns the resolved namespace, actor, and effective principals.
  - `POST /demo/reset` restores the same baseline scenario every time.
  - Failures return canonical codes and messages.
- Test vectors: TV-BOOT-001, TV-CTX-001, TV-RESET-001
- Notes: `baseline` is the only defined reset scenario.

## API-002
- ID: API-002
- Priority: P0
- Statement: The baseline reset scenario MUST seed the same memberships, documents, and grants on every reset call.
- Rationale: Deterministic fixtures are required for both local reasoning and end-to-end testing.
- Acceptance criteria:
  - `org:acme` contains `doc:acme-private-alice` and `doc:acme-team-brief`.
  - `org:globex` contains `doc:globex-private-bob`.
  - `doc:acme-team-brief` is granted to `team:design` as `viewer`.
  - Reset clears prior test-created documents and permissions before reseeding.
- Test vectors: TV-RESET-001, TV-ISO-001
- Notes: Additional demo-created records after reset are allowed until the next reset.

## UI-001
- ID: UI-001
- Priority: P0
- Statement: The client UI MUST show the currently selected workspace, namespace, actor, and effective principals in a dedicated context panel.
- Rationale: The app is primarily educational; the identity model must be visible, not implicit.
- Acceptance criteria:
  - The panel shows workspace ID, namespace string, actor ID, and sorted principal badges.
  - Switching workspace or actor updates the panel immediately after context refresh.
  - The panel distinguishes server namespace from local browser identity.
- Test vectors: TV-UI-001, TV-CTX-001
- Notes: The panel may include derived explanatory copy.

## UI-002
- ID: UI-002
- Priority: P0
- Statement: The client UI MUST allow creating, viewing, and editing documents using real DataFn queries and mutations instead of mock local state.
- Rationale: The example must model how consumers actually use DataFn in applications.
- Acceptance criteria:
  - A permitted actor can create a document and see it appear in the visible document list.
  - Visible document lists reflect only server-authorized records.
  - An actor without edit permission cannot save changes.
- Test vectors: TV-DOC-001, TV-DOC-002
- Notes: Document deletion MAY be present, but it is not required for core understanding.

## UI-003
- ID: UI-003
- Priority: P0
- Statement: The client UI MUST expose a permission inspector and share controls for both record-level and resource-level grants.
- Rationale: Consumers need to see how `share`, `unshare`, and `getPermissions` translate into UI behavior.
- Acceptance criteria:
  - The selected document shows current grants from `getPermissions(id)`.
  - The UI supports sharing a record to `user:*` and revoking it.
  - The UI supports applying a resource-level grant to `team:design`.
  - Permission changes are reflected in the inspector after success.
- Test vectors: TV-SHARE-001, TV-SHARE-003, TV-SHARE-004
- Notes: The UI may constrain share targets to the seeded principals list.

## SHARE-001
- ID: SHARE-001
- Priority: P0
- Statement: The example MUST demonstrate that a `viewer` grant allows read access but denies merge, delete, share, and unshare operations for the grantee.
- Rationale: Viewer semantics are a core part of understanding the capability.
- Acceptance criteria:
  - A viewer can see the shared document.
  - A viewer receives `FORBIDDEN` when attempting to edit.
  - A viewer receives `FORBIDDEN` when attempting owner-only actions.
- Test vectors: TV-SHARE-001, TV-DOC-002
- Notes: The UI may disable buttons preemptively, but the server denial must still be testable.

## SHARE-002
- ID: SHARE-002
- Priority: P0
- Statement: The example MUST demonstrate that upgrading a grant to `editor` enables content edits while still denying owner-only actions.
- Rationale: The example should show the behavioral difference between `viewer` and `editor`, not just the label change.
- Acceptance criteria:
  - After upgrade, the grantee can update document content successfully.
  - After upgrade, the grantee still cannot create or revoke grants on that document.
  - The permission inspector shows the upgraded level.
- Test vectors: TV-SHARE-002
- Notes: Owner-level delegation is not required for the example.

## SHARE-003
- ID: SHARE-003
- Priority: P0
- Statement: The example MUST demonstrate that unsharing removes grantee visibility and that the removal is reflected both in UI state and sync behavior.
- Rationale: Revoke safety is a primary requirement for collaborative offline-first systems.
- Acceptance criteria:
  - After unshare, the grantee no longer sees the document in the visible list.
  - The permission inspector no longer lists the revoked grant.
  - A second browser context receives revoke removal on pull.
- Test vectors: TV-SHARE-003, TV-SYNC-002
- Notes: Idempotent unshare success is acceptable.

## SHARE-004
- ID: SHARE-004
- Priority: P0
- Statement: The example MUST demonstrate resource-scope sharing to `team:design` and membership-based access in the current workspace namespace.
- Rationale: Team-oriented sharing is one of the key reasons to use principal-based sharing instead of user-only grants.
- Acceptance criteria:
  - Applying the scope grant grants visibility to actors whose effective principals include `team:design`.
  - Actors outside `team:design` in the same workspace do not gain visibility.
  - The effect is limited to the current workspace namespace.
- Test vectors: TV-SHARE-004, TV-ISO-001
- Notes: The example only needs one team principal to teach the concept.

## ISO-001
- ID: ISO-001
- Priority: P0
- Statement: The example MUST demonstrate workspace isolation by denying cross-workspace sharing and by preventing records from one workspace from appearing in another workspace.
- Rationale: Namespace resolution is one of the main design questions this example is meant to answer.
- Acceptance criteria:
  - `globex` users cannot see `acme` records without explicit same-namespace grants.
  - An attempted cross-workspace share fails deterministically.
  - The context panel and document list stay internally consistent with the selected workspace.
- Test vectors: TV-SHARE-005, TV-ISO-001
- Notes: Positive cross-namespace sharing is intentionally not part of this example.

## SYNC-001
- ID: SYNC-001
- Priority: P0
- Statement: The example MUST demonstrate pull-based grant backfill and revoke tombstone behavior across two browser contexts.
- Rationale: The app must act as a realistic end-to-end test target for sharing semantics, not just a single-tab demo.
- Acceptance criteria:
  - A newly granted actor receives a previously existing document after pull.
  - A revoked actor removes the document after pull.
  - The flows are automated in Playwright using two isolated browser contexts.
- Test vectors: TV-SYNC-001, TV-SYNC-002
- Notes: WebSocket live push is not required.

## TEST-001
- ID: TEST-001
- Priority: P0
- Statement: The example MUST ship with deterministic Playwright coverage and reset helpers that verify the core sharing workflows locally without external services.
- Rationale: The example should be both documentation and a regression harness.
- Acceptance criteria:
  - A root-level Playwright config exists under the example.
  - The suite resets server state before scenarios or test groups.
  - The suite covers record grant, upgrade, revoke, team scope grant, and workspace isolation.
  - The suite is runnable via documented commands from the example root.
- Test vectors: TV-E2E-001, TV-RESET-001
- Notes: The suite may share helper utilities for demo identity setup.

## DOC-001
- ID: DOC-001
- Priority: P1
- Statement: The example documentation MUST explain how the demo’s workspace namespace, actor identity, principals, and deterministic reset flow map to real DataFn applications.
- Rationale: The example is intended to teach modeling decisions, not only UI clicks.
- Acceptance criteria:
  - The README includes a “Model” section covering namespace, actor, and principal mapping.
  - The README includes run instructions for server, client, and Playwright.
  - The README includes a short walkthrough of the main sharing flows.
- Test vectors: TV-DOCS-001
- Notes: Documentation may cross-link to the existing sharing docs.
