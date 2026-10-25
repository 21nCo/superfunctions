# Root Vitest 4 and Cloudflare test runner migration

This follows the separately recorded root 3.2.7 UI patch. Root Vitest and its
matching assertion, formatting, runner, snapshot, spy and utility packages now use 4.1.12. The
isolated npm-exec UI and FileFn contract commands use the same version. The
MailFn Cloudflare test consumer moves with the root runner; other workspace
runner declarations remain unchanged.

## Security and supported runtime

[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)
affects Vitest/mocker versions from 2.1.0 through versions below 4.1.11. Its
standalone public mocker-plugin surface can register filesystem redirects;
Vitest's browser RPC has token protection. This migration selects a patched
version, without treating all test servers as unauthenticated or claiming that
legacy workspace runners are fixed.

The root contributor tools require Node 20.19+, 22.12+, or 24+. MailFn workerd
checks require Node 22.12+ because the maintained plugin's Wrangler and Miniflare
dependencies require Node 22. The MailFn release workflow already uses Node 22.
Published library runtime declarations are unchanged. Existing SearchFn Node 18
consumer coverage remains separate from support for running the root toolchain.

## Cloudflare migration

The deprecated `@cloudflare/vitest-pool-workers` dependency is replaced with
`@cloudflare/vitest-plugin` 1.4.7, whose declared peer supports Vitest 4.1.
The configuration uses `cloudflareTest` as a Vite plugin and `defineConfig` from
Vitest. Existing D1, R2, Queue and compatibility bindings are preserved. The old
`isolatedStorage: false` option is removed: the maintained runner isolates
storage per test file, and this existing single-file suite continues to share
its bindings between its tests. No test assertions were removed. The existing
`cloudflare:test` env/SELF helpers remain supported, though deprecated upstream.

Primary migration references:
[Vitest 3 to 4](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/),
[plugin rename](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/).

Root Vite 5 remains for the existing Svelte 4 Vite plugin. Vitest 4 resolves its
own nested Vite 8.3.5; no Svelte migration is bundled here. The initial real
workerd run exposed mixed formatting modules: root `@vitest/utils` 4 imported
`createDOMElementFilter`, but worker module resolution selected hoisted
pretty-format 3. The explicit matching root pretty-format 4 dependency corrects
that test-tool dependency closure instead of patching installed files. The next
startup exposed the reciprocal legacy runner/utils mismatch (`assertTypes`), so
runner and snapshot are also explicitly aligned. Mocker remains nested under
Vitest 4: a direct root mocker 4 dependency conflicts with the retained root Vite
5 peer and was not retained. No peer bypass was used. The next run reached MailFn imports and reproduced a
CommonJS `sanitize-html` → PostCSS → nanoid export-resolution failure. The
workerd configuration now bundles only that dependency tree through the
[documented optimizer option](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution);
the subsequent real workerd suite passed all 11 existing tests.

## Lock scope and limitations

The lock was regenerated with normal npm 11.21.0. No force, legacy peer flag,
manual lock entry edits or mass workspace manifest upgrades were used.
`vitest4-lock-inventory.json` compares every package path and package/version
identity with c3c819a7f719a3aed8e275bee7b3627de44935fc. It separately lists path
additions using already-present versions, removals, changed versions at the same
path, genuinely new package/version identities, and remaining legacy Vitest
placements. Relocation is substantial because old workspace peers can no longer
share root Vitest 4. The normal resolver also updates compatible transitive
versions; these are listed explicitly, not described as pure relocation.

The isolated UI command bootstraps npm 11.21.0 and fetches exact Vitest/UI
versions into npm's cache. npm 10.9.4 reproduced an Arborist `edgesOut` crash
while resolving optional peers, both with the workspace and an empty prefix.
Normal npm 11.21.0 resolution succeeded; no ineffective prefix wrapper remains. This
cache is outside the repository lock; offline use requires preparing it first.
Scoped installation and selected suites do not prove an all-workspace build,
all optional native adapters, hosted CI, or deployed Cloudflare resources.

