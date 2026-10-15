# CacheFn naming and publication graph — 2026-10-15

Read-only npm registry checks used `npm view <name> name version maintainers
repository dependencies dist-tags --json`. No package was published.

## Existing name compatibility

The repository's general single-function naming rule prefers `cachefn`, but that
npm name is already the unrelated package `cachefn@1.0.3`, maintained by Darkhogg
and linked to `Darkhogg/node-cachefn`. The existing `@cachefn/core@0.0.2` belongs to
21native (`npm@21n.org`) and links to `21nCo/super-functions`. Its registry directory
metadata still says `cachefn/ts-sdk`; the local package already corrects that path
to `cachefn/typescript`. Preserve `@cachefn/core` as an explicit historical naming
exception: renaming to `cachefn` would resolve another maintainer's library and
break existing consumers. No ownership transfer or new name is assumed.

Primary metadata: [cachefn](https://registry.npmjs.org/cachefn),
[@cachefn/core](https://registry.npmjs.org/@cachefn%2fcore).

## Public dependency graph and minimal release order

| Package | Public registry state | Local change requiring a release |
| --- | --- | --- |
| `@mcpfn/core` | latest 0.0.5; SDK 1.29.0, fast-uri 3.1.5, AJV ^8.17.1 | Patched runtime and SDK 1.32.1, fast-uri 3.1.8, AJV ^8.18.0 |
| `@superfunctions/admin` | latest 0.1.4; exact `@mcpfn/core: 0.0.5` | Must select the new MCP release |
| `@cachefn/core` | latest 0.0.2 | Cache runtime fixes/new V0 features cannot replace the existing immutable release |
| `@cachefn/admin` | Public lookup returns E404 | Local 0.1.0 currently selects exact Cache core 0.0.2 and shared admin 0.1.4 |

Primary metadata: [MCP core](https://registry.npmjs.org/@mcpfn%2fcore),
[shared admin](https://registry.npmjs.org/@superfunctions%2fadmin).
E404 means no publicly discoverable Cache admin package; it does not independently
prove private-package/name availability.

Recommended minimum version chain, subject to the release owner's final SemVer
classification and registry availability at release time:

1. Publish `@mcpfn/core@0.0.6` with the patched runtime/dependencies.
2. Change shared admin's exact dependency to that version and publish
   `@superfunctions/admin@0.1.5`.
3. Publish the changed Cache core at a fresh version, minimally `@cachefn/core@0.0.3`
   (a pre-1.0 minor version can be chosen if the release owner wants to signal the
   namespace/memoization compatibility decisions more prominently).
4. Publish `@cachefn/admin@0.1.0` only after its exact dependencies select the new
   Cache core and shared admin versions. If 0.1.0 is unavailable/private, choose a
   fresh owned version after verifying scope access.

MCP and shared-admin changes can be a prerequisite PR/release; Cache core can be
released independently, but Cache admin depends on both chains. After each
publication, verify registry metadata and perform a clean install/audit using only
registry-resolved dependencies. A tarball test that substitutes patched local MCP
and shared-admin artifacts proves those artifacts, not the current public graph.
Current local package manifests are not version-bumped by this report; publishing
still requires explicit release authorization.
