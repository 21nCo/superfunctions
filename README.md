<div align="center">
  <h1>Super functions</h1>
  <p>Self deployed super stack for building modern software.</p>
</div>
<div align="center">
  
[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](/LICENSE)
[![Discord](https://img.shields.io/discord/831815510563749889?logo=discord&logoColor=white)](https://discord.com/invite/9HJqKYTZKg)
 
</div>

> [!WARNING]
> **Alpha software**.
> Super functions is currently in alpha and is not yet fully ready for production use. APIs and behavior may change without notice, and some features may be incomplete or unstable. Evaluate it carefully and use it at your own risk.

# Functions

## Data and storage

| Function | Description |
| --- | --- |
| dataFn | Full stack data management framework with offline-first sync, reactive signals, sharing capability, and auto REST API.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@datafn/client) · [PyPI](https://pypi.org/project/datafn/) |
| fileFn | Complete file management with resumability, multi-part uploads, security, processing, versioning, storage quota and analytics.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@filefn/client) · [PyPI](https://pypi.org/project/filefn/) |
| searchFn | Adapter-first full-text search for browser, native mobile apps and server with offline IndexedDB and DataFn integration.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@searchfn/client) |

## Application core

| Function | Description |
| --- | --- |
| authFn | Drop-in authentication and user management. Social logins, magic links, session handling, AI agent authentication and more.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@authfn/client) · [PyPI](https://pypi.org/project/authfn/) |
| billFn | Complete billing infrastructure. Subscriptions, one-time payments, usage-based billing, analytics, store integrations and invoicing.<br><br>**Packages:** [npm](https://www.npmjs.com/package/billfn) |
| [mcpFn](./mcpfn/README.md) | Build and regression-test MCP servers with protocol contracts, OAuth/API-key testkits, Playwright auth fixtures, host profiles, official conformance, and safe DataFn exposure.<br><br>**Packages:** `@mcpfn/core` · `@mcpfn/auth` · `@mcpfn/testing` · `@mcpfn/datafn` · `@mcpfn/cli` |
| [reviewFn](./reviewfn/README.md) | Portable, evidence-backed pull-request review with requirement traceability, explicit incomplete states, isolated verification and configurable harnesses.<br><br>**Packages:** `@superfunctions/reviewfn-core` · `@superfunctions/reviewfn-cli` · `@superfunctions/reviewfn-harness-codex` · `@superfunctions/reviewfn-context-composio` · `@superfunctions/reviewfn-github` · `@superfunctions/reviewfn-testing` |
| plugFn | Universal API integration SDK. Connect to third-party services with a standardized interface and automatic auth handling.<br><br>**Packages:** [npm](https://www.npmjs.com/package/plugfn) |

## User Interface

| Function | Description |
| --- | --- |
| [uiFn](./uifn) | Reusable frontend component primitives, themes, framework adapters, catalogs, registry delivery, and design-system tooling.<br><br>**Packages:** `@uifn/*` |

## Infrastructure and meta

| Function | Description |
| --- | --- |
| hostFn | Handy CLI and dashboard for all hosting needs.<br><br>**Packages:** [npm](https://www.npmjs.com/package/hostfn) |
| extFn | Complete extension development platform. Frontend framework agnostic, with hot-reload, automatic bundling, scanning and publishing.<br><br>**Packages:** [npm](https://www.npmjs.com/org/extfn) |
| [apiFn](./apifn) | AI native API client and testing, including the `@apifn/docsfn` OpenAPI reference plugin.<br><br>**Packages:** [npm](https://www.npmjs.com/org/apifn) |


## Releases

Release tags must point to the reviewed commit containing the exact package
version and all prerequisite fixes. Manual dispatch requires an **existing tag**:
the workflows check out `refs/tags/<release_tag>`, not the dispatching branch,
and reject a deleted or moved tag before publication. A dispatch that publishes
an npm package must also run on that tag (`gh workflow run publish-tag.yml
--ref <release_tag> -f release_tag=<release_tag>`), because npm provenance
records the commit the run was dispatched from. Do not retag releases.

Before anything is installed, built or packed, both publish workflows refuse a
tag whose npm slug or Python project is owned by the other repository in
`superfunctions.owners.json` / `superfunctions.owners.next.json`, is listed in
neither or in both (`scripts/assert-release-owner.mjs`), and a tag whose commit
has no completed, successful CI run on that exact SHA
(`scripts/assert-release-ci.mjs`). On `21nCo/superfunctions` that is a `push` run
of `.github/workflows/ci.yml`, and every such run on the commit must have
succeeded (`pull_request` and `workflow_dispatch` runs do not count: one tests a
merge commit, the other may plan no package jobs); `"ci": {"workflow": "<file>"}`
in `superfunctions.owners.json` names another workflow file; GitHub may report its
path with an `@<ref>` suffix, which is ignored. On `next`, CI runs on Depot, and
no GitHub API field shows that a Depot check run came from a full push run of the
tagged commit rather than a dispatched or pull request run that may test nothing.
So `next` refuses every CI-gated tag as unproven, whatever the `ci` section of
`superfunctions.owners.next.json` says, until SFNS-160 shows an invocation-level
Depot signal (owner decision, 2026-11-21). Tag only a commit whose CI has passed; if CI was still
running, dispatch the workflow again once it succeeds. A `channel_only` dispatch
republishes nothing and skips only the CI check.

The checks are steps of the publish workflows, and GitHub runs the workflow file
of the ref a run starts from. A tag push, or a dispatch with `--ref <tag>`, of a
tag on a commit made before these checks existed therefore runs that commit's
ungated workflow; closing that route needs a repository rule such as a tag
ruleset, which is deferred to SFNS-158. A Python dispatch or an npm
`channel_only` dispatch started from a newer ref runs the checks from that ref,
even for an older tag; the tag's own manifests still decide ownership, and only a
`channel_only` dispatch of a tag that has neither manifest uses the run commit's.
The commands below validate/build locally; they do not publish.

### npm libraries

`release-packages.json` is the public-library allowlist for
`.github/workflows/publish-tag.yml`. It includes the 31 previously unmapped
libraries; the root workspace, examples and private packages remain excluded.
Tags use `<package-slug>-v<exact-package.json-version>`.

```sh
node --test scripts/resolve-release-tag.test.mjs scripts/assert-release-ref.test.mjs scripts/swift-release.test.mjs
node scripts/resolve-release-tag.mjs uifn-patterns-v0.2.0-experimental.0
# In the resolved package directory, install its declared dependencies first:
npm install --workspaces=false --package-lock=false
# From the repository root, build/test/pack the selected current manifest tag:
node scripts/pack-release-package.mjs <package-slug>-v<version>
```

The pack command checks committed generated inputs, then runs declared build,
typecheck (or `type-check`) and test scripts followed by `npm pack` lifecycle
hooks. Regenerate/sign catalogs before tagging; packing never regenerates them.
The workflow publishes the **exact tarball**, with lifecycle scripts disabled.
Packing embeds the checked-out commit as `gitHead` and restores the source
manifest byte-for-byte, including on pack failure, so tarball publication keeps
verifiable registry lineage.
React component gates resolve React/ReactDOM from the installed test renderer's
peer tree, keeping workspace and package-local runs coherent without first-party
source aliases or dependency-version changes.
Qualify downstream consumers outside the workspace using their packed tarballs
and registry-installed dependencies. A workspace build alone does not prove
published dependency compatibility. Exercise the actual HTTP, CLI or browser
surface after installation; report any local candidate dependency substitutions
separately rather than calling them registry-only qualification.
The docs-theme gate covers URL encoding and independent navigation options;
verify its document shell and CSS export in a packed browser consumer.
Stable releases use `latest`; prereleases use their first identifier, such as
`experimental` or `rc`. Numeric/range-like, noncanonical and `latest` prerelease
channels fail rather than overwriting stable installations. The workflow removes
`latest` only if npm assigned it to the exact released prerelease, retaining any
existing stable `latest`. For an already-published prerelease, dispatch its
immutable release tag with `channel_only=true`: this verifies registry identity
and reconciles tags without installing, packing or republishing the artifact.
`@uifn/patterns` and `@uifn/sf` remain experimental. Packages publish through
npm trusted publishing (OIDC). The `build` job installs, builds, tests and packs
the artifact without `id-token` permission; a separate `publish` job downloads
that exact tarball and runs `npm publish` with npm 11.21.0 and `id-token: write`.
Every published package has a GitHub Actions trusted publisher on npm with
organization/user `21nCo`, repository `superfunctions`, workflow filename
`publish-tag.yml` and no environment name. The workflow has no npm token. npm
can only attach a trusted publisher to a package that already exists, so before
a new package's first release tag a maintainer claims the name with a `0.0.0`
placeholder: in a new empty directory outside the repository, write a
`package.json` containing only the package's `"name"` and `"version": "0.0.0"`,
check that `npm pack --dry-run` lists only `package.json`, then run
`npm publish --access public` with 2FA (`--access public` because a scoped
package defaults to restricted; never the real version, whose tag would then fail
because that version already exists). Then add its trusted publisher with
**Allow npm publish** enabled (npm defaults new connections to staged publishing
only) and push the release tag within 2 days: npm expires a trusted publisher
configuration that has not completed a successful publish within 2 days of
creation. After that release, deprecate the placeholder with
`npm deprecate <name>@0.0.0 "Name placeholder; install a released version"`.
The placeholder keeps `latest` until the package's first stable release, so make
the first release a stable version. Don't move `latest` to a prerelease by hand:
`reconcile-channel` removes `latest` from a prerelease. After a prerelease-only
first release, an unqualified install gets the empty placeholder and users have
to install by the prerelease's dist-tag.
npm attaches a provenance attestation to every OIDC publish from this public
repository. The registry accepts it only when the packed `package.json`
`repository.url` is `git+https://github.com/21nCo/superfunctions.git`, so every
release target must declare that URL with its own `directory`.
Prerelease tag reconciliation runs in a separate job that also uses OIDC; it
needs **Allow npm dist-tag** enabled on the
package's trusted publisher.
See [npm's dist-tag OIDC requirements](https://docs.npmjs.com/trusted-publishers#managing-dist-tags-with-trusted-publishing).
Publish authorization does not imply dist-tag authorization. A denied cleanup
fails the workflow even if the artifact was published; verify its registry
channel before declaring the release complete. Missing authorization or an
occupied version fails rather than silently relaxing channel policy.
BotFn libraries use the controlled `@superfunctions/botfn-*` names;
the foreign npm user scope `@botfn` is not a publish target.
Publish the required internal npm dependency closure before its consumers.

#### Bare packages

A product's bare (unscoped) npm package is its front door (see AGENTS.md,
"Bare npm package names"). Its `release-packages.json` entry has
`"kind": "bare"` and names the release slugs of the product's scoped `core` and
`cli`:

```json
{ "slug": "reviewfn", "path": "reviewfn/bare", "name": "reviewfn", "kind": "bare", "core": "reviewfn-core", "cli": "reviewfn-cli" }
```

Its slug is listed in `superfunctions.owners.json` like any other, and
`scripts/verify-owners.mjs` requires the core and CLI slugs to have the same
owner. A bare entry names a separate scoped core it re-exports, a scoped CLI, or
both; a bare package that is the core itself is not supported. The release gate
accepts only the bare template's exact shape (`TEMPLATE` in
`scripts/assert-bare-release.mjs`):

- every bin is `"./bin/cli.mjs"`, a byte-for-byte copy of
  `scripts/bare-cli-shim.mjs`, and `"frontDoor": { "cli": "<scoped CLI>" }`
  names the CLI (a bare package without a CLI has neither);
- a bare package re-exporting its core has `"type": "module"`, no `main` or
  `imports`, `"exports": { ".": { "types": "./index.d.ts", "import": "./index.js", "default": "./index.js" } }`,
  `index.js` and `index.d.ts` each exactly `export * from '<core>';`, exactly
  `{ "<core>": "<version>" }` as its dependencies and, with a CLI, exactly
  `{ "<cli>": "<version>" }` as its devDependencies; it never depends on the CLI,
  so importers install none of it;
- a CLI-only bare package has `"type": "module"`, no `exports`, `main` or
  `imports`, and exactly `{ "<cli>": "<version>" }` as its dependencies;
- its `test` script is `node --test test/front-door.test.mjs`, a byte-for-byte
  copy of `scripts/bare-front-door-test.mjs`. The release build runs it after
  installing the pinned core and CLI from npm: `import "<bare>"` must give the
  core's exports, and every bin's `--version` must print the bare package's
  version with `BARE_CLI_NO_NPM=1` (which stops the shim from fetching the CLI
  with npm), so a core that ESM cannot import, a missing or different installed
  CLI, or a CLI without `--version` fails the release. The packer also runs it
  directly with Node, whatever the package's scripts say, in a fresh temporary
  folder that holds only the package's committed manifest, re-export files,
  shim and test (which must be the committed template), with the pinned core
  and CLI installed there from npm; it never writes to the working tree.

The shim imports only Node.js built-ins and runs the CLI's bin named after the
bare package at exactly the bare package's version, as a child process that keeps
the terminal and passes its exit code back: a copy at that version that Node.js
finds from the bare package runs with Node.js; otherwise
`npm exec --yes --package=<cli>@<version> -- <bin>` fetches and runs it, as npx
would.

The shim sets `BARE_EXPECTED_CLI=<cli>@<version>` for the CLI it starts. Like
`npx <cli>@<version>`, `npm exec` may reuse a copy of the CLI nested under another
dependency without putting its bin on the PATH, and then run a different version
the project links under the same bin name. So a CLI behind a bare package checks
the variable at startup and refuses to run as another version, and its
`package.json` declares that it does with
`"frontDoorCli": { "checksExpectedVersion": true }`:

```js
const expected = process.env.BARE_EXPECTED_CLI;
if (expected?.startsWith(`${pkg.name}@`)) {
  if (expected !== `${pkg.name}@${pkg.version}`) {
    console.error(`expected ${pkg.name} ${expected.slice(pkg.name.length + 1)}, found ${pkg.version}; run npx ${expected}`);
    process.exit(1);
  }
  delete process.env.BARE_EXPECTED_CLI; // not passed on to commands the CLI starts
}
```

The shim also refuses to start again under its own expectation, in case npm
resolves the bin name back to the bare package. A copy of the CLI released before
it had this check (for example `@superfunctions/cli` 0.2.2 or earlier) ignores
the variable: in the setup above it runs, exactly as it would under
`npx <cli>@<version>`. The gate requires the released CLI, at source and on npm,
to declare the check, so every CLI version a bare package pins has it. Signals
follow the same split: with an installed CLI, a Ctrl+C from the terminal reaches
it once (the shim does not pass it on again); through `npm exec`, npm also
relays it to the CLI, exactly as under `npx`.

Before installing anything, the build job runs
`scripts/assert-bare-release.mjs <tag>`, which refuses a bare release unless the
bare package, its core and its CLI have the tagged version, the pins and shim
are as above, and the core and CLI are already on npm at that version. Release a
product in this order: `<core-slug>-v<version>` and `<cli-slug>-v<version>`, then
`<bare-slug>-v<version>` once both are published. CI runs the same checks, without
the registry, on every bare entry, so the three versions move together.

### Python libraries

`.github/workflows/publish-python.yml` releases these 12 projects independently:
`apifn`, `authfn`, `billfn`, `datafn`, `filefn`, `plugfn`, `searchfn`, `sendfn`,
`superfunctions-core`, `superfunctions-fastapi`, `superfunctions-flask` and
`superfunctions-sqlalchemy`. Tags use `python-<project>-v<exact-pyproject-version>`
and cannot trigger npm publication. Versions must be canonical PEP 440 stable
or `a`/`b`/`rc` prereleases; local, dev, post and epoch versions are not supported.
PyPI/pip prerelease selection is preserved: publishing a prerelease does not
promote it to a stable release. The registry gate rejects occupied versions and
versions at or below the newest stable release.
Tag parsing checks the supported project before validating PEP 440, without a
backtracking name/version regex. The PyPI publisher action is pinned to an
immutable commit from its official `release/v1` branch.

Use a fresh Python 3.12 virtual environment **per package**:

```sh
python3.12 -m venv /tmp/superfunctions-python-release
/tmp/superfunctions-python-release/bin/python -m pip install build twine packaging
/tmp/superfunctions-python-release/bin/python -m unittest discover -s scripts -p test_python_release.py
/tmp/superfunctions-python-release/bin/python scripts/python_release.py resolve python-apifn-v0.0.1
# Read-only network gate; fails if this version is occupied or regressive:
/tmp/superfunctions-python-release/bin/python scripts/python_release.py check-registry python-apifn-v0.0.1
# Build/test current sources without uploading, even for occupied versions:
/tmp/superfunctions-python-release/bin/python scripts/python_release.py build python-apifn-v0.0.1 --out-dir /tmp/apifn-release-artifacts
```

The build command requires a nonexistent output directory, builds an sdist and
then a wheel **from that sdist**, verifies both distribution identities, runs
`twine check --strict`, installs the wheel with declared test/optional extras,
runs package-local pytest and imports its shipped modules outside the checkout.
It does not upload. Before a later release, select unoccupied versions above
the stable registry baseline; existing consumer versions are intentionally
unchanged except for the SQLAlchemy patch required by the core-name cutover.
In the origin/dev inventory, `searchfn`, `plugfn`, `sendfn`,
`filefn` have occupied manifest versions;
`authfn` is below its stable baseline. These gates intentionally remain closed
until version policy is applied for an authorized Python publication.

PyPI's `superfunctions@0.1.3` is the unrelated Youssef/youssefa metafunction
project, not a 21n release or baseline. The unclaimed distribution
`superfunctions-core` replaces that name; its initial unpublished version stays
`0.1.1` and its import namespace stays `superfunctions`. Only
`python-superfunctions-core-v0.1.1` is supported, not the old core tag.
The SQLAlchemy adapter moves to the unused 0.1.1 packaging patch; SendFn extras
require migrated adapter versions at least 0.1.1 so they cannot pull an older
adapter's dependency on the unrelated distribution.
No Python publication is authorized here. For a later authorized release,
publish the real core prerequisite first, then adapters needed by SDK extras,
then dependent SDKs. Production release validation requires those prerequisites
on PyPI and never substitutes checkout sources.

Development CI's `scripts/ci-run-python-package.mjs` installs local runtime and
`[dev]` dependency closures before the target, including AuthFn's FastAPI/Flask
adapters. Other optional groups are not selected by that CI gate; packed-wheel
qualification below selects all extras.

For pre-publication validation, first build the actual core wheel using
`python scripts/python_release.py build python-superfunctions-core-v0.1.1
--out-dir /tmp/python-core-artifacts` in its own fresh environment. In each
consumer's fresh environment, set `PIP_FIND_LINKS=/tmp/python-core-artifacts`
when invoking the same build command for that consumer's exact manifest tag.
Pip inherits this standard environment setting; no source fallback or mock
publication is used. If an optional extra needs a newly packed adapter, add its
artifact directory to the space-separated `PIP_FIND_LINKS` value after validating
that adapter against the core wheel. Only tests/configuration and BillFn's
`examples/mock_api.py` fixture are copied into the isolated test directory;
SDK sources and sibling core sources are never copied.

**External prerequisite: PyPI trusted publishing must be configured, not
assumed.** For each of the 12 project names above, add a GitHub trusted publisher
(or a pending publisher for a new project) in PyPI with owner `21nCo`,
repository `super-functions`, workflow filename `publish-python.yml` and
environment name `pypi`. Create/protect the GitHub `pypi` environment with
appropriate reviewers and release-tag restrictions. The publish job alone
receives `id-token: write`; it uses PyPI OIDC and attestations, not a fallback
token or `skip-existing`. Missing enrollment/permissions fail publication.
The previously configured `dev`/`live` environments do not establish PyPI
enrollment. No Python publication is part of the current workflow repair.

### Swift root source distribution

`.github/workflows/release-swift.yml` owns root `v<strict-semver>` tags. SwiftPM
gets its version from that immutable git tag, not from an npm or Python
manifest; these root tags cannot trigger either package-publication workflow.
It validates the root `Package.swift`'s 13 library products on macOS, resolves
dependencies, release-builds every product, and runs the root test suite:
Use Swift 6/Xcode 16 or newer for validation. Tests use the toolchain's bundled
Swift Testing runtime/macros together, not a separately pinned development runtime
or an overriding Command Line Tools framework search path.

```sh
node scripts/swift-release.mjs resolve v0.1.0
node scripts/swift-release.mjs validate v0.1.0
# Requires the actual immutable tag, and only creates a local source archive:
node scripts/assert-release-ref.mjs v0.1.0
node scripts/swift-release.mjs archive v0.1.0
```

Stable root tags must be newer than earlier stable root tags. The source release
uses `GITHUB_TOKEN` with `contents: write`, attaches a `git archive` of the tag,
and refuses to replace an existing GitHub release. Prerelease GitHub releases
use `--prerelease --latest=false`; they never replace stable latest semantics.
GitHub repository/environment policy must permit source-release creation.
There was no root semantic version tag in the inventory; choosing/pushing one
and creating a Swift release are separate authorization steps, not part of the
current workflow repair.

## Repositories

This repository, `21nCo/superfunctions` (branch `dev`), is where public-owned functions and all shared code are developed. Other functions are owned by a private repository, `21nCo/super-functions.next`, which receives everything public from `dev` through an automatic one-way sync. The ownership manifests decide where a function lives: `superfunctions.owners.json` lists what this repository owns, and `node scripts/owners.mjs <path>` prints a path's owner. A function moves here through `scripts/promote.mjs`, normally when it is ready to publish; one already published from the private repository stays there, and only that repository may publish it, until it is promoted (releases from it are currently paused pending SFNS-160). [AGENTS.md](AGENTS.md) states the full model.

## Contributing

Due to the current size of our team, we are not accepting external contributions at this time. We appreciate your interest and understanding.

### License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file for details.

### Contact

For any questions, security reporting or feedback, please contact us at [hello@21n.co](mailto:hello@21n.co).

❤️ We extend our deepest gratitude to all the [OSS libraries and tools](https://github.com/21nCo/super-functions/network/dependencies) that made this project possible.
