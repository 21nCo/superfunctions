# TestFn sf-next target acceptance

Base: shared prerequisite commit `745ea7b3c3c5edcbfe79158d5ed16b66e44f852a`, descended from sf-next/next. Function source is replayed from `115997d17`; its Python tree exactly included checkpoint `276e0a3d6`. Existing sf-next `.conduct` artifacts are preserved. The source worktree is unchanged. Earlier acceptance receipts remain historical source evidence; the results below were collected in the clean target worktree on 2026-10-18.

## Target corrections

- Pin coverage-v8 to4.1.11 to match the exact Vitest4.1.11 dependency; the former caret selected an incompatible coverage peer and caused npm11 Arborist failure.
- Resolve Playwright from the declaring TestFn workspace in browser scripts, supporting a normal nested npm installation.
- Run the explicit dependency closure in the acceptance workflow because the existing unrelated ProbeFn workspace cycle prevents Turbo graph construction even with TestFn filters. The workflow also covers Python3.10/3.12 and fresh wheels.
- Persist pytest discovery's project root and use absolute file selectors for execution, preserving class/parameter node IDs and callback IDs when invoked from outside the project. The original wheel failed this actual monorepo-root invocation; the fix passes default and parallel session regressions.

## Clean target and source checks

Standard npm11 scoped lock generation followed by default npm10 `ci` on Node22.22.1 installed876 packages. No force/legacy peer flags or copied origin root lock. Only TestFn's two workspace metadata entries changed in the lock; normal dependency resolution changes352 package entries. Verified realpaths for TestFn core/admin, DB0.4.0, shared admin0.1.5, MCP0.0.6 and observability0.0.1 point into this target worktree.

All six packages build and typecheck. **654 tests pass**: TestFn core50, TestFn admin8, DB216, shared admin109, observability8, MCP263. Core coverage includes all source except types-only declarations: statements91.27%, lines92.68%, functions90.35%, branches82.54%; enforced90% statements/lines/functions thresholds pass.

Python source tests: **20 pass** each on3.10.19 and3.12.12. Strict mypy checks10 source files; Ruff passes. Fresh installed wheels pass the same20 tests on each interpreter and run actual pytest discovery/execution, class/parameter IDs, SQLite reopen, JSON reports and py.typed checks. The3.10 consumer pins runtime floors pytest9.0.3, Pydantic2.5.0, SQLAlchemy2.0.0 and Pillow12.3.0. Both dependency audits report no known vulnerabilities; the local wheel is not a registry-audited package.

## Runtime and packed consumers

- Fresh target tarballs in disposable Linux ARM Firefox 157 pass real DOM/screenshot and offline/restore behavior, expected-failure classification and skip: 3 tests, 2 passed, 1 skipped. The first 30-second process budget timed out; a 120-second retry passed in 93.41 seconds. A direct Playwright probe also completed DOM/screenshot independently. Logs: `/tmp/sf-next-testfn-firefox3.log` and `/tmp/sf-next-testfn-firefox-probe.log`.
- Actual Vitest/Jest pass/fail/skip collection, Playwright Chromium/WebKit, and Puppeteer Chrome:9 acceptance assertions.
- Native Chrome IndexedDB history, binary artifact cleanup and close/reopen pass. Independent-process SQLite/Drizzle history and binary artifacts pass with internal schema ownership.
- Standalone offline HTML/dashboard, visual comparison, browser profiles and cleanup:13 assertions. Local measured store1000results1.89ms; history99runs15.45ms;320x200 PNG comparison25.10ms;100-run dashboard74.34ms;120ms network latency observed138.23ms;10,000 in-process tests26.87ms.
- File storage fixture1000runs×10tests,10KB log/run:2,137,670 bytes; write3056.39ms;1000-point analytics34.67ms; sampled peakRSS119,029,760 bytes and heap30,841,712 bytes. These are bounded local fixture measurements, not arbitrary workload guarantees.
- Fresh tarball consumer passes strict TypeScript5.9 Node16/NodeNext declarations, core runtime on exactNode18.18.0, core/admin on exactNode20.0.0 and current20.20.2/22.23.3, and production audit0. Packed script now includes exact20.0.0 explicitly.
- Actual current CacheFn tarballs under Vitest3.2.7 and4.1.11 pass two tests/five integration assertions; Node18.18 additionally executes the Vitest3 consumer with fresh durable history. Source CacheFn checkout is untouched.

