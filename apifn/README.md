# ApiFn

ApiFn is a code-first, self-hosted API development toolkit. Generate OpenAPI specs from your router, diff them for breaking changes, run collection-based test suites, mock endpoints, embed interactive API docs, and gate it all in CI — without leaving your codebase.

Your router is the source of truth: introspect it into OpenAPI 3.1, then drive validation, diffing, testing, mocking, snippets, and documentation from the same spec.

## npm packages

| Package | Description |
|---------|-------------|
| [`@apifn/core`](./core) | Route introspection, schema conversion (Zod/TypeBox → JSON Schema), OpenAPI 3.1 generation, diff, and ecosystem integrations. The other ApiFn npm packages build on it. |
| [`@apifn/cli`](./cli) | The `apifn` command — generate, export, import, validate, diff, test, mock, serve, snippet, sdk. |
| [`@apifn/collections`](./collections) | OpenCollection YAML read/write/run: portable request collections with assertions, scripting, and reporters. |
| [`@apifn/mock`](./mock) | Framework-free mock server from any OpenAPI spec, with schema/example/random responses and request validation. |
| [`@apifn/snippets`](./snippets) | Generate request code snippets for 11 languages/clients (curl, fetch, axios, Python, Go, Java, …). |
| [`@apifn/react`](./react) | React components — interactive API explorer, Try-It console, schema viewer, diff, performance overlays. |
| [`@apifn/svelte`](./svelte) | The same UI surface for Svelte, shipped as `.svelte` source. |
| [`@apifn/docsfn`](./docsfn) | docsfn plugin — render an OpenAPI spec as an interactive API reference. |
| [`@apifn/contracts`](./contracts) | Versioned operation catalog, release descriptor and client-failure event contracts, with JSON Schemas and shared fixtures for SDK generators, agent tools and failure reporting. |
| [`@apifn/sdk`](./sdk) | Generate installable SDKs from an operation catalog through deterministic target adapters; ships the TypeScript `fetch` target and the async Python (`asyncio` + `httpx`) target. |

### npm release dependency order

The collection runner and OpenAPI validation security updates keep exact pins aligned across the npm packages. Publish in this order.

1. `@apifn/core` **0.1.2**.
2. `@apifn/collections` and `@apifn/mock` **0.0.6**, `@apifn/snippets`,
   `@apifn/react` and `@apifn/svelte` **0.0.7**, `@apifn/contracts` **0.1.2**,
   and `@apifn/admin` **0.1.4**. These packages pin Core. Admin also requires
   the published `@superfunctions/admin` **^0.1.4** peer.
3. `@apifn/sdk` **0.1.2** after Contracts, and `@apifn/docsfn` **0.1.4**
   after both renderers.
4. `@apifn/cli` **0.1.2** after its dependencies are available.

The reusable workflow can move to the fixed CLI after it is published. API-6
tracks the lockfile pin, workflow default, and external caller example.

## Python SDK

[`apifn`](./python) provides Python helpers for OpenAPI generation, diffing, collections, FastAPI, and Flask. It requires Python 3.10 or newer and is versioned separately from the npm packages.

## Quick Start

Install the CLI and scaffold a collection:

```bash
npm install --save-dev @apifn/cli
npx apifn init .apifn/collection
```

Generate an OpenAPI document from your `@superfunctions/http` router:

```typescript
// apifn.config.ts
import { defineConfig } from "@apifn/cli";

export default defineConfig({
  router: "./src/router.ts",
  output: ".apifn",
  openapi: {
    info: { title: "My API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
  },
});
```

```bash
apifn generate                          # → .apifn/openapi.yml
apifn validate .apifn/openapi.yml       # validate the document
apifn mock .apifn/openapi.yml           # mock server on :4010
apifn serve .apifn/openapi.yml          # interactive explorer on :4100
apifn test .apifn/collection            # run collection tests
```

Or use the library directly:

```typescript
import { fromRouter, diffOpenAPI, formatDiffAsText } from "@apifn/core";

const doc = fromRouter(router, {
  info: { title: "My API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
});

const result = diffOpenAPI(baselineDoc, doc);
console.log(formatDiffAsText(result));
```

## Ecosystem Integrations

`@apifn/core` ships first-class hooks into the wider Superfunctions stack:

- **watchfn** — per-endpoint performance metrics and request telemetry
- **authfn** — mint short-lived test tokens and inject auth into collection runs
- **secfn** — read rate-limit state for endpoints
- **logfn** — structured run reporting and a CLI logger
- **testfn** — an adapter that discovers and runs collections as test cases

## CI/CD

ApiFn provides a reusable GitHub Actions workflow at `.github/workflows/apifn-api-check.yml` (repo root, so GitHub Actions can register and call it).

The workflow checks out the **caller**, installs the pinned published `@apifn/cli`
version, then checks the caller's contract. The caller does not need to be this
monorepo or contain an `@apifn/cli` workspace. Grant `contents: read` and
`pull-requests: write` on the calling job even when `post_pr_comment` is false;
the reusable workflow cannot elevate the caller token. With `router_path` it
runs `apifn check` from the router, which fails on spec drift, an invalid spec or
a breaking change the contract version does not cover:

