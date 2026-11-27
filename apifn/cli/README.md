# @apifn/cli

CLI tools for ApiFn. Generate OpenAPI specs from your router, diff them for breaking changes, validate documents, run collection test suites, mock APIs, serve an interactive explorer, and generate code snippets — all from one `apifn` command.

## Installation

```bash
npm install --save-dev @apifn/cli
# or run ad-hoc
npx @apifn/cli --help
```

## Commands

| Command | Description |
|---------|-------------|
| `init [dir]` | Scaffold a new OpenCollection directory |
| `generate [router]` | Generate an OpenAPI document from a router |
| `check [router]` | Not yet in the CLI (lands in 0.1.0). Regenerate the spec, fail on drift, validate it and block unversioned breaking changes |
| `export [format] [output]` | Export a generated spec as YAML or JSON |
| `import <kind> <source>` | Import an OpenAPI document as an OpenCollection |
| `test [collectionDir]` | Run a collection's tests |
| `diff <before> <after>` | Compare two specs for breaking changes |
| `validate <specPath>` | Validate an OpenAPI document |
| `serve [specPath]` | Serve an interactive API explorer |
| `mock <specPath>` | Start a mock server from a spec |
| `snippet <specPath> [apiPath]` | Generate a code snippet for an endpoint |
| `sdk generate` | Generate an SDK package from an operation catalog |

### Global options

`--config <path>` (default `apifn.config.ts`) · `--verbose` · `--quiet` · `--no-color`

---

## init

Scaffold an OpenCollection directory with a `development` environment and a sample request.

```bash
apifn init .apifn/collection --yes
```

- `--yes` — skip interactive prompts (name, base URL)
- `--force` — allow initializing into a non-empty directory

## generate

Generate an OpenAPI document from a `@superfunctions/http` router. The router comes from the argument or `config.router`.

```bash
apifn generate ./src/router.ts --output .apifn/openapi.yml
```

- `--output <path>` — output path (default `<config.output>/openapi.yml`, i.e. `.apifn/openapi.yml`)

`info` defaults to `{ title: "API", version: "1.0.0" }`, merged with `config.openapi.info` and `config.openapi.servers`.

## export

Re-serialize a generated spec.

```bash
apifn export json openapi.json --input .apifn/openapi.yml
```

- `format` — `yaml` (default) or `json`
- `--input <path>` — input spec (default `<config.output>/openapi.yml`)

## import

Import an OpenAPI document (file path or `http(s)` URL) as an OpenCollection.

```bash
apifn import openapi ./openapi.yml --output .apifn/collection --group-by tag
```

- `--output <dir>` — output directory (default `.`)
- `--base-url <url>` — base URL for the generated environment
- `--env <name>` — environment name (default `development`)
- `--group-by <mode>` — `tag` (default) or `path`
- `--force` — allow writing into a non-empty directory

## test

Run a collection's requests and assertions.

```bash
apifn test .apifn/collection --env development --reporter json --output test-report.json
```

| Option | Description |
|--------|-------------|
| `--env <name>` | Environment (defaults to the first defined) |
| `--bail` | Stop on first failure |
| `--parallel` | Run requests concurrently |
| `--concurrency <n>` | Max concurrent requests |
| `--timeout <ms>` | Per-request timeout |
| `--include <pattern>` / `--exclude <pattern>` | Filter requests (repeatable) |
| `--retries <n>` | Retry failed requests |
| `--delay <ms>` | Delay between sequential requests |
| `--env-var <KEY=value>` | Override an environment variable (repeatable) |
| `--allow-env <name>` | Expose a named process environment variable to interpolation (repeatable) |
| `--allow-scripts` | Execute scripts from a trusted collection |
| `--dotenv <path>` | Load a dotenv file as overrides |
| `--redact-header <name>` | Additional header to redact (repeatable) |
| `--output <path>` | Write a machine-readable report |
| `--reporter <type>` | `console` (default), `json`, `junit`, `silent` |

Exit codes: `0` all passed · `1` failures/errors · `2` load/run error.

