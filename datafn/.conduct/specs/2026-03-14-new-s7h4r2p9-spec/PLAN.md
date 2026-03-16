# Architecture Sketch
- `datafn/examples/sharing-app/server`
  - Hono-based demo server using `@datafn/server`.
  - Demo identity middleware validating `x-demo-workspace-id` and `x-demo-user-id`.
  - Baseline seeding/reset/bootstrap/context endpoints.
  - In-memory database adapter to avoid external services.
- `datafn/examples/sharing-app/client`
  - Svelte UI using `@datafn/client` and `@datafn/svelte`.
  - Demo session store for workspace/user selection.
  - Custom remote adapter that adds demo identity headers.
  - Context panel, document editor, share panel, scope grant panel, and activity panel.
- `datafn/examples/sharing-app/e2e`
  - Playwright tests with reset helpers and multi-context flows.

# Dependency Graph
1. Example root scaffolding and package scripts.
2. Server schema + demo identity + reset/bootstrap/context endpoints.
3. Client session model + remote adapter + context switching.
4. Document CRUD UI.
5. Share management UI and permission inspector.
6. Scope-grant and namespace isolation demonstrations.
7. Playwright automation and documentation.

# Phases Overview
- Phase 00 -> Goal: scaffold the separate example root and package surfaces. Delivered capability: new example directory and script skeleton. Verification: filesystem and package script inspection.
- Phase 01 -> Goal: implement demo server identity and deterministic baseline state. Delivered capability: `/demo/bootstrap`, `/demo/context`, `/demo/reset`, `documents` schema, in-memory seeding. Verification: endpoint requests.
- Phase 02 -> Goal: implement client session/context switching and visible document browsing. Delivered capability: workspace/user switcher, context panel, list/create/edit flows. Verification: manual browser walkthrough.
- Phase 03 -> Goal: implement record sharing and permission inspection. Delivered capability: record share/unshare, viewer/editor state changes, permission inspector. Verification: two-person manual flow.
- Phase 04 -> Goal: implement scope grants and namespace isolation teaching surfaces. Delivered capability: team scope grant panel and cross-workspace denial behavior. Verification: manual flow across `acme` and `globex`.
- Phase 05 -> Goal: implement sync-focused demo feedback. Delivered capability: activity/status panel and explicit pull-based grant/revoke demonstrations. Verification: two-browser manual sync walkthrough.
- Phase 06 -> Goal: automate verification and finish docs. Delivered capability: Playwright suite, README walkthrough, documented commands. Verification: local Playwright run.

# Definition Of Done
No phase is complete unless its verification steps pass.

# Recommended File Map
- `datafn/examples/sharing-app/README.md`
- `datafn/examples/sharing-app/package.json`
- `datafn/examples/sharing-app/playwright.config.ts`
- `datafn/examples/sharing-app/e2e/*.spec.ts`
- `datafn/examples/sharing-app/e2e/helpers/*.ts`
- `datafn/examples/sharing-app/server/package.json`
- `datafn/examples/sharing-app/server/tsconfig.json`
- `datafn/examples/sharing-app/server/src/index.ts`
- `datafn/examples/sharing-app/server/src/schema.datafn.ts`
- `datafn/examples/sharing-app/server/src/demo/identity.ts`
- `datafn/examples/sharing-app/server/src/demo/bootstrap.ts`
- `datafn/examples/sharing-app/server/src/demo/reset.ts`
- `datafn/examples/sharing-app/server/src/demo/seed.ts`
- `datafn/examples/sharing-app/client/package.json`
- `datafn/examples/sharing-app/client/vite.config.ts`
- `datafn/examples/sharing-app/client/src/main.ts`
- `datafn/examples/sharing-app/client/src/App.svelte`
- `datafn/examples/sharing-app/client/src/app.css`
- `datafn/examples/sharing-app/client/src/lib/datafn.ts`
- `datafn/examples/sharing-app/client/src/lib/demoSession.ts`
- `datafn/examples/sharing-app/client/src/lib/demoRemoteAdapter.ts`
- `datafn/examples/sharing-app/client/src/lib/api.ts`

# Execution Notes
- The example SHOULD keep dependencies minimal and reuse existing repo conventions from `datafn/examples/todo-app`.
- The example SHOULD prefer in-memory server state plus deterministic reset over heavyweight database setup.
- The example MAY add documentation links from existing DataFn docs/examples, but those links are not substitutes for the required new app.
