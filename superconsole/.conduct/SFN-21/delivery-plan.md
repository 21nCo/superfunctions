# Delivery plan

## Worktree and branch

- Original checkout: repository root on local `next`.
- Isolated worktree: dedicated `super-console` worktree.
- Feature branch: `codex/super-console`.
- Integrated base: `da0720a508eb86e3680f433dee17474670c41b27`.
- No push or pull request.

## Parallel tracks

### Shared administration kernel

Owns `packages/admin/`: contracts, validation, registry, context, policy, errors, pagination, idempotency, dispatch, audit, OpenAPI, McpFn projection, TypeScript client, and package tests.

### Function administration packages

Owns each `{function}/admin/`: injected service interface, schemas, manifest, adapter factory, and contract tests for all required, optional, and nested modules.

### SvelteKit/UIFn shell

Owns UI routes/components/config and necessary UIFn source repairs. Provides authenticated shell, scope selection, registry navigation, overview, search, audit, settings/API/MCP views, generic resource/action patterns, states, responsive/accessibility behavior, and CiFn routes.

### Composition and convergence

Owns server registry composition, real adapter binding contract, endpoint handlers, deployment configuration, root workspace graph, source-controlled documents, integrated tests, verification, and commits.

## Dependency order

1. merged `dev` base and dirty-`dev` compatibility map;
2. shared manifest/context public API;
3. function package scaffolds and shell endpoint/view-model contracts in parallel;
4. registry composition and exposure adapters;
5. function manifests and module UI convergence;
6. focused package verification;
7. integrated disabled-module, tenant, API/OpenAPI/SDK/MCP, audit, and CiFn tests;
8. UIFn and SvelteKit builds/accessibility checks;
9. documentation and verification readback;
10. coherent local commits.

## Commit intent

Commits remain buildable where practical and separate concerns:

1. merge latest committed `origin/dev` into local `next`;
2. architecture and shared administration contracts;
3. registry, policy, REST/OpenAPI, TypeScript client, and McpFn projection;
4. UIFn changes and SvelteKit shell;
5. function-owned administration capabilities;
6. composition, routes, modules, and CiFn migration;
7. tests, self-hosting, and verification documents.

Generated artifacts remain with their source change. Root lockfile is regenerated from final manifests rather than resolved by choosing a conflict side.

## Completion gate

- every required and optional function has a real function-owned or mandatory injected operator boundary, and unsupported operations are omitted;
- one registry controls all exposure surfaces;
- disabled modules are absent everywhere;
- tenant, namespace, region, permission, idempotency, and audit semantics converge;
- UIFn is exclusive and its focused gates pass;
- representative operations and CiFn workflows pass;
- self-hosted configuration and operations are documented;
- no user-owned dirty work is modified;
- local commits are coherent and no external publication is claimed.

## Follow-up product boundary

Unavailable functions must first add a canonical, scope-aware operator
service/store in the owning function. Only then may their admin package add
operation-specific schemas and become selectable. This is product domain work,
not a console-side generic handler escape hatch.
