# DataFn Sync & Remote Layer Audit

**Date**: 2026-01-25
**Scope**: `@datafn/client` Sync & Remote Architecture
**Auditor**: Antigravity

## Executive Summary

A significant architectural drift has been identified between the original `v0` intent of DataFn and its current implementation regarding **Sync** and **Remote Transport**.

- **Original Vision**: "Batteries-included" auto-sync. The user configures `sync: { enabled: true }`, and the SDK handles the background sync loop, transport, and changelog management.
- **Current Reality**: "Transport-agnostic" manual primitives. The user must implement a custom `remote` adapter, manually construct `push`/`pull` payloads, and manage the sync loop themselves.

This shift occurred primarily during the **2026-01-19 Change Spec** definition, where the desire for transport flexibility (e.g., supporting browser extensions) inadvertently led to the removal of the default HTTP transport and the automatic sync engine.

---

## 1. The Drift Timeline

### Phase 1: The "Batteries-Included" Vision (Pre-Jan 18)

- **Source**: `datafn.intent.md`
- **Design**: The SDK was envisioned to hide the complexity of offline-first.
  - Configuration involved a simple `sync: { enabled: true }`.
  - The "Sync Engine" was implied to comprise a background worker that automatically pushed local changes and pulled remote updates.
  - Transport was assumed to be a standard HTTP layer over `/datafn/*` endpoints.

### Phase 2: The Implementation Gap (Jan 18)

- **Source**: `implementation.md`
- **Design**: The "Sync Engine" milestone (Milestone 7) was scoped down to _primitives_ only: `clone`, `pull`, `push` endpoints and logic.
- **Missing**: No deliverable was assigned for the "Sync Loop" (the `setInterval` or event-driven orchestrator) or the "Changelog Foreman" (the logic to drain the changelog).

### Phase 3: The Pivot to Agnosticism (Jan 19)

- **Source**: `2026-01-19-change-spec`
- **Change**: The `DatafnClientConfig` was updated to **require** a `remote: DatafnRemoteAdapter`.
- **Impact**: The `sync: { enabled: boolean }` option was removed. By mandating a user-provided adapter, the SDK effectively decoupled itself from knowing _how_ to send data, making an auto-sync loop impossible implementation-wise (since it wouldn't know if it should poll, use sockets, or wait for extension messages).

### Phase 4: The "Audit Fix" Reality (Jan 23 - Present)

- **Source**: `2026-01-23-audit-fix-change-spec`
- **State**: The spec now codified the "manual" approach. The user is responsible for the "glue code" that connects the storage changelog to the remote adapter.

---

## 2. Architecture Gap: Expectation vs. Reality

| Feature           | Original Intent (User Expectation)   | Current Implementation (Reality)                            |
| :---------------- | :----------------------------------- | :---------------------------------------------------------- |
| **Remote Config** | `serverUrl: "http://..."` (Implicit) | `remote: new MyAdapter(...)` (Explicit)                     |
| **Sync Loop**     | Managed by SDK (Background Timer)    | Managed by User (`setInterval` in app code)                 |
| **Push Logic**    | Auto-read changelog -> Send -> Clear | User must query changelog -> manual `push` call             |
| **Pull Logic**    | Auto-read cursor -> Fetch -> Apply   | User must read cursor -> manual `pull` call                 |
| **Changelog**     | Managed internally (Auto-drain)      | User must manually manage via adapter APIs (mostly missing) |

---

## 3. detailed findings

### 3.1. The Missing "Sync Engine"

The current `@datafn/client` provides a **Sync Facade** (`client.sync.*`), which is misleading. It acts as a passthrough to the `remote` adapter, with the only "intelligence" being:

- **Pull/Clone**: It intercepts the _response_ and applies it to local storage.
- **Push**: It does nothing but pass the payload.

Critically, the logic to **construct** the payloads is missing from the public API:

- There is no helper to "get all pending mutations for a push payload".
- There is no helper to "get current cursors for a pull payload".
- There is no helper to "acknowledge/clear mutations after success".

### 3.2. Changelog "Write-Only" Behavior

The SDK correctly Handles **writing** to the changelog (via `offline/mutate.ts` when a remote call fails). However, it provides no standard way to **read** or **drain** it.

- The `DatafnStorageAdapter` interface has `changelogList` and `changelogAck` methods.
- However, these are not exposed effectively through the `client` instance for the user to utilize in their manual sync loop.

### 3.3. Remote Adapter Complexity

Forcing every user to write a `DatafnRemoteAdapter` (wrapping `fetch`) is a high barrier to entry for the common case. While flexibility is good for complex apps (extensions, Electron), 90% of web apps just want standard HTTP `POST` behaviors.

---

## 4. Recommendations

To resolve this drift and restore usability, we recommend a **Layered Architecture**:

### 4.1. Restore the "Default" HTTP Adapter

Ship a `@datafn/http-adapter` (or include in core) that implements `DatafnRemoteAdapter` using standard `fetch`.

- _Usage_: `remote: new HttpRemoteAdapter({ url: "..." })`

### 4.2. Build a True "Sync Engine"

Create a `DatafnSyncEngine` class (or `createSyncEngine`) that creates the loop.

- _Responsibility_:
  1.  Polls/Listens for triggers (interval or network status).
  2.  Reads cursors from storage -> Calls `pull`.
  3.  Reads changelog from storage -> Calls `push` -> Calls `changelogAck`.
- _Integration_: It should take the `client` instance and "drive" it.

### 4.3. Re-introduce "Batteries-Included" Config

Restore a high-level `createDatafnClient` overload or helper that accepts:

```ts
{
  schema,
  sync: {
    enabled: true,
    url: "http://localhost:3000/datafn",
    interval: 5000
  }
}
```

This helper should internally instantiate the `HttpRemoteAdapter` and the `SyncEngine`, hiding the manual wiring from the user.
