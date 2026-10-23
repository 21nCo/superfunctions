# Metadata
- Timestamp: 2026-03-14T12:58:00Z
- agent_name: unknown-agent
- model: gpt-5-codex
- launcher: Codex Desktop
- Workspace: `/Users/serro/Documents/dev/n/superfunctions/datafn`
- Repo root: `/Users/serro/Documents/dev/n/superfunctions`
- OS + shell: `macOS 26.3.1 (Darwin)`, `zsh`
- Git:
  - branch: `heads/next`
  - commit: `5fe59b66a1ebf692ef723eb68f708e60a90de457`
  - dirty: `true`
- spec_folder: `2026-03-14-new-s7h4r2p9-spec`
- spec_folder_path: `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-14-new-s7h4r2p9-spec`
- spec_type: `new`
- spec_id: `s7h4r2p9`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/datafn.intent.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2025-03-12-datafn-sharing-scenarios.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-recommendations-beginner-guide.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/share-use-cases-list.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/documentation/concepts/sharing-v2.mdx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/documentation/concepts/capabilities.mdx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/documentation/sync/sharing-sync-lifecycle.mdx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/client/src/App.svelte`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/client/src/lib/datafn.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/auth/principal-resolver.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/auth/access-resolver.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/mutation/__tests__/share-spv2.test.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/sync/__tests__/spv2-sync-visibility.test.ts`
- Audit-fix linkage: `N/A`

## Overview
Project name: DataFn

One-sentence goal:
Implement a separate, focused example application at `datafn/examples/sharing-app` that demonstrates DataFn sharing semantics with realistic actor and namespace modeling, and that doubles as a deterministic Playwright target.

Target users:
- DataFn consumers evaluating how to model sharing in real products.
- DataFn maintainers validating sharing behavior in a browser-level workflow.
- Product teams building collaborative document-like experiences on top of DataFn.

Target environments:
- TypeScript server runtime with Hono-compatible DataFn server.
- TypeScript browser client using `@datafn/client` and `@datafn/svelte`.
- Local development on macOS/Linux with Node 18+.
- Online and offline-capable browser sessions.

Languages/packages required:
- TypeScript.
- Existing DataFn packages: `@datafn/core`, `@datafn/client`, `@datafn/server`, `@datafn/svelte`.
- Existing shared packages already used by DataFn examples.
- Playwright for end-to-end verification.

Existing systems it must integrate with:
- DataFn sharing APIs (`share`, `unshare`, `getPermissions`).
- `namespaceProvider` server contract.
- DataFn client `switchContext()` behavior.
- Existing example conventions under `datafn/examples`.

Data model summary:
- One shareable resource: `documents`.
- Demo workspaces mapped to namespaces (`org:acme`, `org:globex`).
- Demo actors (`user:alice`, `user:bob`, `user:charlie`).
- Demo principals (`user:*`, `team:design`).
- Seeded membership rows per workspace namespace.

Security model:
- Namespace MUST remain server-derived.
- Actor MUST remain server-derived from demo identity headers on every request.
- Sharing MUST stay namespace-scoped for this example; cross-namespace sharing is intentionally denied.
- The example MUST demonstrate permission denial states without leaking inaccessible records.

Performance constraints:
- No external infrastructure may be required to run the example.
- Reset/bootstrap flows MUST be deterministic and fast enough for repeated Playwright runs.
- Example queries and sync flows MUST remain stable across two concurrent browser contexts.

Non-goals:
- Demonstrating every SPV2 feature in the UI.
- Demonstrating relation inheritance, hierarchy editing, or cross-namespace positive sharing flows.
- Replacing or overloading `datafn/examples/todo-app` as the primary sharing demo.

Hard constraints:
- The example MUST be a new dedicated example app, not an expansion of the existing todo app.
- The example MUST model collaboration with workspace-level namespaces and actor-level identities.
- The example MUST be runnable without PostgreSQL, Elasticsearch, or other external services.
- The example MUST provide deterministic fixtures suitable for Playwright and manual walkthroughs.