## Remaining original-contract gates

Native Safari27 WebDriver is installed, but session creation returned: `You must enable Allow remote automation in the Developer section of Safari Settings`. The driver was stopped, no session created, and no preferences changed. PlaywrightWebKit is not nativeSafari proof.

Historical IndexedDB browser floors in the original SPEC (Chrome24/Firefox16/Safari10/Edge12) remain an exact-engine validation gap. The module entry emits modern JavaScript; the follow-up standalone distribution supplies ES5 syntax, runtime polyfills and native/prefixed IndexedDB without fake-indexeddb. Modern-browser fallback tests are not exact old-engine proof. The SPEC has not been narrowed. Universal10x speedup, post-release adoption/deployment/SLA goals and hosted CI are not claimed by local fixture tests. Core branch coverage is82.54%, not90%.

## Evidence locations

Logs use `/tmp/sf-next-testfn-` prefixes: `ci.log`, `build.log`, `tests.log`, `types.log`, `coverage.log`, `framework.log`, `idb.log`, `sqlite.log`, `dashboard.log`, `storage.log`, `packed.log`, `packed-final.log`, `node20-minimum.log`, `node18-framework.log`, `cache3.log`, `cache4.log`, `python310-source.log`, `python312-source.log`, `python310-wheel-tests.log`, `python312-wheel-tests.log`, `python310-packed.log`, `python312-packed.log`, `python-mypy.log`, `python-ruff.log`, and Python audit JSON/log files.

Final packed consumer (including the updated exact Node 20.0.0 matrix): `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-packed-consumer-m3uPdG`. Storage fixture: `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-storage-performance-Df17J4`. Python wheels/sdist: `/tmp/sf-next-testfn-python-dist`.

## Standalone browser compatibility follow-up

A classic-script distribution at `@testfn/core/storage/indexeddb-browser` exposes `TestFnBrowser.IndexedDbManager`, uses native/prefixed IndexedDB, bundles runtime polyfills and includes third-party licenses. Build metadata rejects fake-indexeddb inclusion and Acorn parses the complete emitted bundle as ES5. Cleanup queues dependent requests directly from IndexedDB event callbacks so task-based Promise scheduling cannot commit the transaction between requests.

Clean npm 10 installation passes with 974 packages. Core build/typecheck and admin typecheck pass; core 50 tests and admin 8 tests pass. Coverage remains above the enforced gates: statements 91.28%, lines 92.64%, functions 90.35%, branches 82.59%. Chrome and WebKit each pass the shipped bundle's history, binary artifact cleanup and reopen fixture in normal and compatibility modes. Compatibility mode removes native Promise, microtask helpers, flatMap/includes and unprefixed IndexedDB globals. The prior cleanup source from `cccdc6ac1`, bundled with the same polyfills, passes normal mode but times out in compatibility mode; the corrected implementation passes both. Baseline work was isolated in temporary files without modifying the source checkout.

Fresh packed consumer `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-packed-consumer-QA23YX` includes browser bytes identical to the validated build. Strict Node16/NodeNext declarations, exact Node 18.18.0/20.0.0 and current 20.20.2/22.23.3 runtimes pass; production audit reports zero vulnerabilities. Logs: `/tmp/sf-next-testfn-legacy-{ci,build,coverage,admin,types,browser,webkit,baseline,packed}.log`. Exact historical engines and native Safari remain outstanding. All three disposable Firefox container names were confirmed absent after acceptance.
