# Shared runtime dependency acceptance — 2026-10-15

Base: `origin/dev` at `5c0276d2e10d5d91472d9dde4347a651db048a62`.
Branch: `codex/mcp-runtime-dependencies-20261015`.

## Release changes

- `@mcpfn/core` 0.0.6: official MCP SDK 1.32.1, Ajv minimum 8.18.0, fast-uri 3.1.8.
- The Ajv URI resolver preserves fast-uri's authority normalization and adapts JSON Pointer fragments so percent escapes are decoded exactly once. All draft-specific profile compilers use the same adapter. The obsolete fast-uri ambient declaration is removed in favor of upstream types.
- `@superfunctions/admin` 0.1.5 depends exactly on core 0.0.6. No admin runtime code changes.
- Root fast-uri override moves from 3.1.5 to 3.1.8 so workspace resolution does not force the new core back onto the previous version.

## Validation

On macOS arm64, npm 10.8.2:

- Core build (ESM/CJS/declarations), admin build, and both typechecks pass.
- Core 259 tests / 7 files pass on Node 20.20.0 and the exact supported minimum Node 20.0.0.
- Admin 109 tests / 7 files pass on Node 20.20.0 and its exact supported minimum Node 20.0.0.
- Core 259 tests pass on its exact minimum Node 18.18.0 with `NODE_OPTIONS=--experimental-global-webcrypto`.
- Without WebCrypto, Node 18.18.0 passes 256 tests but fails three HTTP initialization tests. A packed HTTP probe returns `ReferenceError: crypto is not defined` from the SDK's stream-ID generation. SDK 1.29.0 also uses global `crypto.randomUUID()` here; this is a pre-existing runtime prerequisite, now documented. Node 18 schema/in-memory tests work without the flag. Admin does not claim Node 18 support.
- Eight new URI tests cover encoded separators, literal percent escapes, escaped slash/tilde tokens, Unicode tokens, and preservation of authority handling.
- `npm ci --dry-run --workspace @mcpfn/core --workspace @superfunctions/admin --ignore-scripts --no-audit --no-fund` passes. The full-workspace `npm ci --dry-run --ignore-scripts --no-audit --no-fund` also passes. These validate resolution; they are not full-workspace runtime tests.
- Reproducible packed consumer: `NODE18=/path/to/node18 NODE20=/path/to/node20 NODE_OPTIONS=--experimental-global-webcrypto node mcpfn/core/scripts/packed-runtime-acceptance.mjs`. Build both packages first. The script packs actual distributions, creates an isolated consumer without root overrides, installs both tarballs, checks ESM/CJS schema behavior, performs official-client in-memory tool list/call/invalid-input round trips, initializes HTTP, and checks admin cursor scope rejection on supported Node versions. Temporary files are removed in `finally`.
- Packed consumer on Node 18.18.0 (WebCrypto enabled) and Node 20.0.0 passes; production `npm audit --omit=dev` reports **0 vulnerabilities** across all severities. Node 20.0.0 also passed the full core/admin suites without the flag.

## Lockfile and existing consumers

Generated with scoped npm 10.8.2 install and a second package-lock-only reconciliation, not hand-built. The lock has 73 added nodes, two removed nodes, and six changed existing entries. Existing package versions change only for the two released workspaces, SDK 1.29.0 → 1.32.1, and root fast-uri 3.1.5 → 3.1.8; two existing dependency entries change only dev flags.

The additions are consequences of preserving exact old consumer pins: eight workspaces now need published core 0.0.5 copies, and superconsole retains published admin 0.1.4. Their older SDK transitive graphs are represented in the lock. npm 10 retains eight nested fast-uri 3.1.5 entries for those old consumers despite the new root override. Both scoped and full dry-run installs accept this lock. No assertion is made that those older consumers or the entire monorepo are security-clean; the zero-audit result applies to the new isolated packed graph. Updating old consumer pins belongs to their own releases.

## Publication dependency order

Nothing has been pushed or published by this checkpoint. Publish and verify core 0.0.6 first, then shared admin 0.1.5. A fresh registry consumer must be installed and audited after publication; local tarball success does not change the currently published dependency graph.

The separate CacheFn release should use `@cachefn/core` 0.0.3 and `@cachefn/admin` 0.1.0 with exact dependencies on `@cachefn/core` 0.0.3 and `@superfunctions/admin` 0.1.5. Keep the existing owned scoped CacheFn name; the unscoped registry name belongs to another project. Cache core can publish independently, while Cache admin waits for both dependencies. Other function consumers adopting shared admin 0.1.5 must update their own manifests deliberately.