## check

The one command a developer or CI runs: it regenerates the spec from the router in memory (the
`generate` code path), fails when the committed spec is stale, validates it, diffs it against a
base and fails a breaking change unless the contract version (`info.version`) was bumped.

```bash
apifn check --base origin/dev --format markdown --report apifn-check.md
apifn check --write   # rewrite a stale spec instead of failing
```

- `[router]` — router module (default `config.router`)
- `--spec <path>` — committed spec, YAML or JSON (default `<config.output or .apifn>/openapi.yml`)
- `--base <git-ref>` — base is the spec committed at that ref. Git resolves the ref once to a commit; the spec's path (as given, relative to the repository root, keeping the spelling of a symlinked directory on the way, even one back to the root) is then walked in that commit's tree one component at a time, as the kernel would: a tracked symbolic link met on the way is followed inside the same tree from the directory that holds it, and `..` returns to the directory actually walked. Only when that path is absent is the file a write to the spec lands on (an untracked spec symlink followed) tried; when the repository sets `core.ignorecase`, a missing name matches a tracked name equal under case folding and Unicode normalization. The blob is read as the object the walk found (`git cat-file blob <object>`), with replace objects disabled on every git call, and must be valid UTF-8; a file followed by `/` or `/.` in a link target is an error, not the spec. A path proven absent means a new contract, so the diff is skipped and reported, not failed; any git failure (including an unreadable `core.ignorecase`), several matching names, a link leaving the repository, a match that is not a file or a spec outside the repository exits `2`
- `--base-spec <path|url>` — base spec file or HTTP(S) URL (only one of `--base` and `--base-spec`); one 30-second deadline covers the request and the whole response body
- `--allow-breaking` — report breaking changes without failing
- `--write` — rewrite a drifted (stale, missing or unparseable) spec instead of failing, in the committed file's format: a file starting with `{` stays JSON, a YAML file stays the YAML `generate` writes, and a missing or unreadable file follows its suffix (`.json` is JSON)
- `--format <type>` — `text` (default), `json` or `markdown`
- `--report <path>` — also write the report to a file

git runs from one absolute path: `APIFN_GIT` when set (it must name an executable by absolute
path), otherwise the first of `/usr/bin/git`, `/usr/local/bin/git`, `/opt/homebrew/bin/git` and
`/bin/git` (`%ProgramFiles%\Git\cmd\git.exe` on Windows). A `git` found earlier on `PATH` is never
run.

The base must pass the same validator as the generated spec (a base it rejects, such as one with
`paths: []`, exits `2`), and both sides are compared with every local `$ref` replaced by its
target, so a change behind a shared schema counts like the same change written inline. Keys
beside a `$ref` apply together with its target (`required` lists and `properties` combine, bounds
keep the tighter one, `integer` is the part of `number` both allow, and a side closed by
`additionalProperties: false` keeps only its own property names); a `$ref` that leaves the
document, does not resolve, or has a sibling with no exact combined form, or one that would change
what a keyword such as `additionalProperties` or `items` applies to, exits `2`. Literal data
(`example`, `default`, `const`, `enum`, schema `examples`, an Example Object's value, `x-`
extensions) is compared as written, and a fragment inside a schema with its own `$id` resolves in
that schema.

Writes are safe. Loading, generation, parsing, validation and the comparison finish before any file
is touched; a failure there writes nothing. Publication can still fail (exit `2`) after it has
started, and then rolls back every output it wrote. No output may land on a
file the run reads (the spec, a local `--base-spec` file, the router module, the config file) or on
the other output; paths are compared after symlinks, by directory identity and, conservatively,
ignoring case and Unicode normalization, so `--report router.ts` exits `2`. The report and the
repaired spec are written to temp files beside their destinations and renamed into place (a spec
symlink keeps pointing at its target, which is replaced). The directory and the destination are
checked again right before each rename: if either changed while the check ran, nothing is written.
stdout is part of the same transaction: if writing it fails, even after the write returned (a
closed pipe), the check exits `2` and both are rolled back, unless another writer replaced or
edited them in the meantime (the run restores a file only while it holds the inode and the exact
bytes this run wrote), in which case their bytes are kept and the error says so. `--write` keeps
the committed format: text `JSON.parse` accepts stays JSON, other YAML stays YAML (flow style
included), and a missing or unreadable spec follows the suffix of the file written (a symlink's
target). A missing destination is first reserved as an empty file and every protected path is
checked again before any byte is written. POSIX has no compare-and-swap
rename, so a replacement made between the last check and the rename itself is not detected.