## Glossary
- Namespace: The server-derived tenant/workspace boundary used for row-level isolation. In this example the canonical namespace format is `org:{workspaceId}`.
- Workspace: The human-facing tenant concept that maps one-to-one to the namespace in the example app.
- Actor: The authenticated caller making the request. In this example the actor is one of `user:alice`, `user:bob`, or `user:charlie`.
- Principal: A share target identity. The example uses opaque principal IDs such as `user:alice` and `team:design`.
- Effective principals: The set of principals resolved for the actor in the current namespace, including the actor’s canonical user principal and any seeded team memberships.
- Record grant: A share grant scoped to one record (`scope = "record"`).
- Scope grant: A share grant scoped to all records of a resource in a namespace (`scope = "resource"`).
- Viewer: A principal with read access only.
- Editor: A principal with read and merge/update access, but not owner-only actions.
- Owner: The principal with full access including share and unshare.
- Backfill: A sync effect where a newly shared actor receives an existing record on pull.
- Revoke tombstone: A sync effect where a revoked actor receives a delete change so local state removes the record.

## Goals / Non-goals
### Goals
1. The example MUST teach consumers how to model actors, principals, memberships, and workspace namespaces for collaborative apps.
2. The example MUST demonstrate the core sharing lifecycle end to end: create, share, inspect permissions, edit under granted level, revoke, and observe sync effects.
3. The example MUST show the difference between workspace namespace resolution and actor identity resolution.
4. The example MUST be stable enough to serve as a Playwright acceptance target.
5. The example MUST keep the current todo example focused on local-first/sync/search instead of turning it into a kitchen-sink demo.

### Non-goals
1. The example does not need to be production authentication infrastructure.
2. The example does not need to expose a UI for creating arbitrary principals, memberships, or hierarchies.
3. The example does not need to demonstrate relation inheritance, custom authorization callbacks, or WebSocket-targeted invalidation.

## Public API
### Filesystem layout
The implementation MUST create a new example root:

```text
datafn/examples/sharing-app/
  README.md
  package.json
  playwright.config.ts
  e2e/
  client/
  server/
```

`datafn/examples/todo-app` MAY receive documentation-only cross-links, but it MUST NOT become the implementation home for the sharing demo.

### Demo identity headers
The example server MUST accept these headers on all `/datafn/*` and `/demo/context` requests:

```http
x-demo-workspace-id: acme | globex
x-demo-user-id: user:alice | user:bob | user:charlie
```

Canonical rules:
- Missing or invalid `x-demo-workspace-id` MUST fail with `DEMO_IDENTITY_INVALID`.
- Missing or invalid `x-demo-user-id` MUST fail with `DEMO_IDENTITY_INVALID`.
- The server MUST derive `namespace = org:{workspaceId}`.
- The server MUST derive `actorId = x-demo-user-id`.

### Demo endpoints
#### `GET /demo/bootstrap`
Returns static demo metadata and baseline scenario description.

Success envelope:

```json
{
  "ok": true,
  "result": {
    "defaultWorkspaceId": "acme",
    "defaultUserId": "user:alice",
    "workspaces": [
      {
        "id": "acme",
        "label": "Acme",
        "namespace": "org:acme",
        "users": ["user:alice", "user:bob", "user:charlie"],
        "principals": ["team:design", "user:alice", "user:bob", "user:charlie"]
      }
    ]
  }
}
```

#### `GET /demo/context`
Returns the resolved server context for the current demo identity.

Success envelope:

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

Failure envelope:

```json
{
  "ok": false,
  "error": {
    "code": "DEMO_IDENTITY_INVALID",
    "message": "Invalid demo identity",
    "details": {
      "header": "x-demo-user-id"
    }
  }
}
```

#### `POST /demo/reset`
Resets the in-memory server state and reseeds the deterministic baseline scenario.

Request:

```json
{
  "scenario": "baseline"
}
```

Success response:

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

Canonical reset rules:
- Only `baseline` is defined.
- Reset MUST fully replace all mutable server state, including permissions and changelog state.
- Reset MUST be safe for repeated Playwright invocations.

### Baseline seed model
The example baseline scenario MUST seed:

Workspaces and namespaces:
- `acme` -> `org:acme`
- `globex` -> `org:globex`

Users:
- `user:alice`
- `user:bob`
- `user:charlie`

Memberships:
- `org:acme`: `user:alice` -> `team:design`, `user:bob` -> `team:design`
- `org:globex`: `user:bob` -> `team:design`, `user:charlie` -> `team:design`

