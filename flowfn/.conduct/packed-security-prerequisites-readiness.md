# Installed Flow dependency security prerequisites

The corrected PostgreSQL partition checkpoint passed its installed runtime and declaration checks but failed the final production audit with six propagated findings. The original audit JSON remains in `packed-partition-audit-20261025.json`; that failure is not erased.

Three narrow changes address the actual paths:

1. Exact McpFn fast-uri prerequisite f9fef208 was applied separately as b19f30fb1: fast-uri 3.1.9 plus the existing anonymous-root compatibility fix and tests.
2. McpFn build input now pins Zod 4.6.6 and aliases every SDK Zod subpath to that input, with source-map byte verification. This is separate commit 629555a2a. Dependency audits do not inspect previously embedded runtime bytes, so this build check is necessary.
3. Flow core removes its unused Zod dependency. Source, tests, admin source, root dependency metadata and generated public declarations contain no Zod import or exposed Zod type. No Flow schema behavior or parser defaults change. The normal npm-generated lock delta for this removal is only the Flow package dependency entry.

The actual Turbo 2.6.1 dry graph contains the six runtime packages (observability, HTTP, McpFn, shared admin, Flow core and Flow admin). Existing root development dependencies also select eight Probe build tasks; those unrelated tasks are not part of the six-tarball production closure and are not claimed as validated here.

Final validation on October 25, 2026:

- Source and test TypeScript checks passed. Flow core: 180 passed, with 93 native tests skipped only in that no-service invocation. Flow admin: 15 passed.
- Explicit six-package Turbo build: all six succeeded, zero cache hits. McpFn's bundle-byte gate ran as part of its build.
- Owned Redis 8.10.2 and PostgreSQL 16.13: all 93 native tests passed in 28.68 seconds. Owned PIDs 92215/92216 stopped and private `flow-owned-native-y21qarbr` data removed/read back absent.
- Fresh six-tarball consumer: normal npm install and clean ci, strict Node16/NodeNext declarations, ESM/CJS core/admin entry points on Node 20.0.0, 20.20.0 and 22.23.3 passed. Actual installed PostgreSQL partition routing, independent connections, retention barrier, reopen and policy checks passed. Final production audit: zero findings across all severities.
- Installed native PIDs 93627/93628 stopped; private `flow-owned-native-mkrgd0d5` data and the owned npm consumer were removed. No deployed provider, live account resources or external sends were used.

Executable checks remain `mcpfn/core/scripts/verify-bundled-zod.mjs`, `mcpfn/core/scripts/packed-runtime-acceptance.mjs` and `flowfn/typescript/scripts/packed-consumer-acceptance.mjs` (set an owned loopback `FLOWFN_POSTGRES_URL` for native coverage). The final compact installed receipt is retained in `packed-partition-security-pass-20261025.jsonl`.

 This checkpoint does not close Memory/Redis/Python partition parity, original performance targets, deployment acceptance or unrelated workspace advisories.
