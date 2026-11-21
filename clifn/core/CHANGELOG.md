# Changelog

## 0.3.0

- Added `@clifn/core/paths` (CLI-13, D7), also exported from the root: `resolveAppPaths(appName, { platform?, env?, homedir? })` returns the config, state and cache directories (XDG on Linux and macOS, `%APPDATA%` / `%LOCALAPPDATA%` on Windows; relative or empty environment values fall back to the defaults), and `ensureAppDir(dir)` creates a missing directory with mode `0o700`. App names follow `^[a-z0-9][a-z0-9._-]{0,63}$`; anything else throws `InvalidAppNameError` (`CLIFN_INVALID_APP_NAME`). A non-absolute home directory throws `InvalidHomeDirectoryError` when a default directory needs it.
- `createCredentialStore` accepts `{ appName }` (`<config>/credentials`) or `{ path }`; `createProjectConfig` accepts `{ appName, fileName? }` (`<config>/config.json` by default), `{ cwd?, fileName }` or `{ path }`; `{ appName }` stores resolve for the current platform (`env` and `homedir` may be passed through). Options are read as own keys; malformed options (a selector set to `undefined` or a non-string, a key from another form, an unknown key, or a `platform` other than the current one) throw `InvalidStoreOptionsError` (`CLIFN_INVALID_STORE_OPTIONS`). On Windows a UNC value needs a real server and share, and device or extended-length (`\\.\`, `\\?\`) values are not used.
- No existing export, default or output changed: the string and no-argument forms keep their paths, including the Conduct defaults.

## 0.2.0

- Added the consumer compatibility baseline (CLI-11): `tests/consumer-contract.table.ts` lists every `@clifn/core` import that `@extfn/cli`, `@plugfn/cli`, `@mailfn/cli`, `@devfn/cli` and `@devfn/config` use; `consumer-contract.test.ts` checks each runtime symbol's kind from the built subpath, `consumer-contract.test-d.ts` checks the types and option shapes those consumers rely on, and `consumer-scan.test.ts` fails when a consumer imports a symbol or subpath the table does not list.
- Declared `engines.node` `>=20`. The runtime `ini` dependency moves from `^5.0.0` to `^4.1.3`, whose engines admit every Node 20 release; `ini` 5.0.0 only narrowed the engines range to `^18.17.0 || >=20.5.0` and ships the same code.
- Added a `typecheck` script; `test` now runs once (`vitest run`) and includes the type-level contract tests.
- No export, default or output changed.

## 0.1.0

- Added a Conduct v0.3 compatibility note documenting stable public subpath imports.
- Confirmed public import guidance for `credentials`, `config`, `client`, `ui`, `stdio`, and `prompt`.
