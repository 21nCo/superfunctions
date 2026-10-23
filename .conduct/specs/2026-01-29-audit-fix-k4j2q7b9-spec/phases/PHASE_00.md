# Phase 00

## Phase goal

Introduce the shared protocol surface and type plumbing required for clone up (core hook phase typing + server/client surface area) without implementing persistence semantics yet.

## In scope

- Add sync phase `"cloneup"` to `@datafn/core` plugin hook types.
- Extend `@datafn/server` action unions and hook runner signatures to accept `"cloneup"`.
- Extend `@datafn/client` remote adapter interface to include `cloneUp` and add a transport stub method (HTTP POST wiring).

## Out of scope

- Server-side clone up execution (DB writes + change tracking).
- Client-side `cloneUpNow()` convenience method.

## Deliverables

- Modify:
  - `datafn/core/src/types.ts`
  - `datafn/server/src/server.ts`
  - `datafn/server/src/plugins/run-hooks.ts`
  - `datafn/client/src/client.ts`
  - `datafn/client/src/transport/http.ts`

## Requirements covered

- CLONEUP-014
- (partial scaffolding for) CLONEUP-009
- (partial scaffolding for) CLONEUP-008
- (partial scaffolding for) CLONEUP-007

## Implementation tasks

1. Update `@datafn/core`:
   - Extend `DatafnPlugin.beforeSync/afterSync` phase union to include `"cloneup"`.

2. Update `@datafn/server`:
   - Extend `DatafnServerConfig.authorize` action union to include `"cloneup"`.
   - Extend `withAuth()` action union to include `"cloneup"`.
   - Extend server plugin hook runner (`runBeforeSync/runAfterSync`) phase typing to include `"cloneup"`.

3. Update `@datafn/client`:
   - Extend `DatafnRemoteAdapter` with `cloneUp(payload)`.
   - Add `DefaultHttpTransport.cloneUp(payload)` that posts to `cloneup` endpoint.

4. Add/adjust compilation guard:
   - Ensure core/client/server `typecheck` succeed.

## Verification steps

Run:

```bash
npm -w @datafn/core typecheck
npm -w @datafn/server typecheck
npm -w @datafn/client typecheck
```

Expected outcomes:

- All commands exit 0.

## Stop condition

Report:

- The set of files changed.
- Confirmation that typecheck passed for all three packages.
