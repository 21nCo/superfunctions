# TestFn readiness acceptance — 2026-10-16

Local production code and original V0 contract acceptance; no publication, push, hosted deployment or hosted CI result claimed.

## Source gates

- Clean npm10.8.2 scoped `npm ci --ignore-scripts --no-audit --no-fund -w @testfn/core -w @testfn/admin`: 868 packages, followed by successful native better-sqlite3 rebuild. Log `/tmp/testfn-clean-ci.log`.
- Turbo2.6.1 `run build test typecheck --filter=@testfn/core --filter=@testfn/admin`: 10 tasks passed, 36 core tests and 8 actual shared-dispatcher admin tests. Log `/tmp/testfn-final-gates.log`.
- Shared DB0.4.0 prerequisite commits dabaf5123 and 87236396a cherry-picked as 1b05e33eb and a2add7842. Parent Python checkpoint276e0a3d6 retained; Python evidence is separately recorded in python-readiness.md.

## Actual execution

- `TESTFN_BROWSERS=chromium,webkit node testfn/scripts/framework-acceptance.mjs`: 9 assertions; actual Vitest, Jest, Playwright Chromium/WebKit, Puppeteer Chromium, individual pass/fail/skip, expected failure and context/device behavior. Log `/tmp/testfn-framework-final.log`.
- Actual local tarballs installed in disposable Docker Desktop Linux `node:22-bookworm`, Node22.23.3, Playwright1.64.1 Firefox1555. TestFn ran real DOM and screenshot checks, offline/restore, expected failure and skip: total3, passed2, skipped1, failed0. Log `/tmp/testfn-firefox-linux.log`, fixture `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-firefox-linux-J8AO5K`. Container exited0 and was automatically removed; docker ps image filter returned empty. This closes Firefox execution despite independent macOS27 profile-launch failure. No cloud resources used.
- `node testfn/scripts/indexeddb-browser-acceptance.mjs`: real Chrome durable IndexedDB history, artifacts, cleanup and reopen. Log `/tmp/testfn-idb-final.log`.
- `node testfn/scripts/sqlite-acceptance.mjs`: independent-process SQLite/Drizzle run/history/binary artifact round trip without caller adapterSchema. Log `/tmp/testfn-sqlite-final.log`.
- `node testfn/scripts/dashboard-profiles-acceptance.mjs`: 13 real browser assertions including offline dashboard, visual viewer, histories, latency and network cleanup. Fixture measurements: store1000results2.1667ms; history99runs30.8702ms; compare320x200PNG22.072ms; dashboard100runs51.7511ms; CDP120ms latency observed135.038ms; in-process10000tests17.7776ms. These are local fixture measurements, not universal performance guarantees. Log `/tmp/testfn-dashboard-final.log`.

## Packed delivery

- `node testfn/scripts/packed-consumer.mjs` latest source: actual local tarballs for observability, DB, MCP, shared admin, TestFn core/admin; isolated npm install and npm10 ci dry-run; strict TS5.9 Node16/NodeNext .mts and dynamic-import .cts declarations passed. Core runtime Node18.18.0, core/admin Node20.20.2 and22.23.3 passed.
- Isolated `npm audit --omit=dev`: zero vulnerabilities, 158 production dependencies (161 total including compiler tooling). Log `/tmp/testfn-packed-final2.log`, retained consumer `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-packed-consumer-mYfQwi`.
- Actual CacheFn tarball integration, source copied to isolated temp and original CacheFn checkout untouched: cache TTL/tags/async coalescing under real Vitest3.2.7 and4.1.11, TestFn durable file history and individual assertions; 2 tests and5 integration assertions passed. Node18.18+Vitest3 also passed. Logs `/tmp/testfn-cachefn-final.log` and `/tmp/testfn-node18-framework.log`; final Vitest4 consumer `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-cachefn-eKvuL3`.

## Delivery qualifications

Core0.0.4 and admin0.1.0 remain unpublished. Shared DB0.4.0 and shared admin0.1.5 must be delivered first; source stack contains prerequisites. Root Python0.0.2 is separately validated. New Ubuntu acceptance workflow preserves all three browser engines and full package checks; hosted execution is still pending. Original requirements mapping is in typescript-requirements-audit.md. Remaining explicit validation: historical IndexedDB browser minimums and native Safari. Full-source coverage and memory/storage fixture measurement are recorded below; post-release adoption/SLA goals and explicit future roadmap are not local acceptance claims.

## Coverage and storage follow-up

Matching @vitest/coverage-v8 4.1.11 added with reproducible test:coverage script; coverage explicitly includes src/**/*.ts excluding only types.ts. 50 core tests:91.27%statements,92.68%lines,90.35%functions,82.54%branches.90% thresholds enforce statements/lines/functions. Added tests exercise cancellation/concurrent-run guards, malformed reports, uncapped1001run trends, metric cache invalidation, network protocol failures and cleanup, atomic chunk replacement/rollback/corruption, and Node reporter events. Found and fixed console all-skipped runs falsely claiming allpassed and using epoch-based duration.

`node testfn/scripts/storage-performance-acceptance.mjs` retains `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/testfn-storage-performance-H7Mulk/measurements.json` and actual1000run database.10tests/run,10KBlog/run;2,137,670diskbytes,2276.89mswrite,31.19ms1000-pointanalytics. InitialRSS45,465,600;peak105,512,960;final103,301,120bytes. Peakheap27,797,048bytes. These are sampled process metrics and bounded data sizes, not a universal memory or compression guarantee.
