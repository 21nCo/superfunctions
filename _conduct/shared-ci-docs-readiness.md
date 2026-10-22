# Shared CI graph and docs checkpoint — 2026-10-22

## Changes

The root workspace now includes the existing `docs` application, so CI's `npm -w docs` commands resolve it. The catalog removes duplicate OAuth Router/OpenAPI entries, includes Admin/Delivery/Observability, and uses the actual `superfunctions-core` Python distribution. New and completed source-grounded guides are navigable; their ten TypeScript examples typecheck against the shared source.

Probe integration-test reverse edges move from six source-package devDependencies to root development tooling. Runtime dependencies and package-local scripts are retained. Visual Baselines additionally declares its existing storage runtime import, previously misclassified as a development dependency. This fixes the root Turbo cycle without copying the broader Probe implementation into Shared or disabling tasks. The older nested Probe harness/configuration remains pre-existing here; Probe66 separately contains its complete harness migration.

Docs uses Next15.5.28. The October14 official advisory recommends this maintenance release: https://nextjs.org/blog/nextjs-security-update-october-14-2026 . Its published optional sharp range still accepts0.34.x, so an override scoped to Next15.5.28 requires sharp^0.35.5; installed version0.35.5 was read back. Other Next versions and unrelated applications are not certified by this checkpoint.

A fresh docs build exposed mixed React runtimes: docs produced React19 elements but hoisted Next/Fumadocs resolved React18, breaking prerendered404. Root development React/ReactDOM19.2.4 and type packages19.3.0 align that shared toolchain; packages with explicit incompatible ranges keep their separate lock resolutions. The Next layout accepts the framework ReactNode type. No RSC aliases, type checks or build checks are disabled. Normal npm lock regeneration also updates the affected React/Fumadocs/Radix peer graph; this is broader than a one-line workspace change.

## Verified

- Clean npm11 `ci --workspace docs --include-workspace-root=false --ignore-scripts` installs511packages, without force/legacy peer flags. Normal full-root npm11 `ci --dry-run --ignore-scripts` also succeeds; this is a resolution check, not a full root installation/build.
- Shared docs-theme build and actual Next production build pass, including static prerendering. Docs and hoisted Next both resolve React/ReactDOM19.2.4 and React types19.3.0.
- Coverage/catalog, content, snippets and links checks all pass.
- Actual built local Next server returns200 renderedHTML for Admin, Delivery, Observability, OpenAPI and OAuthRouter pages, then is stopped. No deployment.
- Actual Turbo2.6.1 root build dry-run changes from a Probe dependency-cycle error to300 planned tasks, including docs build depending on docs-theme. Final source/lock inspection preserves runtime edges and scripts, with the explicit VisualBaselines storage correction.
- All8 shared-usage/stacked-PR regression tests pass. git diff --check passes. Linux NextSWC, esbuild and sharp entries are present in the lock; cross-platform execution is not claimed.

## Remaining gates

The full audit gate still fails SearchFn canonical-adapter enforcement because `searchfn/adapters/__tests__/redaction.test.ts` remains a noncanonical compatibility test. Its other package checks and invoked docs checks pass. This file was not removed to suppress the gate. Broader monorepo builds/tests, every React18/19 consumer and hostedActions must still be verified; scoped docs success does not establish them. Other functions retain their original open requirements. No release, deployment or base merge occurred.

Receipts: /tmp/shared-docs-ci-final.log, /tmp/shared-docs-build-final.log, /tmp/shared-docs-http-evening.log, /tmp/shared-docs-*-final.log, /tmp/shared-turbo-final.json, /tmp/shared-ci-regressions-evening.log, /tmp/shared-ci-dry-evening.log, /tmp/shared-audit-gate-evening.log.

## Direct build prerequisite follow-up — 2026-10-22 19:38 IST

Hosted guardrails run39791135518/job119867147493 failed because direct npm docs build skipped the shared theme build; the earlier local receipt explicitly built that prerequisite first. Docs prebuild now builds @superfunctions/docs-theme before MDX generation, making the documented direct command self-contained. Removed the owned generated theme dist directory and reran the actual docs build: prerequisite compilation, typecheck and complete static build all pass.

Hosted JavaScript run39789070410/job119860378069 also established missing ImportMeta.env declarations in CiFn dashboard api/auth source. Its tsconfig now explicitly includes vite/client types. A fresh isolated copy of the actual dashboard installs162packages normally and passes tsc -b plus the Vite5.4.21 production bundle. No ambient any declaration or type-check suppression was added. The isolated fixture is removed after the receipt. Logs: /tmp/shared-docs-prerequisite-build.log and /tmp/cifn-dashboard-isolated.log. These local results do not claim a subsequent hosted run passed.
