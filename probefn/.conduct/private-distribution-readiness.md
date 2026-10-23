# Private compiled CLI, MCP and admin distribution

2026-10-23; starts from be71f645afc74846dd6fb3b155660b1b29a29e64.

## Original requirement and reproduced gap

ARCH-001 requires the package responsibilities to compile under shared TypeScript
configuration. API-001/API-002 require directly consumable CLI/MCP surfaces;
CONFIG-001 and RUNTIME-001 require configuration/artifacts rooted in the local
consumer project. The existing root-npm/Turbo migration remains authoritative;
this change does not restore a nested pnpm monorepo or claim all original vectors.

A normal private tarball install of @probefn/contracts failed on Node22.22.0 with
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING because its entry point was
node_modules/@probefn/contracts/src/index.ts. The same raw-TypeScript dependency
closure underlay CLI/MCP and the compiled admin package. The CLI also had no npm
bin, and CLI/MCP defaults derived the project root from their package-file
location, which would select an installation directory after packing.
Baseline receipt: /tmp/probe-dist-baseline.log; owned consumer removed.

## Change

All ten private runtime packages now clean-build ESM JavaScript and declarations
with their existing strict shared TypeScript settings. Dist-only exports preserve
the contracts subpaths. npm files exclude source/tests, runtime dependencies are
pinned to matching private package versions, and Node>=22.13 is explicit throughout
the closure. The executable bin has a shebang and invokes the same CLI envelope/
exit-code implementation. CLI and MCP default to process.cwd(); explicit repoRoot
is resolved and propagated into MCP.

Admin remains private and uses the compiled runtime dependencies instead of
bundling selected source packages. The complete private distribution has13 local
tarballs: ten runtime packages, Probe admin, shared admin and shared MCP core.
No package is published. The source integration harness has explicit TypeScript
paths and Vitest aliases so source and compiled private class identities are not
mixed; installed consumers resolve only the production dist exports.

The fresh consumer exposed three high-severity production audit entries caused
by Probe's direct MCP SDK1.25.2 (including propagated MCP/CLI entries). That direct
dependency now matches shared MCP core's existing1.32.1. Normal npm resolution
adds its dependency closure only under probefn/node_modules in the root lock;
other workspace dependency versions were not changed. The distribution verifier
requires a zero-vulnerability production audit. Initial audit details are in
/tmp/probe-dist-consumer-audit.log.

## Verification boundary

probefn/scripts/verify-distribution.mjs traverses actual runtime workspace links,
packs the built closure, normally installs all13 tarballs into an owned temporary
consumer, and rejects packages shipping source/test trees. From a separate project
working directory it loads a TypeScript config through the installed jiti loader,
initializes a scoped session through the installed admin adapter, verifies scope
isolation, executes the actual npm bin to export a persisted report, and starts
that same bin's MCP stdio server. It checks all16 tools and report-envelope/path
parity, then compiles a strict NodeNext consumer against installed declarations.
It checks that no artifact directory was written under the package installation.
The fixture uses real session/storage/report code but deliberately does not launch
a browser. It does not claim an installed browser matrix, hosted admin auth, or
all original operator workflows. Existing source-browser tests remain separate.

Commands (root monorepo, Node22.22.0 / npm11.21.0):

```sh
npm ci --workspace=@probefn/workspace --workspace=@probefn/admin --include-workspace-root=false --no-audit --no-fund
turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin
PROBEFN_NPM_CLI=/path/to/npm11/bin/npm-cli.js node probefn/scripts/verify-distribution.mjs
turbo run build --dry=json
```

Actual Turbo2.6.1 graph validation accepts301 root tasks, with acyclic runtime
edges and shared admin/MCP build prerequisites. A first compiled build exposed the
previous scoped install's missing shared-admin workspace link; normal scoped npm
ci fixed the install closure. A mixed source/dist nominal-type diagnostic was
resolved by the explicit test-harness mappings, without weakening typechecks or
shipping source exports. Before the SDK alignment, all177 integration tests and
four admin tests/typechecks passed; final results follow below.

Known limits remain: full original spec/vector coverage, broader installed browser
acceptance, external/hosted deployment, and total physical disk quota. In particular,
SQLite and opaque scratch allocation are not claimed as covered by logical artifact
accounting. There is no Python implementation in this ProbeFn slice. No external
provider operation, deployment, registry publication or base-branch merge occurs.

Final validation (2026-10-23): normal scoped npm ci succeeded. The final Turbo
build/typecheck/test run completed 17 tasks (no cached tasks), including 177
integration tests in 35 files and four admin tests. Both strict typechecks passed.
The installed consumer packed and installed 13 local packages, executed the npm
bin, initialized MCP stdio with all 16 tools, read the admin-persisted session and
exported its report through both transports. Its strict NodeNext consumer compiled
and production audit reported zero vulnerabilities. The actual root graph contains
301 tasks. Logs: `/tmp/probe-dist-final-install.log`,
`/tmp/probe-dist-final-checks.log`, `/tmp/probe-dist-final-graph.json`, and
`/tmp/probe-dist-final-consumer.log`.

The acceptance script removes its owned temporary installation in a finally block.
Final process inspection found no remaining Probe consumer, MCP server or package
test process. No external services or browser downloads were used.