Interruption: the `apifn` binary turns SIGINT, SIGTERM and SIGHUP during `check` into a
cancellation: what the run wrote is rolled back (a pending stdout write is abandoned), then the
signal is raised again. Embedded through `runCli`, the library installs no process signal listener
and leaves the host's handling alone; pass `signal` (an `AbortSignal`) to cancel it the same way
(exit `2`). A run that cannot clean up (SIGKILL, a crash) can leave an empty file at a missing
output's own name, or a staged temp file beside it; it never leaves output bytes at a protected
name. That empty file is the accepted residue (owner decision, 2026-11-22).

Path and ref values are read literally, so `--base 0123` or `--base-spec 1.10` are not read as numbers.
`check` accepts only this grammar: a second positional (for example a ref given without
`--base`), any argument after `--`, a value on `--write`, `--allow-breaking` or `--help` (`=value`,
or a separate `true` or `false`; a router named `false` is `./false`), or a
repeated value option is a usage error, also when `--help` is given.

Committed, base and generated documents are read by one strict parser (YAML 1.2, which contains
JSON): at most 32 MB of text, a mapping at the root, no duplicate mapping keys and no YAML merge
keys. They may use any number of aliases, but a document whose aliases expand past 5,000,000 nodes
or 64 MB of text, or form a cycle, is rejected. So is a document with no faithful JSON form: a
`.nan` or `.inf` value, an integer literal that is neither the double it reads as nor that
double's shortest decimal (`9007199254740993`; `9223372036854776000` for 2^63 is read), a collection used as a mapping
key, or two keys that become the same JSON key (`200` and `"200"`, or an alias key naming a literal
key beside it). A committed spec that fails is drift (`unparseable`, repaired by `--write`); a base
that fails is a load error (exit `2`); a generated spec that fails is invalid (exit `1`, never
written).

Drift means the committed spec, parsed as YAML or JSON, differs from the generated document in
canonical JSON (key order and formatting do not count).

Version rule: versions are semver 2.0 `MAJOR.MINOR.PATCH` with optional pre-release and build;
anything else is unversioned and never covers a breaking change. A breaking change passes when the
head major is greater than the base major, or both majors are `0` and the head minor is greater.
A non-breaking change with an unchanged version is a warning. `diff: { failOnBreaking: false }` in
`apifn.config.ts` reports breaking changes without failing.

Reports: JSON is `{ drift, valid, breaking, versions: { base, head }, verdict, diff, ... }` with
`verdict` `pass`, `warn` or `fail`; Markdown starts with `<!-- apifn-ci-report -->`, the marker the
API check workflow updates in place.

Exit codes: `0` pass (warnings allowed) · `1` drift, invalid spec, or a breaking change the version
rule does not cover · `2` usage or load error, including an unknown option or a missing option
value (message on stderr, no report). When the generated spec is invalid and the differ cannot
read it, the diff is skipped (`base.status: "skipped"`) and the check exits `1` with the
validation errors.

## diff

Compare two specs (file paths or URLs) for breaking changes.

```bash
apifn diff base-openapi.yml openapi.yml --format json
```

- `--format <type>` — `text` (default) or `json`
- `--fail-on-breaking` — exit `1` on breaking changes (default `true`)

Exit codes: `0` no breaking changes · `1` breaking detected · `2` load/parse error.

## validate

```bash
apifn validate .apifn/openapi.yml --format json
```

Validation accepts references within the supplied document. Bundle split specifications into one document before running this command.

