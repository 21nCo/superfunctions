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
  - document error codes and exit codes follow the CLI-12 classification: a string `code` matching `^[A-Z][A-Z0-9_]{1,63}$`, else a message that is exactly `CLIFN_...` (with a fixed description), else `CLIFN_RUNNER_FAILED`; the exit code is an integer `exitCode` from 1 to 125, else 1. Plain-object `details` (with a null prototype or the `Object.prototype` of any realm, such as a `vm` context) are kept when they serialize to a JSON object and left out otherwise; a diagnostic whose code or message is not a string, whose severity is not `error`, `warning` or `info`, or that cannot be serialized, is left out with a fixed stderr warning
  - document redaction is key-based on the emitted structure: in `data` (including the `json()` fallback), error `details` and diagnostic `details`, every object key matching the sensitive-key pattern (`authorization`, `token`, `secret`, `password`, `cookie`, `api key`, `session id`, `access key`, `refresh token`, case-insensitive, with or without `-`/`_`) or `DOCKER_AUTH_CONFIG` prints `"[REDACTED]"`. Keys are matched after each `toJSON` runs, so keys a projection creates are covered. Messages (thrown, diagnostic and log) print as given, and a custom `toJSON` that renames a sensitive key (`password` to `pw`) or puts a secret under an unrelated key prints what it returns: callers supply safe messages and safe projections. Redaction covers the stdout document only: stderr log lines print their message and `details` as given, as in JSON lines
  - document bounds: values are serialized in one pass that follows `JSON.stringify` (each member, getter and `toJSON` is read or run once, in native order; a `JSON.rawJSON` value prints its raw text; an index accessor installed on `Array.prototype` is not supported); bigints print as strings, an object already being serialized prints `"[Circular]"`, and a `toJSON` that keeps projecting back to the same value for the same member key is cut with `"[Circular]"` after 64 nested projections for that key; projections for other keys (a finite sibling of the cut branch) print in full, at any depth and in any member order, and a `toJSON` that keeps branching back to itself under several keys fails on the bounds below. A document is at most the smaller of the engine's maximum string length and a sixteenth of V8's old-generation limit (V8 reports only its heap limit, which also counts a young generation that differs by Node version, and the flags that sized the heap may be out of sight, so the old generation is taken as the heap limit less a young generation at least as large as the isolate's: the command line's `--max-semi-space-size`'s, or else the larger of the one Node configured the isolate with (in a worker, the size its `resourceLimits` report, which process flags other than a semi-space size do not change; on the main thread, the V8 version's default: 48 MiB on Node 20 and 22, 192 MiB on Node 24, 96 MiB on Node 26, and 192 MiB on any other version) and a `NODE_OPTIONS` `--max-semi-space-size`'s; exact sizes come first: on the main thread the command line's `--max-old-space-size` when the rest of the heap limit is a young generation's size (three semi-spaces of a power of two), and on either `NODE_OPTIONS`' when it and the young generation the flags leave add up to the heap limit; `NODE_OPTIONS` is read only as the module found it when it loaded, so a change made before then cannot raise the limit and one made after does not change it; in a worker, the `--max-old-space-size` it can see (the command line's, else `NODE_OPTIONS`') also caps it, since a process flag overrides a worker's own old generation; a size of 0 is V8's own sizing and counts as no flag; on a machine with less memory than its Node version's default young generation assumes, the limit is lower; a `--max-semi-space-size` hidden from a worker that also sees no `--max-old-space-size` (`execArgv: []` and `env: {}`) is not accounted for), in characters including its newline; a redacted value costs only its key and placeholder. Work has two allowances of its own: twice the document's characters, plus a quarter of them for the keys of members that print, for work that prints nothing, and six units per document character for work done for values that print. Every charge goes through one table, by the kind of work and whether its member is under a redacted key: each own key of each object costs 1 unit plus 1 per 64 characters of the key as it is listed (printed, left out, skipped by JSON such as a non-enumerable or symbol key, or under a redacted key; never given back, also when the object then fails, so listing the same object again and again stops), which also pays for matching the key against the sensitive-key pattern once, before its member is read; 32 units per typed-array index (or per item Node's built-in `Buffer` `toJSON` copies) and each character of a numeric string read as an array length or from a `Number` box go to the allowance for values that print (a typed array of numbers prints at least six characters per index), or under a redacted key to the allowance for work that prints nothing; each array item walked under a redacted key, each scan of text found too long to print, a bigint found too long to print (the characters left, or its decimal text) and each character of details or a diagnostic written and then left out go to the allowance for work that prints nothing (text that does not fit is never counted, so a member too long to print, such as an oversized `JSON.rawJSON` value, costs only what was written before it). A printed member costs at least its key's length plus four characters, so a document that fits spends at most a quarter of its characters' worth on keys, and its work that prints nothing keeps the whole twofold allowance in any member order; because each member's redaction is decided before its value is read, all the work of a member under a redacted key, its own projection included (a `Number` box's numeric string, a `Buffer` copied by Node's built-in `toJSON`), is charged as work that prints nothing, and printed values never use up that allowance. An array longer than the room left fails before its first item is read, a typed array is bounded by its length before its keys are listed (redacted or not), a `Buffer` projected by Node's built-in `toJSON` is read in place and bounded like an array by its length (a Proxy, a receiver that is not a typed array or a shadowed `length` fails instead of being copied), a bigint is checked against the characters left before it is converted (a check whose cost depends on those characters, not on the bigint's size), never converted under a redacted key, and converted by the primitive's own ToString (`String(value)`), which never reads `BigInt.prototype`, so a `toString` replaced even before the module loads is never called (the string encoder accepts only primitive strings), an array length and a boxed `Number` or `String` are converted as `JSON.stringify` converts them (`Symbol.toPrimitive`, `valueOf` and `toString` run once each, in native order) but a numeric string longer than 1,024 characters fails before it is read and a bigint from a `String` box is bounded and printed like any bigint, and nesting deeper than 512 levels fails; only one key list of an object is held, and the key lists of the objects open on the path may hold a quarter of the document's characters in keys together, at least 65,536 (a document whose members all print never comes near it, and a redacted subtree below that count is bounded by the work allowance alone), so an object nested below lists that hold more fails before its own keys are listed, even by a Proxy's `ownKeys` trap, and an object whose list would take them past it fails once that list is charged, before any of its descriptors is read; the engine takes a Proxy's key list (from its `ownKeys` trap, or its target's keys for a Proxy without that trap) before it can be charged, after which its descriptors are charged like any other keys. A result whose `data`, `exitCode` or `diagnostics` getter throws prints the same fixed document; returned `diagnostics` are read only from an array (what `Array.isArray` accepts, through proxies and realms): its length once, then each index; any other value (a generator or other iterable, a `Set`, a string, a `String` object of any realm, proxied or not, an array-like object or a primitive) is one unreadable entry, and no iterator is ever opened; a returned diagnostic that cannot be read (a throwing index getter, or a list whose length cannot be read or is a numeric string longer than 1,024 characters) is left out with a warning while its siblings, the data and the exit code are kept; each diagnostic is written once, when it is added or returned (each member read once, its details through their `toJSON`), and the run keeps that redacted text, never the object it was given, so a later change to the object is not printed; `ctx.diagnostics.list()` and `onDiagnostics` (called once) receive copies parsed from the text, redacted as the document prints them, without the entries that could not be read or printed, and the listener's throw after a successful action is the run's failure. What a run keeps for its diagnostics is bounded by the document limit: each kept diagnostic is one string of its text and its length, and their text by what a document can print after its smallest data, and the work of writing them by its own allowance of twice the limit (a string left out for size costs its length, at most the limit); reading returned or added diagnostics stops once nothing more can be kept. A diagnostic added while another is being written (from its getter or `toJSON`) is dropped with a warning, so it cannot spend the budget the diagnostic being written reserved. The listed copies always carry the code, severity, message and path; their details are parsed only while 32 units per character of details text fit an allowance of the limit (about the document's size in bytes), and past it a diagnostic is listed without details, though the document still prints them. Data that does not fit or cannot be serialized prints the fixed `{"ok":false,"error":{"code":"CLIFN_RUNNER_FAILED","message":"Unable to serialize the result document"}}` (exit 1), and stderr still warns for each diagnostic and `json()`/`table()` call it leaves out; error details that do not fit are left out and an error message that does not fit is replaced by a fixed one, keeping the code and exit code; diagnostics that do not fit after the data or error are left out with a warning, and a kept diagnostic whose details alone do not fit prints without them. A thrown value's code, message (or `name`) and exit code are read and classified before its `details`, so a details getter or projection cannot change them. The fixed failure document and the stderr warnings the runner writes are fixed text (`{"level":"warn","message":...}` lines), so nothing inherited such as an `Object.prototype.toJSON` changes them. Stderr log lines, spinner results, warnings and streamed child output without its own writer are advisory (a log or spinner call that fails while it formats its line, or whose writer throws, loses only that line): at most 20 warnings per kind plus one summary line, and a stderr writer that throws on them does not change the document or the exit code; a code longer than 64 characters, or a message longer than the document, is never scanned as a code
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
