# clifn

Reusable CLI primitives for Superfunctions packages and downstream CLIs.

`clifn` remains a single package at `clifn/core`, published as `@clifn/core`. It is the shared parser-agnostic CLI toolkit for generic concerns that repeat across Superfunctions CLIs, while each owning CLI keeps its product-specific command graph and behavior.

Current public subpaths:

- `@clifn/core/credentials`
- `@clifn/core/config`
- `@clifn/core/client`
- `@clifn/core/ui`
- `@clifn/core/stdio`
- `@clifn/core/prompt`

New additive subpaths are exported for the generic CLI-builder surface:

- `@clifn/core/output`
- `@clifn/core/runner`
- `@clifn/core/config-loader`
- `@clifn/core/env`
- `@clifn/core/diagnostics`
- `@clifn/core/exec`
- `@clifn/core/scaffold`
- `@clifn/core/paths`
- `@clifn/core/terminal`

## Install

```bash
npm install @clifn/core
```

## Conduct CLI-style usage

```ts
import { createCredentialStore } from "@clifn/core/credentials";
import { createProjectConfig } from "@clifn/core/config";
import { createApiClient } from "@clifn/core/client";
import { readJsonStdin, writeJsonStdout } from "@clifn/core/stdio";

const credentials = createCredentialStore();
const config = createProjectConfig();
const profile = String(config.get("profile") ?? "default");

const api = createApiClient({
  credentials,
  profile,
  projectId: String(config.get("projectId") ?? ""),
});

const input = await readJsonStdin<{ command: string }>();
process.stderr.write(`running command: ${input.command}\n`);
const result = await api.post("/runs", input);
writeJsonStdout(result.data);
```

## Generic CLI usage

```ts
import { prompt } from "@clifn/core/prompt";
import { ui } from "@clifn/core/ui";

const target = await prompt.select("Target environment", [
  "local",
  "staging",
  "production",
]);
const confirmed = await prompt.confirm(`Deploy to ${target}?`);

if (!confirmed) {
  ui.warn("deployment cancelled");
} else {
  ui.success(`deployment started for ${target}`);
}
```

## Shared CLI-builder quick start

```ts
import { runAction } from "@clifn/core/runner";

const exitCode = await runAction(
  async ({ name }, ctx) => {
    ctx.output.info(`hello ${name}`);
  },
  { name: "world" },
  {
    verbose: false,
  }
);

process.exitCode = exitCode;
```

## Parser compatibility patterns

`clifn` stays parser-agnostic. The owning CLI keeps parser choice and parser dependencies, while `clifn` supplies the reusable execution and output primitives underneath.

The current repository already uses all three parser styles:

- `hostfn/cli`, `plugfn/cli`, and `extfn/cli` use `commander`
- `apifn/cli` uses `cac`
- `datafn/cli` uses raw `node:util.parseArgs`

The parser canaries under `clifn/core/tests/fixtures/*` prove that `runAction()` and the shared output service work in each style without adding parser libraries to `clifn` runtime dependencies.

### `commander`

```ts
import { Command } from "commander";
import { runAction } from "@clifn/core/runner";

const program = new Command();

program.option("--json", "Emit machine-readable output");
program
  .command("greet")
  .option("--name <name>", "Name to greet", "world")
  .action(async (options, command) => {
    const globals = command.parent?.opts() ?? {};

    process.exitCode = await runAction(
      async ({ name }, ctx) => {
        ctx.output.info(`hello ${name}`);
      },
      { name: options.name },
      {
        mode: globals.json ? "json" : "text",
      }
    );
  });

await program.parseAsync(process.argv);
```

### `cac`

