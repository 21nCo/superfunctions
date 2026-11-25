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
version, then runs it against the caller's spec and collection. The caller does
not need to be this monorepo or contain an `@apifn/cli` workspace. Grant
`pull-requests: write` on the calling job even when `post_pr_comment` is false;
the reusable workflow cannot elevate the caller token. Same-repo callers:

```yaml
permissions:
  contents: read
  pull-requests: write
jobs:
  api-check:
    uses: ./.github/workflows/apifn-api-check.yml
    with:
      spec_path: .apifn/openapi.yml
      collection_dir: .apifn/collection
```

External repositories can use the registered workflow directly:

```yaml
permissions:
  contents: read
  pull-requests: write
jobs:
  api-check:
    uses: 21nCo/super-functions/.github/workflows/apifn-api-check.yml@dev
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

- Validates OpenAPI specs via `apifn validate --format json`
- Diffs current spec against base branch via `apifn diff --format json`
- Runs collection tests via `apifn test --reporter json`
- Emits machine-readable JSON artifacts (`validate-report.json`, `diff-report.json`, `test-report.json`)
- Builds a markdown summary and posts/updates a PR comment (optional)
- Enforces non-zero exits for validation failures, breaking changes, and test failures

Bundle split OpenAPI specs before passing them to `spec_path`. Validation resolves
internal `#/` references and rejects file and remote references by default.
The workflow runs collection tests with scripts and host environment interpolation
disabled. For trusted collections that need either, configure your own workflow
with the [direct CLI commands](#non-github-ci). Pass `--allow-scripts` or repeatable
`--allow-env <name>` flags to `apifn test` as needed.

### Inputs

- `spec_path` (required): Repo-relative OpenAPI path (e.g. `.apifn/openapi.yml`)
- `collection_dir` (required): Repo-relative OpenCollection directory (e.g. `.apifn/collection`)
- `environment` (optional, default `development`): Collection environment
- `cli_version` (optional, default `0.1.2`): Assertion against the `@apifn/cli` version pinned by the selected workflow revision. The default in the workflow file must match that revision's [CLI lockfile](../.github/apifn-cli-install/package-lock.json). The workflow uses the local lockfile when the caller checkout matches the workflow repository and commit. For other callers it fetches the lockfile from the workflow revision.
- `base_branch` (optional, default `main`): Branch used to fetch baseline spec
- `fail_on_breaking` (optional, default `true`): Whether breaking diff exits non-zero
- `post_pr_comment` (optional, default `true`): Whether to post/update PR summary comment
- `called_as_reusable_workflow` (optional, default `true`): Do not set it. It tells the job it was called, so it runs for every caller; setting it to `false` skips the check outside `21nCo/superfunctions`.

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
