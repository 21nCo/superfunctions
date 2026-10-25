# Root Vitest patch and isolated UI

The root runner and matching expect/spy/utils dependencies move from 3.2.4 to
3.2.7. The FileFn contract command uses that version and its existing server
configuration explicitly. Without the explicit config, root Vitest project
selection initializes unrelated DocsFn Svelte projects, which fail under a scoped
HTTP/DB installation before the requested FileFn test is collected.

## Dependency resolution

Root `@vitest/ui` is removed from the dependency graph. Its optional exact-version
peer relationship conflicted with older workspace Vitest runners (first observed
at HostFn 1.6.1). Normal npm 11 install, targeted update, root-only install, nested
strategy and npm 10 install all rejected that conflict; no force or legacy peer
flag was used. A temporary UI workspace did not resolve the inherited conflict
and was removed. No tooling workspace was retained.

UI functionality remains available through `npm run test:ui -- <options>`.
The command explicitly requests both `vitest@3.2.7` and `@vitest/ui@3.2.7` through
npm exec and enables watch mode, using npm's isolated package cache instead of
exposing UI as an ancestor dependency of every legacy workspace. First use may
fetch these exact packages from npm; this cache is outside the repository lock.
Consumers needing an offline UI must prepare that cache beforehand. Headless
root tests continue to use the locked root Vitest dependency.

Normal `npm uninstall @vitest/ui --package-lock-only` followed by normal npm
install regenerated the lock. npm dedupe and targeted updates exposed another
pre-existing ApiFn/TestFn optional-peer conflict; neither was used to force a
resolution. The retained generated lock preserves unrelated workspace manifests
and exact runner versions. Consequently exact 3.2.4 pins now need nested peer
trees instead of sharing the patched root runner. The large textual diff is
predominantly dependency relocation, not blanket workspace upgrades.

`vitest-security-lock-inventory.json` records the exact comparison with the base:
524 new paths, 2 removed UI paths, and 5 changed existing versions (four root
Vitest packages plus check-error 2.1.1 to 2.1.3). The only newly introduced
package/version combinations are picomatch 4.0.7 and tinyspy 4.0.6; Vitest 3.2.7
already existed elsewhere in the prior graph. All 66 remaining older Vitest
placements are listed explicitly. No lock entries were edited manually.

## Security scope

The fresh npm advisory response reports the critical UI issue
[GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) for versions
below 3.2.6, so the selected root/UI command versions are outside that range.
This is **not** a clean-toolchain claim. The same current advisory response flags
Vitest 3.2.7 under the moderate mocker redirect issue
[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), whose range
is >=2.1.0 and <4.1.11. The full graph audit returned 122 findings (4 low,
52 moderate, 56 high, 10 critical), including deliberately unchanged workspace
runners. Updating root to Vitest 4 additionally requires assessing the Cloudflare
pool's currently declared Vitest 2.0.x–3.2.x peer support; that is not included.

## Validation on 2026-10-23

Node 20.20.0, npm 11.21.0 for lock generation and scoped install; the root UI
script and test commands used the available npm 10.8.2 launcher:

- Normal `npm ci --workspace=@superfunctions/http --workspace=@superfunctions/db
  --include-workspace-root --no-audit --no-fund`: passed. No peer bypass or
  ignore-scripts flag. npm 11 emitted its default blocked dependency-install-script
  warnings and engine warnings for unrelated workspaces; no policy override was
  applied. This is scoped installation evidence, not an all-workspace build or
  native-provider acceptance.
- The same scoped CI command with `--dry-run`: passed.
- Root-installed runner reported 3.2.7; HTTP: 66 tests passed; DB: 220 passed.
- `npm run test:filefn-server-contract`: 1 test passed with the explicit config.
- `node _conduct/verify-vitest-ui.mjs`: actual root UI command ran an isolated
  smoke test, served HTML and application JavaScript with HTTP 200, then the owned
  process group was terminated and the loopback port refused new connections.
  Receipt: port 49358, owned launcher PID 99238. Temporary fixture directory was
  removed. The first noninteractive attempt exited after tests before HTTP probing;
  explicit watch mode corrected the command's lifetime.

No browser settings, external deployment, service container or registry
publication changed. No owned test/UI/npm processes remain. Local receipts:
`/tmp/shared-vitest-final-lock.log`, `/tmp/shared-vitest-scoped-ci.log`,
`/tmp/shared-vitest-final-dryrun.log`, `/tmp/shared-vitest-ui-runtime2.log`,
`/tmp/shared-vitest-http-tests.log`, `/tmp/shared-vitest-db-tests.log`,
`/tmp/shared-vitest-filefn-contract2.log`, `/tmp/shared-vitest-audit.json`.