Documents:
- `doc:acme-private-alice` in `org:acme`, owner `user:alice`, private
- `doc:acme-team-brief` in `org:acme`, owner `user:alice`, granted to `team:design` as `viewer`
- `doc:globex-private-bob` in `org:globex`, owner `user:bob`, private

### DataFn resource schema
The example server MUST define a `documents` resource with this semantic shape:

```ts
{
  name: "documents",
  version: 1,
  idPrefix: "doc:",
  capabilities: [
    "timestamps",
    "audit",
    {
      shareable: {
        levels: ["viewer", "editor", "owner"],
        visibilityDefault: "private",
        supportsScopeGrants: true,
        crossNsShareable: false
      }
    }
  ],
  fields: [
    { name: "title", type: "string", required: true },
    { name: "content", type: "string", required: true }
  ]
}
```

### Client UI surface
The client MUST expose these user-facing controls:
- Workspace selector.
- Actor selector.
- Context panel showing workspace, namespace, actor, and effective principals.
- Visible document list.
- Document create/edit form.
- Share management panel for record grants.
- Resource-scope grant panel for `team:design`.
- Permission inspector for the selected document.
- Activity/status panel showing reset, sync, and permission outcomes.

### Playwright surface
The example root MUST expose a Playwright suite with commands that exercise:
- Record share to a user.
- Role difference between viewer and editor.
- Revoke removing access.
- Team scope grant.
- Workspace isolation.
- Grant backfill across two browser contexts.
- Revoke tombstone across two browser contexts.

## Data formats / protocol
### Canonical demo envelopes
All `/demo/*` endpoints MUST use:

Success:

```json
{ "ok": true, "result": { } }
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "STRING_CODE",
    "message": "Human-readable message",
    "details": { }
  }
}
```

### Client session model
The browser client MUST maintain a local session object:

```ts
type DemoSession = {
  workspaceId: "acme" | "globex";
  userId: "user:alice" | "user:bob" | "user:charlie";
};
```

Canonical rules:
- `workspaceId` changes MUST trigger `client.switchContext()` to a new local namespace.
- `userId` changes MUST rebuild the demo remote adapter so every server call carries the new headers.
- The client-side namespace for local storage MUST be `demo:{workspaceId}:{userId}`.
- The server-side namespace MUST remain `org:{workspaceId}` and MUST NOT include the user ID.

This split is intentional:
- local namespace isolates offline state per persona/device view;
- server namespace models collaboration inside one workspace.

### Error codes
The example MUST surface these error codes when relevant:
- `DEMO_IDENTITY_INVALID`: invalid or missing demo headers.
- `FORBIDDEN`: user lacks required permission for the requested operation.
- `DFQL_PRINCIPAL_INVALID`: invalid principal selection shape.
- `DFQL_UNSUPPORTED`: unsupported operation or malformed share scope.
- `DEMO_RESET_FAILED`: reset failed unexpectedly.

Error determinism rules:
- The example MUST preserve the underlying DataFn error code from the server.
- The client MAY add user-facing helper text, but MUST NOT replace or erase the canonical code.

## Semantics
### Namespace and actor resolution
1. The server MUST derive the namespace only from the selected workspace.
2. The server MUST derive the actor only from the selected user.
3. Two actors in the same workspace MUST operate in the same server namespace and differ only by actor/principal resolution.
4. The same actor string in two different workspaces MUST be isolated because the namespace differs.

### Principal modeling
1. The example MUST use principal IDs as opaque strings.
2. The example MUST demonstrate both direct user principals and one team principal.
3. The example MUST show effective principals as the actor principal plus any seeded memberships in the current namespace.
4. The example MUST NOT require a principal type enum in the UI or wire format.

### Record share behavior
1. Owner creates a private document.
2. Owner shares it to another user as `viewer`.
3. Viewer can read but cannot merge, delete, share, or unshare.
4. Owner upgrades the grant to `editor`.
5. Editor can merge content but still cannot owner-only share or delete.
6. Owner unshares the record and the grantee loses visibility.

