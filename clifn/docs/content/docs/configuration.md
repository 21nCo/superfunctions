---
title: Configuration
description: Load local config files, JSON project settings, and typed environment values.
---

CliFn has separate facilities for a discovered config module, a simple JSON project config store, and environment variables. Choose the one that fits the lifecycle of the consuming CLI.

## Discover a config file

`loadConfig()` searches `config.ts`, `config.js`, `config.mjs`, `config.cjs`, then `config.json` by default. Pass `configPath` for an explicit file, `candidates` for a custom search, `exportNames` for named module exports, and `validate` for a typed value. The result includes both `config` and the resolved `path`.

```ts
import { loadConfig } from "@clifn/core/config-loader";

const loaded = await loadConfig<{ target: string }>({
  cwd: process.cwd(),
  validate(value) {
    if (!value || typeof value !== "object" || !("target" in value)) {
      throw new Error("target is required");
    }
    return value as { target: string };
  },
});
```

The loader accepts local TS, JS, MJS, CJS, and JSON files. TS uses Jiti. Module exports may be direct values, functions, or promises. Remote URLs and unsupported extensions are rejected; failures use `CLIFN_CONFIG_NOT_FOUND`, `CLIFN_CONFIG_INVALID`, `CLIFN_CONFIG_UNSUPPORTED`, or (under the data-only policy below) `CLIFN_CONFIG_UNTRUSTED`. A custom candidate list is limited to 32 entries. `defineConfig()` is an identity helper for typed authoring.

### Data-only config for untrusted workspaces

TS, JS, MJS and CJS configs run code when they are loaded. A CLI that runs in workspaces it does not trust, such as a cloned repository, passes `policy: "data-only"` (type `ConfigLoaderPolicy`; the default `"executable"` keeps the behaviour above):

- Discovery reads only `.json` candidates. `config.json` is loaded even when `config.ts` sits beside it, and no TS, JS, MJS or CJS candidate is imported. When no JSON candidate exists but an executable one does, the error is `CLIFN_CONFIG_UNTRUSTED` and names the file.
- An explicit TS, JS, MJS or CJS `configPath` raises `CLIFN_CONFIG_UNTRUSTED` before the file is checked or imported, unless the host passes `trustExecutableConfig: true`. That is the explicit, non-interactive trust signal, typically set from a flag the user passed. Only the boolean `true` trusts; the loader never prompts, and discovery stays JSON-only even with trust.
- An unknown `policy` value raises `CLIFN_CONFIG_INVALID` before any file is read.

```ts
import { loadConfig } from "@clifn/core/config-loader";

const loaded = await loadConfig({
  cwd: process.cwd(),
  configPath: flags.config,
  policy: "data-only",
  trustExecutableConfig: flags.trustConfig === true,
});
```

Catch `CLIFN_CONFIG_UNTRUSTED` to name your CLI's trust flag in the message you show.

## Store project settings

`createProjectConfig(path?)` provides a JSON store with `read`, `write`, `get`, and `set`. Pass `{ appName: "my-cli", fileName? }` for `<config>/config.json` from `resolveAppPaths` (`@clifn/core/paths`), `{ cwd?, fileName }` for a project-local file, or a product-specific path (`{ path }` is the same as the string); `fileName` must stay inside its directory, and malformed options raise `InvalidStoreOptionsError`. The legacy default is `conduct.config.json` in `process.cwd()`, resolved once when the module is first loaded. Invalid JSON or a non-object shape raises `InvalidConfigError`. It is separate from the discovered module loader.

## Read environment values

`@clifn/core/env` exports `readRequiredStringEnv`, `readStringEnv`, `readIntEnv`, and `readBooleanEnv`. Each accepts an injected `env` map for tests. Defaults, empty-string rules, and integer `min`/`max` are explicit. Errors have `CLIFN_ENV_MISSING`, `CLIFN_ENV_INVALID`, or `CLIFN_ENV_OUT_OF_RANGE` codes. See the [export reference](/docs/reference/exports) for option types.