```ts
import { cac } from "cac";
import { runAction } from "@clifn/core/runner";

const cli = cac("demo");

cli.option("--json", "Emit machine-readable output");
cli
  .command("greet")
  .option("--name <name>", "Name to greet")
  .action(async (options) => {
    process.exitCode = await runAction(
      async ({ name }, ctx) => {
        return {
          data: {
            ok: true,
            name,
          },
        };
      },
      { name: options.name ?? "world" },
      {
        mode: options.json ? "json" : "text",
      }
    );
  });

cli.parse(process.argv, { run: false });
await cli.runMatchedCommand();
```

### `node:util.parseArgs`

```ts
import { parseArgs } from "node:util";
import { runAction } from "@clifn/core/runner";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    json: { type: "boolean" },
  },
});

if (positionals[0] === "greet") {
  process.exitCode = await runAction(
    async ({ name }, ctx) => {
      ctx.output.info(`hello ${name}`);
    },
    { name: values.name ?? "world" },
    {
      mode: values.json ? "json" : "text",
    }
  );
}
```

Consumer ownership stays explicit:

- `clifn` owns the parser-agnostic runner/output/diagnostics/config/env/exec/scaffold helpers
- the consuming CLI owns command registration, parser wiring, and parser package installation
- parser libraries such as `commander` and `cac` remain consumer dependencies or test-only canary dependencies, not `clifn` runtime dependencies

## API Overview

### Compatibility promise

- Existing imports for `@clifn/core/credentials`, `@clifn/core/config`, `@clifn/core/client`, `@clifn/core/ui`, `@clifn/core/stdio`, and `@clifn/core/prompt` remain valid.
- The new subpaths are additive and do not replace any existing import path.
- `@clifn/core/ui` remains the compatibility-facing terminal helper path even as newer shared output primitives land in `@clifn/core/output`.

### `@clifn/core/credentials`

- `createCredentialStore(path?)` -> INI profile store.
- `createCredentialStore({ appName })` -> the same store at `<config>/credentials` from `resolveAppPaths(appName)`; `{ path }` equals the string form. Without an argument the Conduct default `~/.conduct/credentials` stays.
- `MissingProfileError` -> typed error when profile is not found.

### `@clifn/core/config`

