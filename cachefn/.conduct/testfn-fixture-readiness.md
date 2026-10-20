# TestFn fixture lifecycle integration

2026-10-20 UTC. CacheFn V0_SPEC.md lines746–770 requests cached test fixtures with setup and cleanup. Its example calls `testFn.beforeAll` and `testFn.afterAll`, but the tracked TestFn entrypoint (`testfn/typescript/src/index.ts`) exports a factory returning `TestRunner`, not those hooks. `TestRunner.run()` delegates to framework adapters. Vitest owns `beforeAll`/`afterAll`; TestFn executes the suite through its public runner API.

The earlier README statement that TestFn was absent from this base was inaccurate. `git ls-files testfn/typescript` and `git show HEAD:testfn/typescript/src/index.ts` confirm tracked source; the current sparse checkout includes CacheFn/shared packages and all package manifests, but omits TestFn implementation files. No sparse patterns or TestFn files were changed.

## Actual acceptance

`typescript/scripts/testfn-acceptance.mjs` creates disposable real Vitest suites and runs them using `testFn({framework: 'vitest', ...}).run()`:

- `beforeAll` prepares a dataset using CacheFn `getOrFetch`.
- Two assertions prove the same prepared fixture is reused, including concurrent consumers, with exactly one loader call.
- `afterAll` clears the cache and writes a receipt; the parent verifies zero remaining entries.
- A second suite deliberately fails an assertion. The parent requires a failed TestFn result with the actual assertion message, zero passing assertions, and a cleanup receipt with an empty cache.
- Temporary suites and receipts are removed, and the working directory is restored. No mock runner or fake framework adapter is used.

Validation passed on Node20.20.0 with the installed Vitest4.1.11 CLI, freshly built CacheFn ESM/CommonJS/declarations, and the sibling TestFn readiness build at `e8e3fd94d`. Reproduce from the repository root:

```sh
npm --prefix cachefn/typescript run build
CACHEFN_TESTFN_CORE=/absolute/path/to/testfn/typescript/dist/index.js node cachefn/typescript/scripts/testfn-acceptance.mjs
```

Without the environment override the script resolves this checkout's TestFn build. The explicit build override is a prerequisite selection, not an npm release or fresh consumer installation. The tracked older TestFn implementation and registry package were not substituted for the selected readiness build.

## Fresh packaged consumer

`typescript/scripts/testfn-packed-acceptance.mjs` packs the four built local packages below, installs them with Vitest4.1.11 and Drizzle0.45.4 in a newly created consumer, checks the lockfile's local tarball resolutions, and invokes the same genuine fixture lifecycle checks. The SDK and Vitest paths are canonicalized and required to be inside the consumer's `node_modules`; the runner resolves the actual Vitest CLI from the consumer working directory. No source aliases or workspace symlinks are used. The temporary consumer, tarballs and fixtures are removed on completion or failure.

The final run, repeated after the priority-clear correction, passed on Node20.20.0/npm11.21.0. npm10.8.2 failed first with its internal `Cannot read properties of null (reading 'edgesOut')` resolution error; no force/legacy-peer flags or dependency overrides were added. `CACHEFN_NPM_CLI` explicitly selects the installed npm11 CLI. Reproduce with:

```sh
CACHEFN_NPM_CLI=/absolute/path/to/npm/bin/npm-cli.js CACHEFN_TESTFN_WORKTREE=/absolute/path/to/testfn-readiness-worktree node cachefn/typescript/scripts/testfn-packed-acceptance.mjs
```

| Local tarball | SHA256 |
| --- | --- |
| cachefn-core-0.0.3.tgz | e7ac237ceb9469530d21085d40d672d1213aa6789a48cea5d630076919431ed3 |
| testfn-core-0.0.4.tgz | dd78f301b07528aceb04501dd343e02bae3c8fe27741d1f6d9007aceb1444e0e |
| superfunctions-db-0.4.0.tgz | 7db58fc5bce6ef2bfa116d84c5fe818e00242de6b9eea28a8393ecf722be0513 |
| superfunctions-observability-0.0.1.tgz | 55d2342930c08fa56725f692f5ab7161c11ac3e9dc0f2db8adea366efa2951a3 |

The CacheFn tarball contains the current README and built runtime. Other tarballs come from the explicitly selected TestFn readiness tree at `e8e3fd94d`. This is the Vitest runtime composition gate, not a full dependency audit, alternate-framework matrix, registry release, or deployment claim.

## Remaining original gates

| Gate | Existing evidence and exact next step |
| --- | --- |
| Packaged TestFn composition | Actual local runner/CLI lifecycle and the fresh local-tarball consumer both pass, including failure propagation. Registry publication and other framework combinations are not established. |
| Native Safari | V0_SPEC.md line882 names Safari. `typescript/scripts/browser-acceptance.mjs` supports Playwright Chromium/Firefox/WebKit only; WebKit is not native Safari. Execute the IndexedDB namespace, TTL, tags, quota and persistence contract using an actual Safari driver/host. |
| Firefox | Run the existing script with `BROWSER_ENGINE=firefox` and a compatible installed Playwright engine/host. No Firefox execution was added or claimed here. |
| Broader full specification | SPEC.md includes additional advanced patterns and distributed tiers beyond the explicit V0 scope. This fixture acceptance does not establish those capabilities or overall production readiness. |

This change adds integration acceptance and corrects the dependency evidence. It makes no CacheFn runtime or Python behavior changes and does not claim hosted CI, publishing or deployment.