- `--format <type>` — `text` (default) or `json`

Exit codes: `0` valid · `1` validation errors · `2` load/parse error.

## serve

Serve a built-in interactive explorer with live reload (SSE on spec file changes).

```bash
apifn serve .apifn/openapi.yml --port 4100 --open
```

- `--port <port>` — default `4100`
- `--open` — open the browser automatically

## mock

Start a mock server (via [`@apifn/mock`](../mock)).

```bash
apifn mock .apifn/openapi.yml --mode examples --port 4010 --validate-requests --delay 100
```

- `--mode <mode>` — `schema` (default), `examples`, `random`
- `--port <port>` — default `4010`
- `--validate-requests` — validate incoming request bodies
- `--delay <ms>` — add response latency

## snippet

Generate a code snippet for one endpoint or the whole spec (via [`@apifn/snippets`](../snippets)).

```bash
apifn snippet .apifn/openapi.yml /users --method get --target curl
apifn snippet .apifn/openapi.yml --all --target python-requests
```

- `--target <target>` — `curl` (default), `fetch`, `axios`, `python-requests`, … (see `@apifn/snippets`)
- `--method <method>` — HTTP method (default `get`)
- `--base-url <url>` — base URL override
- `--all` — generate snippets for every endpoint

## sdk generate

Generate an installable SDK package from an operation catalog (via [`@apifn/sdk`](../sdk)).

```bash
apifn sdk generate --sdk-config sdk.config.json --catalog catalog.json --out packages/projects-sdk
apifn sdk generate --sdk-config sdk.config.json --spec openapi.json --manifest apifn.manifest.json --out packages/projects-sdk
apifn sdk generate --sdk-config sdk.config.json --catalog catalog.json --out packages/projects-sdk --check
```

- `--sdk-config <path>` — `{ "target": "typescript" | "python", "unsupported": "fail" | "exclude", "options": { … } }` (see `@apifn/sdk`)
- `--catalog <path>` — catalog built by `@apifn/contracts`; or `--spec <path>` with `--manifest <path>` to build it
- `--out <dir>` — package directory; only files the generator owns are written, and the custom-code area (`src/custom/` for TypeScript, `src/<module>/custom/` for Python) is never touched
- `--check` — write nothing (a read-only directory works); exit `1` if the directory is out of date, or if another run holds its lock or keeps writing it while it is checked
- `--format <type>` — `text` (default) or `json`

Writes the package and `apifn.sdk-manifest.json` (catalog, config, generator and target provenance, generated and excluded operations, owned file digests, warnings). Exit codes: `0` written or up to date · `1` generation errors, output conflicts (including another run holding the output directory's `.apifn-sdk.lock`), filesystem errors reading or writing it (`SDK_OUTPUT_FAILED`) or `--check` drift (nothing written; with `--format json`, each of these prints one JSON result) · `2` missing or unreadable inputs (a usage message on stderr, with no JSON result in either format).

---

## Configuration

Create an `apifn.config.ts` and type it with `defineConfig`:

```typescript
import { defineConfig } from "@apifn/cli";

export default defineConfig({
  router: "./src/router.ts",
  collection: ".apifn/collection",
  output: ".apifn",
  defaultEnvironment: "development",
  openapi: {
    info: { title: "My API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
  },
  diff: { failOnBreaking: true },
  snippets: ["curl", "python-requests"],
});
```

Config files (`.ts`/`.js`/`.mjs`) are loaded at runtime via `jiti`. Unknown top-level fields are rejected.

## Programmatic API

```typescript
import { runCli, loadConfig, defineConfig } from "@apifn/cli";

const exitCode = await runCli(["validate", ".apifn/openapi.yml", "--format", "json"], {
  cwd: process.cwd(),
  stdout: (t) => process.stdout.write(t),
});
```

- `runCli(argv?, { cwd?, stdout?, stderr? })` — run the CLI, returns an exit code
- `loadConfig({ cwd?, configPath? })` — load and validate config
- `defineConfig(config)` — typed config helper

## License

MIT