- `createProjectConfig(path?)` -> JSON project config store.
- `createProjectConfig({ appName, fileName? })` -> `<config>/<fileName>` (default `config.json`); `{ cwd?, fileName }` -> a project-local file; `{ path }` equals the string form. Without an argument the Conduct default `conduct.config.json` stays.
- `{ appName }` stores resolve only the config directory for the current platform (`env` and `homedir` may be passed through, a different `platform` throws); `fileName` must stay inside its directory. Only own properties of the options object are read (enumerable or not; inherited keys are ignored). The selector of the form (`appName`, `path`, or `fileName` for a project-local file) must be a string, and an optional key set to `undefined` (`fileName` beside `appName`, `cwd`, `env`, `homedir`) takes its default. A selector set to `undefined` or a non-string, a key from another form, or an unknown key throws `InvalidStoreOptionsError` (`CLIFN_INVALID_STORE_OPTIONS`) instead of falling back to another form or the Conduct default. Every own property descriptor is captured before any getter runs, and each getter is called once. An object-form target must name a file: `{ path: "" }`, a path ending in a separator or a root (`C:\`, `\\server\share`), `.` or `..`, and a NUL character in `path`, `fileName` or `cwd` throw `InvalidStoreOptionsError` before any filesystem call; the string form is used as given. `fileName` cannot start with a drive (`C:`) before or after normalization (`./C:x`). On Windows no `fileName` segment, and not the base name of an object-form target, may contain `:`, be a device name (`nul`, `CON.json`) or end with a dot or space, since Windows would open a device or another name. Loading the module does not fail when the home or working directory is unavailable; the no-argument defaults are still taken at import when they can be.
- `InvalidConfigError` -> typed error for invalid JSON/object shapes.

### `@clifn/core/client`

- `createApiClient(config)` -> authenticated HTTP client with retries.
- `HttpFailureError` -> typed error for non-2xx responses.
- `HttpRequestError` -> typed error for network/transport failures.

### `@clifn/core/ui`

- `ui.success`, `ui.error`, `ui.warn`, `ui.info`
- `ui.spinner(message)` -> start/stop/succeed/fail
- `ui.table(rows)` -> deterministic table output

### `@clifn/core/stdio`

- `readJsonStdin<T>()` -> parse one JSON document from stdin.
- `writeJsonStdout(value)` -> serialize one JSON document + trailing newline.
- `InvalidJsonStdinError` -> typed deterministic parse failure.

### `@clifn/core/prompt`

- `prompt.select`
- `prompt.multiSelect`
- `prompt.text`
- `prompt.confirm`
- `createPrompt({ ask?, output?, nonInteractive? })`: with `nonInteractive: true` every prompt throws `PromptInputError` with code `CLIFN_PROMPT_NON_INTERACTIVE`; an options object that names `output` or `nonInteractive` writes questions to `output`, else stderr. `createPrompt()`, `createPrompt({ ask })` and `prompt` keep writing to stdout.

### New shared CLI-builder modules

These module entrypoints are the generic surface that repository CLIs can share:

- `@clifn/core/output`
  - generic text/JSON output service contract
  - quiet/verbose behavior
  - deterministic table rendering
  - spinner surface
- `@clifn/core/runner`
  - parser-agnostic action runner contract
  - normalized action context with output, diagnostics, exec, scaffold, cwd, env, and non-interactive state
  - `jsonStyle: 'document'` with `mode: 'json'` (D8) prints exactly one newline-terminated JSON document on stdout, on success or failure: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message","details"?}}`, with `diagnostics` only when there are any. Every log level, and a spinner's `succeed`/`fail` message, is a JSON line on stderr (`quiet` and `verbose` apply as in JSON lines), and streamed child output (`exec.command(file, args, { streamOutput: true })`) goes to stderr unless that command passes its own `stdout`/`stderr` writer. `output.json()` and `output.table()` are collected: when the action returns no `data`, the last `json` value becomes `data`; absent data, or data JSON leaves out, prints `null`; a stderr warning names each call that was not used. Leaving `jsonStyle` out keeps JSON lines, and text mode is unchanged
  - document error codes and exit codes follow the CLI-12 classification: a string `code` matching `^[A-Z][A-Z0-9_]{1,63}$`, else a message that is exactly `CLIFN_...` (with a fixed description), else `CLIFN_RUNNER_FAILED`; the exit code is an integer `exitCode` from 1 to 125, else 1. Plain-object `details` are kept when they serialize to a JSON object and left out otherwise; a diagnostic whose code, severity or message is not a string, or that cannot be serialized, is left out with a fixed stderr warning
  - document redaction is key-based on the emitted structure: in `data` (including the `json()` fallback), error `details` and diagnostic `details`, every object key matching the sensitive-key pattern (`authorization`, `token`, `secret`, `password`, `cookie`, `api key`, `session id`, `access key`, `refresh token`, case-insensitive, with or without `-`/`_`) or `DOCKER_AUTH_CONFIG` prints `"[REDACTED]"`. Keys are matched after each `toJSON` runs, so keys a projection creates are covered. Messages (thrown, diagnostic and log) print as given, and a custom `toJSON` that renames a sensitive key (`password` to `pw`) or puts a secret under an unrelated key prints what it returns: callers supply safe messages and safe projections. Redaction covers the stdout document only: stderr log lines print their message and `details` as given, as in JSON lines
  - document bounds: values are serialized in one pass that follows `JSON.stringify` (each member, getter and `toJSON` is read or run once, in native order); bigints print as strings, an object already being serialized prints `"[Circular]"`, and a `toJSON` that keeps projecting back to the same value for the same member key is cut with `"[Circular]"` after 64 nested projections for that key; projections for other keys (a finite sibling of the cut branch) print in full, at any depth and in any member order, and a `toJSON` that keeps branching back to itself under several keys fails on the bounds below. A document is at most the smaller of the engine's maximum string length and a sixteenth of V8's heap limit, in characters including its newline; a redacted value costs only its key and placeholder, and work that prints nothing (each value walked under a redacted key, each object member JSON leaves out, each scan of text found too long to print, each character of details or a diagnostic written and then left out, and 32 units per typed-array index) has its own allowance of twice the document's characters, so a document that fits prints next to it; a sensitive key is matched only once its member prints. An array longer than the room left fails before its first item is read, a typed array is bounded by its length before its keys are listed (redacted or not), Node's built-in `Buffer` `toJSON` is bounded by the buffer's length before it copies the bytes, a bigint is checked by size before it is converted and never converted under a redacted key, and nesting deeper than 512 levels fails; a Proxy's keys are listed by the engine, so a Proxy is bounded only by what its `ownKeys` returns. A result whose `data`, `exitCode` or `diagnostics` getter throws prints the same fixed document; a returned diagnostic that cannot be read (a throwing index getter, a failing iterator, a value that is not a list) is left out with a warning while its siblings, the data and the exit code are kept; `onDiagnostics` is called once, and its throw after a successful action is the run's failure. Data that does not fit or cannot be serialized prints the fixed `{"ok":false,"error":{"code":"CLIFN_RUNNER_FAILED","message":"Unable to serialize the result document"}}` (exit 1); error details that do not fit are left out and an error message that does not fit is replaced by a fixed one, keeping the code and exit code; diagnostics that do not fit are left out with a warning, and no more diagnostics are kept or read than a document can print. Stderr warnings and streamed child output without its own writer are advisory: at most 20 warnings per kind plus one summary line, and a stderr writer that throws on them does not change the document or the exit code; a code longer than 64 characters, or a message longer than the document, is never scanned as a code
- `@clifn/core/config-loader`
  - shared config discovery and typed loading contract for TS/JS/MJS/CJS/JSON configs
  - uses the same Jiti-informed `.ts` loading path already established in `packages/cli` and `apifn/cli`
- `@clifn/core/env`
  - generic environment readers for strings, integers, and booleans
  - explicit missing, invalid, and out-of-range error codes for shared CLI callers
- `@clifn/core/diagnostics`
  - shared diagnostic model plus deterministic sort/redaction/formatting surface
- `@clifn/core/exec`
  - subprocess execution contract for buffered capture, streaming, and timeout reporting
- `@clifn/core/scaffold`
  - deterministic file and directory scaffolding contract with explicit overwrite policy
- `@clifn/core/paths`
  - `resolveAppPaths(appName, { platform?, env?, homedir? })` -> `{ config, state, cache }`: `$XDG_CONFIG_HOME`, `$XDG_STATE_HOME` and `$XDG_CACHE_HOME` (else `~/.config`, `~/.local/state`, `~/.cache`) followed by `/<app>` on Linux, macOS and other POSIX platforms; `%APPDATA%\<app>` and `%LOCALAPPDATA%\<app>\State` / `\Cache` on Windows (else `<home>\AppData\Roaming` / `Local`)
  - environment values count only when they are absolute paths (a UNC path needs a real server and share; device and extended-length `\\.\` / `\\?\` paths are not used, and the home directory follows the same rule); relative or empty values, and values containing a NUL character, use the defaults, and only a default reads the home directory (a home directory containing a NUL is invalid)
  - app names match `^[a-z0-9][a-z0-9._-]{0,63}$`, else `InvalidAppNameError` (`CLIFN_INVALID_APP_NAME`); on Windows (`platform: "win32"`, and the stores on Windows) a name also cannot end with `.` (Windows drops it, so `tool.` would share `tool`'s directories) or be a device name (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`), with or without an extension (`nul.txt`)
  - `ensureAppDir(dir)` creates a missing directory with mode `0o700` on POSIX and resolves to `dir`; concurrent calls on one path both resolve
  - symlinks or directories that another program plants under these paths are not defended against yet
- `@clifn/core/terminal`
  - `resolveTerminal({ env?, stdin?, stdout?, stderr?, json? })` -> `{ color, interactive, ci }`: a non-empty `NO_COLOR` disables colour; `FORCE_COLOR` `0`/`false` disables and `1`/`2`/`3`/`true` enables it; `TERM=dumb` disables it; otherwise colour follows whether stderr is a TTY. `ci` is `CI` set to anything but empty, `0` or `false`; `interactive` needs TTY stdin and stderr, no CI and no JSON
  - `resolveRunnerOptions({ json?, quiet?, verbose?, color?, yes?, nonInteractive? }, { env?, streams? })` -> runner options (`mode`, `'json'` with `jsonStyle: 'document'` for `json`; `color`, `stderrColor`, `quiet`, `verbose`, `nonInteractive`) from the flags your parser produced; `color: true`/`false` overrides the rules and `'auto'` uses them; `stderrColor` (errors, spinner) follows the rules and, in text mode, `color` (`info`, `success` and `warn` on stdout) also needs a TTY stdout unless `FORCE_COLOR` enables it (commander and cac give a lone `--no-color` a default of `true`, so pass `color: opts.color === false ? false : 'auto'`)

## Adoption boundary

`clifn` is the shared home for generic CLI-builder concerns that appear across existing repository CLIs such as:

- `packages/cli` and `apifn/cli` for config loading patterns
- `hostfn/cli`, `plugfn/cli`, and `apifn/cli` for output and command-runner patterns
- `plugfn/cli` and `mcpfn/cli` for structured diagnostics and test/reporting surfaces

Responsibilities that belong in `clifn`:

- generic action execution
- generic output formatting and machine-readable output
- config discovery/loading contracts
- generic env readers
- generic diagnostics formatting
- generic subprocess helpers
- generic scaffolding helpers

Responsibilities that stay in the owning CLI:

- product-specific command graphs
- business/domain validation
- domain-specific scan rules
- deployment or packaging rules tied to one product
- browser-extension orchestration and manifest-aware behavior

## Representative adoption notes

### `packages/cli`

- Repeated pattern today:
  - config discovery and loading in `packages/cli/src/utils/load-library-config.ts`
  - config-path fallback logic in `packages/cli/src/utils/config.ts`
- `clifn` adoption target:
  - `@clifn/core/config-loader` for deterministic TS/JS/MJS/CJS/JSON loading
- Product-owned concerns that stay local:
  - schema and library semantics specific to `@superfunctions/cli`

### `apifn/cli`

- Repeated pattern today:
  - `cac` command registration in `apifn/cli/src/index.ts`
  - config loading in `apifn/cli/src/config.ts`
  - output helpers in `apifn/cli/src/utils/output.ts`
- `clifn` adoption target:
  - keep `cac`, but move generic concerns onto `@clifn/core/runner`, `@clifn/core/output`, and `@clifn/core/config-loader`
- Product-owned concerns that stay local:
  - OpenAPI generation, diff semantics, mock/serve behavior, and collection rules

### `hostfn/cli`

- Repeated pattern today:
  - `commander` command registration and repeated async `try/catch` wrappers in `hostfn/cli/src/index.ts`
  - logger formatting in `hostfn/cli/src/utils/logger.ts`
- `clifn` adoption target:
  - keep `commander`, but move shared action execution and output concerns onto `@clifn/core/runner`, `@clifn/core/output`, and `@clifn/core/exec`
- Product-owned concerns that stay local:
  - deployment workflows, SSH/server orchestration, runtime adapters, and host-specific validation

### `plugfn/cli`

- Repeated pattern today:
  - text/json rendering in `plugfn/cli/src/commands/runtime.ts`
  - structured diagnostics in `plugfn/cli/src/commands/test.ts`
- `clifn` adoption target:
  - `@clifn/core/output` for generic mode switching and transport
  - `@clifn/core/diagnostics` for stable diagnostic formatting
  - keep domain-specific formatters local where they encode provider/runtime semantics
- Product-owned concerns that stay local:
  - provider diagnostics, webhook fixtures, and integration-specific data shapes

### extfn adoption contract

`extfn/cli` is an explicit future adopter of the generic `clifn` surface, but only for generic CLI concerns.

`extfn/cli` SHOULD use:

- `@clifn/core/runner` for normalized action execution and exit handling
- `@clifn/core/output` for text/json output, quiet/verbose behavior, and spinner usage
- `@clifn/core/diagnostics` for stable formatting and redaction of generic diagnostics
- `@clifn/core/config-loader` for extension config discovery and loading
- `@clifn/core/env` for generic env parsing
- `@clifn/core/exec` for subprocess orchestration during builds and packaging
- `@clifn/core/scaffold` for template-free deterministic file creation

`extfn/cli` MAY keep:

- its preferred parser (`commander`, `cac`, or raw `parseArgs`)
- product-specific formatter helpers that encode extension semantics

`extfn/cli` MUST stay extfn-owned for:

- Vite-based extension orchestration
- browser launching behavior
- extension packaging rules and archive layout
- manifest-aware scan rules
- plugin-specific contracts such as extension plugin wiring
- target-specific extension validation

If `extfn/cli` needs a generic capability that is not yet exported by `clifn`, that capability should be added to `clifn` first instead of being reimplemented as extfn-local CLI infrastructure.

## Notes

- Package path follows repo convention: `clifn/core` workspace, package name `@clifn/core`.
- `clifn` is designed for public imports only; no private/internal path imports are required.
- The generic modules prefer repository-shared mechanisms, including the existing `packages/cli` loader pattern, before introducing new runtime dependencies.
- `@clifn/core/config-loader` rejects remote config URLs and unsupported extensions with explicit error codes.
- `@clifn/core/env` uses explicit `CLIFN_ENV_*` error codes for missing, invalid, and out-of-range values.

## Conduct v0.3 compatibility note

`clifn` intentionally exposes stable subpath imports for Conduct and other CLIs:

- `@clifn/core/credentials`
- `@clifn/core/config`
- `@clifn/core/client`
- `@clifn/core/ui`
- `@clifn/core/stdio`
- `@clifn/core/prompt`

Use these public subpaths directly; do not import from internal `dist/*` paths.

## Application credentials and safe retry defaults

Pass `{ appName }` (or an explicit path) to `createCredentialStore` for each product so it stores credentials in its own config directory; the legacy no-argument default remains Conduct-specific. Writes hold an exclusive sibling `.lock`, write and fsync a unique mode-0600 temporary file, then rename it atomically. Concurrent writes fail with `CLIFN_CREDENTIAL_STORE_BUSY` rather than losing updates. After a process crash, stop all writers and inspect/remove only its stale lock before retrying. Symlink credential files are rejected. Filesystem permissions are a fallback, not encryption or an OS keychain.

The synchronous `CredentialStore` interface is injectable into `createApiClient`. A consumer keychain adapter should use a product-specific service name and profile account, store each complete `{backend,key}` value atomically, and expose only profile names in diagnostics. An asynchronous OS keychain can be loaded at CLI startup into a short-lived in-memory implementation; persist changes through the keychain before reporting success. Never serialize keychain values to a config file as an implicit fallback.

Only GET requests retry by default. `request({ ..., retrySafe: true })` opts in when the server guarantees idempotency for that operation; it does not manufacture such a guarantee. Non-replayable request bodies are not retried. A timed-out write may already have succeeded and must be reconciled.

Executable naming belongs to the consumer package. Rex's `rex-agent` package should declare both `rex` and `rex-agent` bins targeting the same entrypoint, detect an existing `rex` command and document the fallback. Do not use forced installation to overwrite another package's executable.
