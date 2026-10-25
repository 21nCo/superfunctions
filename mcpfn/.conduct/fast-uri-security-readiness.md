# URI security dependency checkpoint

The core package now requires fast-uri 3.1.9. This addresses the published URI parsing/canonicalization advisories [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), and [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp).

Anonymous JSON Schema roots retain literal relative-dot references through a narrow resolver adaptation. Authored resource paths, encoded dots, queries, absolute paths, authority references and private resource identifiers retain the patched resolver behavior. Both schema validation and the Ajv resolver use this rule.

## Validation

Node 22.22, normal npm 11 workspace installation and lock generation, without force or peer bypass:

- Core suite: 266 tests passed (`/tmp/probe-fast-uri-tests-final.log`).
- Core TypeScript and ESM/CJS/declaration build passed (`/tmp/probe-fast-uri-types-final.log`, `/tmp/probe-fast-uri-build.log`).
- Fresh packed core installation: ESM and CJS consumers exercised Ajv and CF-worker recursive dot references, rejection of encoded malicious schemes/private resource references, ordinary CF-worker pointers and encoded Ajv pointers. Production audit reported zero vulnerabilities. Owned installation was removed (`/tmp/probe-fast-uri-consumer-final.log`).

The first fresh consumer failed on CF-worker encoded-separator pointers. Exact baseline ab46ab98bf6701f0d35110f000b06e8f2d2286ae with fast-uri 3.1.8 reproduced that same unsupported CF-worker reference; Ajv succeeds. This pre-existing compatibility gap remains open, and is not counted as covered by the final ordinary-pointer CF-worker matrix. Receipts: `/tmp/probe-fast-uri-consumer-diagnostic.log` and `/tmp/probe-fast-uri-baseline-exact.log`. Both owned fixtures were removed.

This checkpoint does not resolve the separate Probe Zod advisory or the entire monorepo dependency graph.