```yaml
permissions:
  contents: read
  pull-requests: write
jobs:
  api-check:
    uses: 21nCo/superfunctions/.github/workflows/apifn-api-check.yml@dev
    with:
      router_path: src/router.ts
      spec_path: .apifn/openapi.yml
      base_branch: main
```

Without `router_path` it validates a committed spec and diffs it against the base
branch, as before (same-repo callers can use `uses: ./.github/workflows/apifn-api-check.yml`):

```yaml
jobs:
  api-check:
    uses: 21nCo/superfunctions/.github/workflows/apifn-api-check.yml@dev
    with:
      spec_path: openapi.yml
      collection_dir: .apifn/collection
```

Pin a commit or release tag instead of `@dev` when the caller requires an
immutable workflow. Omit `cli_version` to use the workflow's static default
(`0.1.2`), which must stay equal to that revision's lockfile pin. If you set it
explicitly, read the version from the same ref in the
[workflow's CLI lockfile](../.github/apifn-cli-install/package-lock.json); the
input is an assertion, not a package selector. For GitLab/Jenkins/Buildkite,
run the CLI commands in [Non-GitHub CI](#non-github-ci).

### What it does

The workflow has two jobs. `evaluate` checks out and runs everything below with a read-only token (`contents: read`),
because the caller's install scripts, router and config run there. `api-check` holds the only token that can write to
the pull request: it checks out, installs and imports nothing, posts the comment from `evaluate`'s report and applies
the gate `evaluate` decided. Requiring `<caller job> / api-check` as a status check is enough; existing callers keep
that check name.
Every step of `evaluate` continues on error and has a timeout, so a step that fails before the check runs (invalid
inputs, the install, the CLI build) is reported as an error in the summary and the comment and fails `api-check`
whatever `enforce_gates` says. `api-check` runs whatever `evaluate`'s result, so when `evaluate` is cancelled, times
out or loses its runner, `api-check` fails (the outputs report `verdict=fail`) instead of being skipped. Rerun the
workflow then.

The guards below protect against caller code that is not adversarial: install scripts and router or config imports
that generate or rewrite files. Code in the pull request runs in `evaluate` and could forge its result; the job split
keeps the pull-request write token away from it, and review of the pull request covers the rest.

With `router_path`:

- Checks out the caller without keeping the token in `.git/config`
- Runs `npm ci` in `working_directory` (when it has a `package.json`), because the router imports the caller's packages. The job fails when the install changes checked-out files or adds untracked ones outside `node_modules` (for example a `prepare` script regenerating the spec), because `apifn check` must read the committed router and spec
- Runs `apifn check <router_path> --base <commit of origin/base_branch> --format markdown --report …` and the same check with `--format json --report …` (`--base-spec` instead when `base_spec` is set). The base is pinned right after the checkout, before any caller code runs (the workspace CLI build, `npm ci`, the router and config imports): the base commit is resolved from the remote-tracking ref `refs/remotes/origin/<base_branch>`, and a `base_spec` is copied to a snapshot in `$RUNNER_TEMP` (an HTTP(S) URL downloaded or a local path resolved against `working_directory`, each at most 32 MiB) that both runs read; a `base_spec` that cannot be loaded is reported as a baseline load error (exit 2), as the CLI reports it. Inputs appear in the job log, so never pass a `base_spec` URL that carries a credential (a signed query string or `user:password@`). Both reports are written to `$RUNNER_TEMP`, not the checkout, so output the router or config prints while loading does not affect them
- After both runs, requires `HEAD` to still be the checked-out commit, and the spec the CLI opened (`spec_path` as given, or the config default) to be the file committed at that commit, reached only through symlinks committed there with the same targets (a spec missing from both is reported as drift). A spec or symlink that the install, the router or the config created or changed, including a gitignored one, makes the check report an error and the verdict `fail`
- Fails an uncovered breaking change unless `allow_breaking` is true, even when the caller's apifn config sets `diff.failOnBreaking: false`
- Uses the Markdown report as the job summary and PR comment when both runs agree (exit code, verdict, drift and breaking changes); otherwise the summary reports an error and the verdict is `fail`

Without `router_path`:

- Validates OpenAPI specs via `apifn validate --format json`
- Diffs current spec against base branch via `apifn diff --format json`
- Writes machine-readable JSON reports (`validate-report.json`, `diff-report.json`); a missing or malformed report fails the check
- Builds a markdown summary

Either way:

- Runs collection tests via `apifn test --reporter json` (its report goes to `$RUNNER_TEMP`) when `collection_dir` is set; without it the summary reports the tests as **not run**. Tests that produce no report fail
- Posts or updates one PR comment holding `<!-- apifn-ci-report -->` (optional). A fork PR gets a read-only token, so it gets no comment, but its gates still apply. A report over 60000 UTF-8 bytes is cut and links the job summary; a failed post is a warning and does not decide the job
- Sets the outputs `verdict`, `drift` and `breaking`
- Fails the job on drift, validation failures, uncovered breaking changes and test failures (unless `enforce_gates` is false)

Bundle split OpenAPI specs before passing them to `spec_path`. Validation resolves
internal `#/` references and rejects file and remote references by default.
The workflow runs collection tests with scripts and host environment interpolation
disabled. For trusted collections that need either, configure your own workflow
with the [direct CLI commands](#non-github-ci). Pass `--allow-scripts` or repeatable
`--allow-env <name>` flags to `apifn test` as needed.

### Inputs

- `router_path` (optional): Router module, relative to `working_directory`. Set it to run `apifn check`; leave it empty for validate-and-diff
- `spec_path` (required without `router_path`): Repo-relative OpenAPI path (e.g. `.apifn/openapi.yml`). With `router_path` it is the committed spec passed as `--spec`, relative to `working_directory`; empty uses the config's default (`<output or .apifn>/openapi.yml`)
- `config_path` (optional): apifn config file for `apifn check`, relative to `working_directory`; empty finds `apifn.config.ts`, `.js` or `.mjs` there
- `working_directory` (optional, default `.`): Repo-relative directory of the caller's package; with `router_path`, `npm ci` and `apifn check` run there
- `base_spec` (optional, `router_path` only): Base spec file (relative to `working_directory`) or HTTP(S) URL, instead of the spec committed at `origin/<base_branch>`
- `allow_breaking` (optional, default `false`, `router_path` only): Report breaking changes the contract version does not cover without failing (`--allow-breaking`, verdict `warn`). Only this input allows them: with `allow_breaking: false` the workflow fails an uncovered breaking change even when the caller's apifn config sets `diff.failOnBreaking: false` (which alone makes `apifn check` report it as a warning)
- `cli_source` (optional, default `npm`): `npm` installs the CLI from the workflow revision's lockfile; `workspace` builds `@apifn/cli` from the checked-out repository and is allowed only in `21nCo/superfunctions` (the job fails in any other repository)
- `enforce_gates` (optional, default `true`): Fail the job when a gate fails. `false` only reports, through the summary, comment and outputs; keep the default for a required check
- `collection_dir` (optional): Repo-relative OpenCollection directory (e.g. `.apifn/collection`); empty skips the collection tests
- `start_mock_server` (optional, default `false`): Serve `spec_path` with `apifn mock` on `mock_port` while the collection runs, for workflow self-tests; needs `spec_path` (relative to `working_directory` with `router_path`). A mock that does not start fails the tests
- `environment` (optional, default `development`): Collection environment
- `cli_version` (optional, default `0.1.2`): Assertion against the `@apifn/cli` version pinned by the selected workflow revision (`cli_source: npm`). The default in the workflow file must match that revision's [CLI lockfile](../.github/apifn-cli-install/package-lock.json). The workflow uses the local lockfile when the caller checkout matches the workflow repository and commit. For other callers it fetches the lockfile from the workflow revision.
- `base_branch` (optional, default `main`): Branch whose committed spec is the base; a branch name (`git check-ref-format --branch`), not a revision such as `dev~1`
- `fail_on_breaking` (optional, default `true`, without `router_path`): Whether a breaking diff exits non-zero
- `post_pr_comment` (optional, default `true`): Whether to post/update PR summary comment
- `called_as_reusable_workflow` (optional, default `true`): Do not set it. It tells the job it was called, so it runs for every caller; setting it to `false` skips the check outside `21nCo/superfunctions`.

### Outputs

- `verdict`: `pass`, `warn` or `fail` for the whole job (`warn` only with `router_path`: warnings such as an allowed breaking change). A usage or load error of `apifn check` (exit 2) is `fail`
- `drift`: `true` or `false` with `router_path` (whether the committed spec differs from the router); empty without it or when `apifn check` produced no consistent report
- `breaking`: `true` when the diff against the base found breaking changes, allowed or not; `false` otherwise; empty when `apifn check` or `apifn diff` produced no consistent report

### Example

See [`apifn/examples/ci-cd/github-actions.yml`](./examples/ci-cd/github-actions.yml).

### Non-GitHub CI

For GitLab/Jenkins/Buildkite, run the same CLI commands directly:

```bash
apifn validate .apifn/openapi.yml --format json
apifn diff .apifn/base-openapi.yml .apifn/openapi.yml --format json
apifn test .apifn/collection --env development --reporter json
```

## Operator administration

`@apifn/admin` is ApiFn's optional Super Console capability, backed by a
project-scoped `ApiFnOperatorStore`. Applications inject a durable store; the
package has no default backend, and the included `MemoryApiFnOperatorStore` is
intended for tests and local self-hosting only. Specification registration and
comparison use `@apifn/core` parsing, validation, and diffing, and the package
also manages non-secret API environment URLs.

Specifications and environments are isolated by installation, workspace,
project, and optional environment. Raw OpenAPI documents are write-only through
the admin transport, while typed metadata and redacted diff summaries remain
available to Console, REST, SDK, and MCP consumers.

## License

MIT
