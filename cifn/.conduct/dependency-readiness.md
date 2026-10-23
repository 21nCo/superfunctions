# CiFn dependency integration checkpoint — 2026-10-23

The previous fresh packed consumer reported seven audit entries originating from
two advisories: UUID buffer bounds and braces recursive-pattern stack exhaustion.
This checkpoint removes those dependencies from CiFn's production closure and
integrates the existing TestFn prerequisite without discarding its runtime work.
It does not complete the original CiFn/provider/deployment readiness scope.

## Changes

- Ordinary merge `7e7f67bc6` integrates TestFn `8e4efa93c`, including its existing
  core0.0.4 implementation, tinyglobby discovery, framework execution and package
  contracts. The prior Ci tree retained the old fast-glob adapters. The runner
  now requires core0.0.4; dependency source and declared version agree.
- Four control-plane UUID v4 imports now use `node:crypto.randomUUID`. The UUID
  and old type packages are removed from control-plane and runner manifests.
  The runner had no UUID imports and already used the builtin in other paths.
  Node's builtin is cryptographic v4 and available since14.17/15.6, below the
  existing supported Node runtime used here.
- The runner dynamically imports TestFn inside asynchronous execution, retaining
  CJS and ESM consumers with TestFn's ESM-only package. The existing async helper
  is now publicly exported. The legacy synchronous helper returns explicit
  failure before starting asynchronous work; previously it started `run()` then
  reported that the Promise could not complete synchronously. Pipeline execution
  already uses the async path. No synchronous passing result is fabricated.
- Normal npm resolution regenerates the lock; no force, legacy-peer, audit
  suppression or dependency-removal workaround is used.

## Validation

- Turbo `build --filter=@cifn/runner...`:11/11 tasks passed, including TestFn and
  all shared runtime prerequisites, Ci CJS/ESM/declarations and LogFn.
- Control-plane189, runner99 and TestFn55 tests passed. New runner tests exercise
  actual selected brace-glob files, ignored-file exclusion, failed assertion
  propagation, cwd restoration and no cwd/work launch from the sync helper.
- Full control-plane and runner `tsc --noEmit` passed.
- Normal scoped `npm ci --dry-run` passed. Normal scoped install completed; the
  pre-existing sparse installation lacked TestFn's newly required Babel tools.
  npm emitted unrelated Node22 workspace engine warnings on this Node20.20.0
  host; no engine settings or unrelated package requirements were weakened.
- `scripts/verify-dependency-consumer.mjs` packs11 local runtime packages, installs
  only tarballs plus normal production dependencies in a fresh temporary project,
  and checks both public module formats. Actual consumer-local Vitest4.1.12
  executes two selected `.test.js`/`.spec.ts` files through both Ci APIs. Default
  production and selected-framework production audits both report **zero**.
  UUID, braces, micromatch and fast-glob are absent from the default production
  lock, not merely bypassed by a source-level reachability argument.
- npm10.8.2 initially failed internally with `edgesOut` during fresh resolution.
  The same normal fixture passes with npm11.21.0 through `CIFN_NPM_CLI`. The first
  fixture selected old Vitest3.2.4 and correctly failed its final audit on separate
  framework advisories; replacing that fixture dependency with Node20-compatible
  Vitest4.1.12 passes. This does not clear historical optional peer versions or
  the entire monorepo development dependency graph.
- `git diff --check` passed. The fixture removes tarballs, node_modules, test
  workspaces and child-process outputs in `finally`; no owned processes remain.

Command:
`CIFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js
node cifn/typescript/control-plane/scripts/verify-dependency-consumer.mjs`

Receipts: `/tmp/cifn-deps-{lock,lock-dryrun,install,build,tests,types,packed}.log`,
`/tmp/cifn-dependency-production-audit.json` and
`/tmp/cifn-dependency-framework-audit.json`.
No push, base merge, release, deployment or external provider mutation occurred.

## Upstream evidence and remaining scope

[UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) identifies the
v3/v5/v6 output-buffer issue and patched11.1.1. Ci called v4, but removing the
unneeded package clears the installed dependency rather than claiming an audit
exception. [Node documentation](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions)
defines the replacement's cryptographic v4 behavior.

[Braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists no patched
release; current braces3.0.3 and fast-glob3.3.3/micromatch4.0.8 retain that chain.
The coherent TestFn implementation already uses tinyglobby0.2.17 instead. Audit
results are dated registry evidence for the installed consumers, not proof of
absence of all vulnerabilities, all framework-version compatibility, concurrent
in-process workspace safety or completion of the original17-function rollout.
