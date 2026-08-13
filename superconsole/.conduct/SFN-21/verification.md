# Verification record

## Source and external state

- Linear issue: [SFN-21](https://linear.app/21n/issue/SFN-21/build-super-console-as-the-modular-self-hosted-administration-control), with the ideation and architecture/delivery documents created, attached, and read back during project setup.
- Fetched `sf-next/next`: `8dddd865ee9b86571c70db87efd918152cf682fb`.
- Fetched `origin/dev`: `04230e1462d85fe7aa0157fa26eca707681872ee`.
- Local `next` merge: `da0720a508eb86e3680f433dee17474670c41b27`.
- The feature worktree was fast-forwarded to that merge before implementation.
- The dirty `dev` worktree was inspected read-only for forward compatibility and was not changed.

## Implementation contract

- Super Console is a self-hosted SvelteKit operator control plane whose enabled modules are explicitly selected by the consumer.
- The enabled registry is authoritative for navigation, REST, OpenAPI, TypeScript clients, and McpFn discovery. Disabled modules are absent on every surface.
- UIFn powers the shared visual system. Operator administration remains separate from embedded or customer-facing portals.
- AuthFn owns operator authentication and CSRF; the admin kernel owns scope, policy, confirmation, audit, idempotency, redaction, REST/OpenAPI, TypeScript transport, and McpFn projection.
- CatchFn and LogFn are nested under WatchFn. ContentFn is folded into CmsFn and cannot be selected independently.
- Every selectable module exposes only operations backed by a real function-owned service. A function without a canonical operator service is explicitly unavailable and exposes no resources, navigation, or operations.

## Shared administration kernel

Final Node 22 verification:

- `npm run typecheck --workspace=@superfunctions/admin` — passed.
- `npm test --workspace=@superfunctions/admin -- --pool=forks --poolOptions.forks.singleFork=true` — 53/53 tests passed.
- `npm run build --workspace=@superfunctions/admin` — passed.

Coverage includes:

- strict installation → workspace → project → environment scope with `organizationId` as a compatibility alias;
- manifest/resource/operation minimum scope and actor-projected discovery;
- declared permission AND custom policy evaluation;
- immutable validated request/context snapshots;
- confirmation binding and strong-confirmation metadata;
- SHA-256 idempotency fingerprints, read exclusion, replay, release, and durable recovery;
- attempted/terminal audit ordering and explicit resource targets;
- recursive outward secret redaction plus the validated one-time-output exception;
- OpenAPI, language-neutral REST, TypeScript transport, and McpFn parity.

## Function administration packages

All 29 function-owned admin packages were verified sequentially from the frozen source:

- 29/29 typechecks passed;
- 101/101 tests passed;
- 29/29 production builds passed.

Direct import and manifest readback from built packages found:

- 29 valid manifests;
- 111 real resources;
- 283/283 globally unique operations;
- availability split: 18 required selectable, 2 optional selectable, 2 nested, 1 folded, and 6 unavailable;
- folded and unavailable packages expose zero resources and zero operations;
- exactly one validated one-time credential response: `filefn.share-links.create-share` field `token`.

The function packages publish exact service methods, handler maps, operation-specific schemas, and named TypeScript clients. Public caller-supplied `execute({ operationId, input: unknown })` façades and generated commercial-placeholder inventories were removed. Representative domain integration tests use the real function services/adapters and prove scope ownership or cross-scope rejection.

Current live module breadth is recorded in [capability-inventory.md](capability-inventory.md). The commercial comparison tables are explicitly roadmap targets, not implementation claims.

## Super Console and UIFn

- `npm run check --workspace=superconsole` — Svelte check passed with 0 errors and 0 warnings.
- `npm test --workspace=superconsole -- --maxWorkers=1` — 74/74 tests passed.
- `npm run build --workspace=superconsole` — adapter-node production build passed.
- `npm run verify:uifn-governance` — `ok: true`, 10/10 checks passed.

The UIFn governance output still reports the repository's recorded `baselineVerdict: "FAIL"`; that baseline is preserved rather than relabeled. The enforcement command itself passed every positive and negative fixture.

UI verification covers:

- public UIFn package consumption with no source aliases or secondary component system;
- authenticated shell and hierarchy switching;
- selected-module navigation and unavailable/folded rejection;
- UIFn Drawer keyboard/focus behavior and source-owned Drawer/Avatar fixes;
- action schema forms, confirmation, stable idempotency, receipts, and refresh-failure semantics;
- CiFn run, job log, retry/cancel, and audited artifact-download flows;
- safe internal navigation/download/avatar handling and AuthFn CSRF/2FA behavior.

## Production browser probe

A production-build Playwright probe used the real `createCiFnAdminAdapter`, selected only CiFn, loaded overview/run/log surfaces, executed cancel and retry, and exercised the mobile UIFn Drawer including Escape close and focus restoration.

- Result: `ok: true`.
- Evidence was retained in a temporary local probe directory and is not part of the source tree.
- Evidence set: `result.json`, empty browser-error log, server log, desktop overview, CiFn run-detail, and mobile Drawer screenshots.

The final probe caught and verified the fix for a successful mutation receipt being lost when route invalidation remounted the action component. Mutation success is now published to the shell-level status surface before refresh.

## Dependency and lockfile reproducibility

- Final command: `npm install --package-lock-only --legacy-peer-deps --ignore-scripts --no-audit --no-fund`.
- Lockfile SHA-256 before and after: `9d19e07dac12a7f4e2cea4c3cb47315372c842b7dbef791a448acad548ae66f7`.
- Result: unchanged; final manifests and lockfile are synchronized.
- Node: `v22.22.0`; npm: `10.9.4`.
- `--legacy-peer-deps` remains necessary because of an unrelated pre-existing DocsFn/Svelte peer conflict in the merged monorepo.
- ProbeFn's workspace-private admin package bundles its private source-only ProbeFn dependencies and was directly imported successfully from its built ESM output.

## Audit remediation outcomes

The read-only audit was treated as a valid release-blocking assessment. Remediation closed the material findings rather than masking them:

- generic generated module façades were replaced by real domain bindings or truthful unavailable packages;
- registry selection became availability-aware and manifest-driven;
- policy, audit, confirmation, idempotency, redaction, target, scope, and MCP/OpenAPI parity gaps were fixed in the shared kernel;
- function-specific clients and operation schemas replaced unknown-input public SDKs;
- CiFn uses its real control-plane adapter, typed operations, audited downloads, and defensive views;
- UIFn Drawer/Avatar defects were fixed at the source and local UI workarounds removed;
- mutation success receipts survive route refresh/remount;
- CmsFn is independently selectable while folded ContentFn remains an implementation dependency only;
- the package lock was regenerated from the final manifests.

## Final evidence boundaries

- Final `git diff --check` is required immediately before the completion commit.
- Work remains local on `codex/super-console`; no push, pull request, deployment, or publication was performed.
- Generated `dist`, `.svelte-kit`, browser artifacts, and `node_modules` are ignored and are not source changes.
- Local verification does not prove a deployed installation, external provider credentials, DNS, live email delivery, hosted database durability, npm publication, or remote CI.
