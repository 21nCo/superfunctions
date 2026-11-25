---
title: Public exports
description: Map CliFn subpaths to their public functions, types, and errors.
---

`@clifn/core` provides these public subpaths. Import from a subpath or the documented package root, never from `dist/*`.

| Subpath | Main exports | Detail |
| --- | --- | --- |
| `/runner` | `runAction`, `RunnerOptions`, `RunnerJsonStyle`, `RunnerContext`, `RunnerActionResult` | Normalized action execution and exit code; one redacted JSON result document with `jsonStyle: 'document'` |
| `/output` | `createOutput`, `OutputOptions`, `OutputService`, `OutputTable`, `Spinner` | Text and JSON output, tables, spinners |
| `/diagnostics` | `createDiagnostic`, `sortDiagnostics`, `redactDiagnostics`, `formatDiagnosticsText`, `formatDiagnosticsJson`, `Diagnostic` | Stable report formatting and redaction |
| `/config-loader` | `defineConfig`, `loadConfig`, `ConfigLoaderOptions`, `LoadedConfig`, `ConfigLoaderError` | Discover and load TS/JS/MJS/CJS/JSON config |
| `/env` | `readRequiredStringEnv`, `readStringEnv`, `readIntEnv`, `readBooleanEnv`, option types | Typed environment values |
| `/exec` | `createExec`, `ExecOptions`, `ExecResult`, `ExecTimeoutError` | Subprocesses, capture, streams, timeout |
| `/scaffold` | `createScaffold`, `ScaffoldOperation`, `ScaffoldResult`, `ScaffoldError` | Bounded directory and file writes |
| `/credentials` | `createCredentialStore`, `CredentialStore`, `CredentialStoreOptions`, `CredentialProfile`, `MissingProfileError`, `InvalidStoreOptionsError` | Named INI credential profiles, by path or app name |
| `/config` | `createProjectConfig`, `ProjectConfigStore`, `ProjectConfigOptions`, `InvalidConfigError`, `InvalidStoreOptionsError` | JSON project settings, by path, app name or project-local file |
| `/paths` | `resolveAppPaths`, `ensureAppDir`, `AppPaths`, `AppPathsOptions`, `InvalidAppNameError`, `InvalidHomeDirectoryError` | Per-app config, state and cache directories |
| `/terminal` | `resolveTerminal`, `resolveRunnerOptions`, `TerminalState`, `RunnerFlags`, `ResolvedRunnerOptions` | Colour, interactivity and CI rules; global flags to runner options |
| `/client` | `createApiClient`, `ApiClient`, `ApiClientConfig`, `ApiRequestOptions`, `ApiResponse`, HTTP errors | Authenticated HTTP requests |
| `/ui` | `ui`, `Spinner` | Compatibility terminal helpers |
| `/stdio` | `readJsonStdin`, `writeJsonStdout`, `InvalidJsonStdinError` | One-document JSON pipes |
| `/prompt` | `prompt`, `createPrompt`, `PromptApi`, `PromptOptions`, `PromptInputError` | Interactive input; non-interactive prompts throw `CLIFN_PROMPT_NON_INTERACTIVE` |

See the [package export map](https://github.com/21nCo/super-functions/blob/dev/clifn/core/package.json), [source files](https://github.com/21nCo/super-functions/tree/dev/clifn/core/src), and the task-oriented guides for behavior, defaults, and failure modes.
