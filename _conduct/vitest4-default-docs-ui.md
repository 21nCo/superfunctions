# Repository default Vitest UI project compatibility

Base checkpoint: 35d92dd8321ea2c45e908f38d80e9c01bdae39ab.
The root `vitest.config.ts` selects the existing DocsFn Svelte, SvelteKit and
SvelteKit example projects. This acceptance exercises those actual projects,
rather than substituting an isolated UI smoke test. All three remain selected.

## Reproduced dependency setup gap

A normal scoped npm 11.21.0 CI install selected the three package names plus the
root and completed (946 packages), but root `vitest list --filesOnly` failed
while loading the example's Svelte configuration: `@sveltejs/adapter-auto` could
not be resolved. The root workspace patterns contained `docsfn/*`, not the
nested example. The example was absent from the lock's workspace graph, and a
standalone `npm ls --workspace=@docsfn/example-sveltekit-docs-site` confirmed
that npm did not recognize it. Multiple workspace selectors had not made the
successful install evidence sufficient to prove this package was included.

The root now includes the exact existing `docsfn/examples/sveltekit-docs-site`
workspace. Its source imports DocsFn core, filesystem provider, Svelte components
and SvelteKit helpers, so those four existing local package versions are declared
as dependencies. Normal npm lock generation adds 29 paths and changes no
existing resolved package versions. No other examples or unrelated framework
upgrades are included.

## Reproduced test and UI defects

After the normal install and the required DocsFn dependency builds, root Vitest
4.1.12 discovered all nine intended test files. Its first run passed 30 tests and
failed three example route assertions: fixture roots were relative to the process
working directory rather than the test module. The example now resolves fixture
paths from `import.meta.url`. The same root command then passed all 33 tests in
nine files; no assertions, projects, or test timeouts were removed or weakened.

The initial real repository UI served its assets but ran only the seven Node
SvelteKit tests. Eight jsdom workers failed startup because the isolated UI's
Vitest could not resolve jsdom. Vitest's JSON report still reported `success: true`
and zero failed tests. The acceptance now checks exact discovered file coverage,
all passed/total test counts, and absence of unhandled-error reporting in addition
to HTTP assets. It rejected this partial run.

Adding `--package=jsdom@27.4.0` alone did not fix it. npm exec's installed source
skips requested packages already present in its local tree. The actual cache
manifest listed all three requested packages in `_npx.packages` but only
`@vitest/ui` in dependencies; its optional Vitest peer had no jsdom sibling.
The launcher now gives the inner npm 11 exec an owned empty prefix, resolving
Vitest 4.1.12, UI 4.1.12 and jsdom 27.4.0 together. It retains the caller's cwd and
forwards arguments as array entries, without shell interpolation. npm 11 remains
necessary for the previously reproduced npm 10 optional-peer resolver failure.
The prefix is removed after shutdown; normal npm cache contents are retained.
No global npm installation or manifest is changed.

## Process ownership

On POSIX, the npm child starts in its own process group. Shutdown checks that
group even if npm exits before descendants, sends TERM, allows five seconds,
then sends KILL with another five-second disappearance check. Failed cleanup
retains the prefix and reports the failure. The HTTP acceptance allows twelve
seconds for this inner cleanup before its own emergency stop.

The controlled shutdown acceptance starts an owned fake npm process that exits
while its child ignores TERM. It verifies escalation removes that descendant,
the prefix is removed, a literal argument with spaces and shell metacharacters
arrives unchanged, cwd resolves to the caller's directory, and an independent
exit-code-7 invocation retains that result. An initial fixture-only assertion
compared macOS `/var` with `/private/var`; it now compares canonical paths.

Windows uses `taskkill /PID <owned-pid> /T /F` without a shell, with a bounded
helper process. Those switches target the launched process and its descendants
([Microsoft taskkill documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)).
Windows requires the public `npm run test:ui` entry so `npm_execpath` is available.
No Windows host was available: actual Windows tree cleanup, including natural
npm exit before descendants, remains unverified. If the direct Windows child
already exited, its result is preserved without claiming all descendants stopped.
For a still-live child, a taskkill failure is reported
and retains the prefix instead of asserting successful cleanup. This acceptance
proves POSIX process-group behavior only; it is not a Windows acceptance claim.

## Reproduction commands

Commands run from the repository root with Node 22.22.1 and npm 11.21.0:

```sh
npm ci --workspace=@docsfn/svelte --workspace=@docsfn/sveltekit \
  --workspace=@docsfn/example-sveltekit-docs-site --include-workspace-root \
  --no-audit --no-fund
npx turbo run build --filter=@docsfn/core... --filter=@docsfn/provider-fs... \
  --filter=@docsfn/sveltekit...
./node_modules/.bin/vitest list --filesOnly
./node_modules/.bin/vitest run
node _conduct/verify-vitest-ui.mjs --repository
node _conduct/verify-vitest-ui.mjs
node _conduct/verify-vitest-ui.mjs --default-config
node _conduct/verify-vitest-ui-shutdown.mjs
```

The scoped CI install completed with 964 packages. A preceding incremental
install encountered npm's internal `edgesOut` failure; the normal clean CI
install succeeded without force or peer-dependency bypass. Dependency builds
passed 13 Turbo tasks. The actual repository UI ran all 33 tests in nine files
and served both HTML and its JavaScript with HTTP 200; shutdown refused a
subsequent connection on its selected port. Final launcher smoke/default-caller
and legacy package receipts follow below.

## Scope and remaining limits

The normally generated lock adds 29 paths (the example workspace/link and its
existing-version dependency placements), removes none, and changes no existing
resolved package versions. Metadata changes are the root workspace list, six
production/development classification adjustments from the example dependency
graph, and npm's bundled libsql wasm entry classification. No dependency version
was manually edited in the lock. The example's existing Vitest 3.2.x range stays
unchanged and resolves 3.2.7 locally; root Vitest 4 is a separate runner.

This closes the repository-default DocsFn UI selection gap, not compatibility of
every monorepo workspace with Vitest 4. Legacy Vitest advisories and the broader
lock/security findings recorded in `vitest4-worker-migration.md` remain open.
Existing Vite/Svelte deprecation and accessibility warnings were not suppressed.
No DocsFn Python implementation is present in this scope. No provider, release,
or deployment acceptance is inferred from these local checks.

## Final receipt

- Root direct Vitest 4.1.12: 9 files, 33 tests passed (4.04 seconds).
- Actual repository UI: the same 9 files/33 tests passed; HTML and JavaScript
  HTTP 200; selected port 51813 refused connections after shutdown.
- Final isolated-config and caller-default-config UI fixtures both passed on
  Node 20.20.0; assets HTTP 200 and ports 55621/55644 closed. The latter invokes
  the absolute launcher from a temporary caller directory without `--config`.
- Controlled POSIX descendant fixture passed on Node 20.20.0, including forced
  termination after TERM was ignored, caller cwd/argument identity, removed
  prefix, and preserved independent exit code 7.
- Existing package-local Vitest 3.2.7 remained operational: DocsFn Svelte's
  7 files/21 tests passed, and the example's 1 file/5 tests passed.
- Newly registered example's full Turbo dependency build passed 19/19 tasks
  (13 cached), including its actual SvelteKit client/server build. Adapter-auto
  reported no detected deployment target, and Turbo noted its unconfigured
  `.svelte-kit` output cache path; these are not deployment acceptance.
- Failed intermediate UI ports 63267/64630 were explicitly checked and refused
  connections; no owned UI processes remained. Each acceptance removes only
  its own temporary fixture/prefix; npm caches are retained.

Evidence logs for this run are `/tmp/shared-docs-ui-tests2.log`,
`/tmp/shared-docs-ui-repository3.log`, `/tmp/shared-ui-final-smoke.log`,
`/tmp/shared-ui-final-default.log`, `/tmp/shared-ui-shutdown-final.log`,
`/tmp/shared-docs-legacy-svelte.log`, `/tmp/shared-docs-legacy-example.log`,
and `/tmp/shared-docs-example-build.log`. The scripts above reproduce durable
acceptance rather than requiring these temporary logs to remain on a host.

The final `npm ci --dry-run` on the populated tree encountered npm 11's internal
`Cannot read properties of null (reading 'edgesOut')` error. This is not a green
dry-run receipt. The earlier actual clean scoped `npm ci` succeeded with this
workspace/dependency graph and supplied the installed packages used for all
checks above; no dependency versions changed afterward. Incremental/dry-run npm
Arborist reliability on this mixed workspace graph remains a tooling limitation.
