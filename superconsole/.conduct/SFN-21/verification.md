# Verification record

## Current verdict

**PASS for the local self-hosted SFN-21 contract.** The implementation and lock
used by the final production probe are committed at
`078dfec7c1db1daa2a4cae965963c80a0e4cd994`. The durable evidence manifest names
that exact commit. Later changes in this completion commit are documentation and
evidence records only.

## Delivered contract

- 29 function-owned administration packages.
- 20 independently selectable required modules.
- 6 independently selectable optional modules.
- CatchFn and LogFn nested under WatchFn.
- ContentFn folded into CmsFn with no duplicate surface.
- No unavailable SFN-21 module.
- 130 real operator resources and 347 globally unique operations.
- One registry controls UI, dispatch, REST/OpenAPI, TypeScript SDK discovery,
  and McpFn projection; disabled modules are absent from every surface.
- Every required/optional operation delegates to a function-owned service or a
  mandatory injected durable/provider boundary. Unsupported roadmap breadth is
  omitted.

## Shared administration kernel

Node `v22.22.0`, npm `10.9.4`:

- `npm run typecheck --workspace=@superfunctions/admin` — PASS.
- `npm test --workspace=@superfunctions/admin -- --pool=forks --poolOptions.forks.singleFork=true` — PASS, 65/65.
- `npm run build --workspace=@superfunctions/admin` — PASS.

Coverage includes immutable typed scope/context, composed caller cancellation
and timeouts, raw responses, policy and confirmation binding, SHA-256
idempotency fingerprints, stable-ID terminal-audit reconciliation, recursive
outward redaction, schema-bound one-time secret paths, OpenAPI, REST, SDK, and
McpFn parity.

The fault-injected reconciliation test performs three failed post-audit
reconciliation attempts and proves one logical terminal audit event and one
domain invocation. Audit sinks must be durable first-write-wins by event ID and
idempotency stores must atomically finalize that ID.

## Function administration packages

All 29 admin workspaces were checked sequentially:

- 29/29 typechecks passed;
- 122/122 tests passed;
- 29/29 production builds passed.

`npm run verify:superconsole-admin-contracts` imported every built package and
reported:

- 29 valid manifests;
- 130 resources;
- 347 unique operations;
- availability `20 required / 6 optional / 2 nested / 1 folded`;
- every selectable module has resources and operations;
- every resource has identity/display metadata and an operation route/target;
- every named client preserves `availability`, `invoke`, `pages`, `raw`, its
  exact `operations` map, and its function-owned named methods.

The independent SDK review passed 28/28 available/nested named factories; the
folded ContentFn factory is covered by the 29-package gate. The machine mutation
risk review passed 58/58 credential-lifecycle and external-side-effect
operations with zero exceptions.

Focused owning-runtime evidence:

- HostFn CLI — 63/63 tests and build passed.
- UserFn core — 17/17 tests, typecheck, and build passed.
- ApiFn core — 93/93 tests and typecheck passed.
- DocsFn core — 147/147 tests and build passed.
- LangFn core — 56/56 tests, typecheck, and build passed. The run also fixed
  MCP SDK protocol failures so unknown tools normalize to `MCPProtocolError`.

## Super Console and UIFn

- `npm run check --workspace=superconsole` — PASS, 0 errors and 0 warnings.
- `npm test --workspace=superconsole -- --maxWorkers=1` — PASS, 74/74.
- `npm run build --workspace=superconsole` — PASS, adapter-node production build.
- `npm run verify:uifn-governance` — PASS, 10/10 checks, `ok: true`.

The UIFn gate intentionally preserves its repository baseline verdict of
`FAIL`; the governance command itself passed every positive and negative
fixture. Super Console consumes public UIFn packages without aliases or a
secondary component system. Operator administration remains separate from
customer portals and embedded UI.

## Durable production browser evidence

The final production-build Playwright probe ran:

```bash
SUPERCONSOLE_PROBE_SOURCE_COMMIT=$(git rev-parse HEAD) \
  SUPERCONSOLE_PROBE_ARTIFACTS=superconsole/.conduct/SFN-21/evidence/final \
  npm run probe:smoke --workspace=superconsole
```

Result: `ok: true` at source commit
`078dfec7c1db1daa2a4cae965963c80a0e4cd994`. The probe uses the real CiFn
admin adapter and an in-memory CiFn control plane. It verifies selected-module
discovery, overview, run and log views, audited cancel/retry mutations, mobile
UIFn Drawer behavior, Escape handling, and focus restoration.

Committed evidence:

- [result manifest](evidence/final/result.json)
- [desktop overview](evidence/final/01-overview-desktop.png)
- [CiFn run detail](evidence/final/02-cifn-run-detail.png)
- [mobile Drawer](evidence/final/03-mobile-drawer.png)
- sanitized [server output](evidence/final/server.txt)
- empty [browser error output](evidence/final/browser.txt)

The evidence contains no machine path, local host, or local port.

## Dependency and lock reproducibility

- Canonical graph install: `npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund` — PASS.
- Final stability command: `npm install --package-lock-only --legacy-peer-deps --ignore-scripts --no-audit --no-fund` — PASS with an unchanged second-run SHA-256.
- Final `package-lock.json` SHA-256: `c88650b9cc5ab64a7e7a3d81abfeaa29766755ac2913e519d503191afdd96ee5`.
- `--legacy-peer-deps` remains necessary because of a pre-existing DocsFn/Svelte peer conflict in the merged monorepo.

## Evidence boundaries

- Work remains local on `codex/super-console`; no push, pull request,
  deployment, publication, or live provider mutation was performed.
- Generated `dist`, `.svelte-kit`, and `node_modules` remain ignored.
- Local proof does not establish remote CI, npm publication, production DNS,
  external provider credentials, hosted durability, or a deployed self-hosted
  installation.