Final lock inventory: 3,265 added paths, of which 3,235 reuse an already-present
package/version; 125 removed paths; 31 changed versions at existing paths; 52
new package/version identities. Only root and MailFn Cloudflare workspace
metadata entries change. There are now 223 legacy Vitest placements because
normal peer resolution duplicates the retained versions. The full fresh audit
reports 120 findings (4 low, 52 moderate, 54 high, 10 critical). Legacy mocker
placements, including a hoisted copy used by old runners, remain vulnerable;
the selected root Vitest resolves its own 4.1.12 mocker. This is a scoped
migration, not a clean-toolchain or all-workspace security claim.

The special public `npm test -- --run filefn/server/tests/client-contract.test.ts`
entry now delegates to `test:filefn-server-contract`, removing its independent
old 3.2.4 pin and ensuring it uses the explicit FileFn configuration.

## Validation on 2026-10-23

- Normal npm 11.21.0 lock generation, followed by normal scoped `npm ci` with
  `--workspace=@superfunctions/http --workspace=@superfunctions/db
  --workspace=@mailfn/core --workspace=@mailfn/cloudflare
  --include-workspace-root --no-audit --no-fund`: passed on Node 22.22.1. The
  final install added 693 packages. The same command with `--dry-run` passed.
  npm emitted its default install-script policy warnings; no peer bypass or
  install-script policy override was applied.
- `turbo run build --filter=@mailfn/cloudflare...`: both actual MailFn build
  tasks passed. Cloudflare `tsc --noEmit` and a separate no-emit compilation of
  `vitest.workerd.config.ts` passed, including the plugin/optimizer option types.
- Normal HTTP suite: 66 tests passed; normal DB suite: 220 passed, including
  native SQLite adapter tests. These retained workspace runners report 3.2.7;
  their results prove coexistence, not use of the root Vitest 4 runner.
- Normal MailFn Cloudflare test script after the final clean install: 23 Node
  tests plus all 11 real workerd tests passed on Vitest 4.1.12. The suite exercises
  local D1/R2, Email and Queue handlers, concurrent quota/creation, retention,
  raw MIME/attachment evidence and durable webhook replay. No live Cloudflare
  account, external inbox or deployed resource was used. Registry HTTP package
  source-map warnings remain non-fatal. The plugin locks Miniflare
  5.20261019.2-beta and workerd 1.20261019.1; this is local runtime evidence.
- Exact public `npm test -- --run filefn/server/tests/client-contract.test.ts`:
  1 test passed on Vitest 4.1.12 with Node 20.20.0.
- `node _conduct/verify-vitest-ui.mjs` on Node 22.22.1: actual root UI command
  smoke test passed, HTML and application JavaScript each returned HTTP 200.
  Receipt: port 65070, launcher PID 86141. The owned process group stopped,
  the port refused new connections, and the temporary fixture was removed.
- `node _conduct/verify-vitest-ui.mjs --default-config` on Node 20.20.0:
  the exact UI command ran from an owned temporary caller directory and found
  its default `vitest.config.mjs` without a config/root argument. Smoke and both
  HTTP checks passed; port 49314/PID 91009 stopped and the fixture was removed.
  This proves caller-cwd/default-config preservation. It does **not** validate
  the repository's default DocsFn project selection under a full install.

The first workerd attempts failed before tests because of mixed Vitest modules,
then the CommonJS sanitizer tree. The initial npm 10 UI attempts failed before
starting a server. These failures are retained separately from the successful
final receipts; no assertion, timeout, test exclusion or runtime implementation
was weakened to pass the migration. The old 3.2.7 checkpoint remains unchanged.

No owned npm/test/UI/workerd processes remain. No service containers, browser
settings, deployment, registry publication or Python source were changed. npm
package caches and the normal dependency optimizer cache remain as development
caches. Full workspace compatibility, remaining legacy advisory remediation,
and the existing MailFn live-provider release gates remain open.

Local receipts: `/tmp/shared-vitest4-final-ci.log`,
`/tmp/shared-vitest4-dryrun.log`, `/tmp/shared-vitest4-build.log`,
`/tmp/shared-vitest4-types.log`, `/tmp/shared-vitest4-config-types.log`,
`/tmp/shared-vitest4-http.log`, `/tmp/shared-vitest4-db.log`,
`/tmp/shared-vitest4-final-worker.log`, `/tmp/shared-vitest4-filefn-public.log`,
`/tmp/shared-vitest4-ui3.log`, `/tmp/shared-vitest4-ui-default.log`, and
`/tmp/shared-vitest4-final-audit.json`.
