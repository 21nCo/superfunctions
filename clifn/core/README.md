# clifn

Reusable CLI primitives for Superfunctions packages and downstream CLIs.

`clifn` provides six public subpaths:

- `clifn/credentials`
- `clifn/config`
- `clifn/client`
- `clifn/ui`
- `clifn/stdio`
- `clifn/prompt`

## Install

```bash
npm install clifn
```

## Conduct CLI-style usage

```ts
import { createCredentialStore } from "clifn/credentials";
import { createProjectConfig } from "clifn/config";
import { createApiClient } from "clifn/client";
import { readJsonStdin, writeJsonStdout } from "clifn/stdio";
import { ui } from "clifn/ui";

const credentials = createCredentialStore();
const config = createProjectConfig();
const profile = String(config.get("profile") ?? "default");

const api = createApiClient({
  credentials,
  profile,
  projectId: String(config.get("projectId") ?? ""),
});

const input = await readJsonStdin<{ command: string }>();
ui.info(`running command: ${input.command}`);
const result = await api.post("/runs", input);
writeJsonStdout(result.data);
```

## Generic CLI usage

```ts
import { prompt } from "clifn/prompt";
import { ui } from "clifn/ui";

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

## API Overview

### `clifn/credentials`

- `createCredentialStore(path?)` -> INI profile store.
- `MissingProfileError` -> typed error when profile is not found.

### `clifn/config`

- `createProjectConfig(path?)` -> JSON project config store.
- `InvalidConfigError` -> typed error for invalid JSON/object shapes.

### `clifn/client`

- `createApiClient(config)` -> authenticated HTTP client with retries.
- `HttpFailureError` -> typed error for non-2xx responses.
- `HttpRequestError` -> typed error for network/transport failures.

### `clifn/ui`

- `ui.success`, `ui.error`, `ui.warn`, `ui.info`
- `ui.spinner(message)` -> start/stop/succeed/fail
- `ui.table(rows)` -> deterministic table output

### `clifn/stdio`

- `readJsonStdin<T>()` -> parse one JSON document from stdin.
- `writeJsonStdout(value)` -> serialize one JSON document + trailing newline.
- `InvalidJsonStdinError` -> typed deterministic parse failure.

### `clifn/prompt`

- `prompt.select`
- `prompt.multiSelect`
- `prompt.text`
- `prompt.confirm`

## Notes

- Package path follows repo convention: `clifn/core` workspace, package name `clifn`.
- `clifn` is designed for public imports only; no private/internal path imports are required.

## Conduct v0.3 compatibility note

`clifn` intentionally exposes stable subpath imports for Conduct and other CLIs:

- `clifn/credentials`
- `clifn/config`
- `clifn/client`
- `clifn/ui`
- `clifn/stdio`
- `clifn/prompt`

Use these public subpaths directly; do not import from internal `dist/*` paths.