### Resource-scope grant behavior
1. Owner can create a scope grant for `team:design`.
2. Actors whose effective principals include `team:design` gain access to documents covered by the scope grant.
3. Actors outside the team do not gain access.
4. Scope grants remain bound to the current workspace namespace.

### Namespace isolation behavior
1. Documents in `org:acme` MUST NOT appear when browsing `globex` unless explicitly created there.
2. The example MUST deny cross-workspace grant attempts because `crossNsShareable: false`.
3. The example MUST expose this denial in the UI and in Playwright assertions.

### Sync behavior
1. If actor A grants actor B access while actor B is in another browser context, actor B MUST receive the existing record on the next pull.
2. If actor A revokes actor B’s access, actor B MUST receive a delete/tombstone effect on the next pull.
3. The example MAY use pull-based sync only; targeted WebSocket invalidation is undefined for this example.

### Deterministic UI behavior
1. Documents MUST sort by `updatedAt desc`, then `id asc`.
2. Effective principal badges MUST sort lexicographically.
3. Workspace selector options MUST sort by workspace ID.
4. User selector options MUST sort by user ID.
5. Reset MUST return the UI to the same document and membership state every time.

## Invariants
### Determinism
- The same reset call MUST produce the same records, grants, memberships, and counts.
- The same demo identity headers MUST resolve to the same `namespace`, `actorId`, and `effectivePrincipals`.
- The same document list state MUST render in the same order for the same underlying data.
- The same Playwright suite against a clean reset MUST pass without dependence on external services.

### Idempotency
- Repeating `/demo/reset` MUST leave the example in the same baseline state.
- Repeating a share action with the same principal and level MAY upsert the existing grant but MUST NOT create duplicate permission rows.
- Repeating an unshare action MAY be idempotent success.

### Consistency
- UI access state MUST come from server-backed DataFn behavior, not from local-only optimistic ACL assumptions.
- Permission inspector output MUST match server `getPermissions()` results.
- Forbidden actions MUST remain forbidden after page reload and after sync pull.

## Security
### Authorization boundaries
- The server MUST validate demo identity on every protected request.
- The client MUST NOT be trusted to supply the server namespace directly.
- The server MUST deny access when demo headers are invalid, missing, or out of the allowlist.
- The example MUST demonstrate that actor identity affects authorization even when namespace is shared.

### Privacy constraints
- The client MUST NOT show inaccessible document titles or content in list or inspector panels.
- Error surfaces MUST NOT leak raw internal tables or SQL details.
- `/demo/bootstrap` MAY expose static demo metadata because it is non-sensitive and example-only.
- `/demo/reset` MUST remain example-only and MUST be documented as unsafe for production.

### Validation
- Only allowed workspaces (`acme`, `globex`) are valid.
- Only allowed users (`user:alice`, `user:bob`, `user:charlie`) are valid.
- Only seeded principals are selectable in the UI.
- Attempting to share to a principal outside the current workspace policy MUST fail deterministically.

## Limits/caps
- Defined workspaces: exactly `acme`, `globex`.
- Defined actors: exactly `user:alice`, `user:bob`, `user:charlie`.
- Defined extra team principal: exactly `team:design`.
- Defined reset scenarios: exactly `baseline`.
- WebSocket live push behavior: undefined.
- Arbitrary hierarchy editing: undefined.
- Cross-namespace positive sharing: undefined and not required.

## Observability
- The client MUST display the current workspace, namespace, actor, and effective principals.
- The client MUST display the last reset status and last sync outcome.
- The client MUST display canonical error codes for failed share/edit actions.
- The example README MUST explain how the demo’s actor/namespace split maps to real applications.
- The example MUST NOT log secret tokens or non-demo PII because the demo uses fixed identities only.

## Compatibility / versioning strategy
- The example MUST target the current SPV2-style `principalId` sharing API.
- The example MAY mention legacy `userId` compatibility in documentation, but the UI MUST use `principalId` terminology.
- The example MUST remain additive to the repo: it adds a new example app and does not redefine existing DataFn public APIs.

## Undefined / Explicitly user-deferred only
- WebSocket-targeted invalidation behavior in the example UI is undefined.
- Relation inheritance UI and tests are undefined.
- Custom principal creation, deletion, and hierarchy editing are undefined.
- Production auth providers, JWT middleware, and persistent database migrations for the example are undefined.
