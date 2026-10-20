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

## Remaining original gates

| Gate | Existing evidence and exact next step |
| --- | --- |
| Packaged TestFn composition | Actual local runner/CLI fixture lifecycle now passes. Build and pack both selected releases into a fresh consumer, resolve optional framework dependencies, and rerun before claiming packaged compatibility. |
| Native Safari | V0_SPEC.md line882 names Safari. `typescript/scripts/browser-acceptance.mjs` supports Playwright Chromium/Firefox/WebKit only; WebKit is not native Safari. Execute the IndexedDB namespace, TTL, tags, quota and persistence contract using an actual Safari driver/host. |
| Firefox | Run the existing script with `BROWSER_ENGINE=firefox` and a compatible installed Playwright engine/host. No Firefox execution was added or claimed here. |
| Broader full specification | SPEC.md includes additional advanced patterns and distributed tiers beyond the explicit V0 scope. This fixture acceptance does not establish those capabilities or overall production readiness. |

This change adds integration acceptance and corrects the dependency evidence. It makes no CacheFn runtime or Python behavior changes and does not claim hosted CI, publishing or deployment.
