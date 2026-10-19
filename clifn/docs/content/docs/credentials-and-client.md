---
title: Credentials and HTTP client
description: Persist named profiles and make authenticated requests with bounded retries.
---

`createCredentialStore(path?)` stores named `{ backend, key }` profiles in an INI file. Pass a product-specific path; the legacy default is `~/.conduct/credentials`. The synchronous store supports `getProfile`, `setProfile`, `hasProfile`, `removeProfile`, and `listProfiles`. A missing profile raises `MissingProfileError`.

Credential writes use a sibling lock, a mode-0600 temporary file, fsync, and atomic rename. A write that cannot take the lock throws a plain `Error` whose message is `CLIFN_CREDENTIAL_STORE_BUSY` (there is no `code` property, so match on `error.message`). A writer that crashes while holding the lock leaves the sibling `.lock` file behind, and every later write fails the same way until it is removed: stop all writers, then delete only that `.lock` file before retrying. A credentials path that is a symlink to an existing file is rejected with an `Error` whose message is `CLIFN_CREDENTIAL_SYMLINK`; a dangling symlink is treated as a missing file, and the next write replaces the link itself with a regular file. Filesystem permissions are a fallback, not encryption or an OS keychain. For keychain integration, inject a `CredentialStore` implementation and persist values before reporting success.

## Make a request

```ts
import { createApiClient } from "@clifn/core/client";
import { createCredentialStore } from "@clifn/core/credentials";
import { homedir } from "node:os";
import { join } from "node:path";

const credentials = createCredentialStore(join(homedir(), ".my-cli", "credentials"));
// A fresh file has no profiles; save one (for example from a login command) first.
if (!credentials.hasProfile("default")) {
  const key = process.env.MY_CLI_API_KEY;
  if (!key) throw new Error("Set MY_CLI_API_KEY or run the login command first");
  credentials.setProfile("default", { backend: "https://api.example.com", key });
}

const client = createApiClient({
  credentials,
  profile: "default",
  projectId: "example",
});

const response = await client.get<{ items: unknown[] }>("/items", { limit: 20 });
console.log(response.data);
```

The profile is resolved when the client is constructed, so a missing profile throws `MissingProfileError` from `createApiClient()`. Alternatively pass `{ baseUrl, apiKey }` directly and skip the credential store. The client adds Bearer authorization unless the request sets its own authorization header, and adds `X-Project-ID` when configured. Paths must be relative. Responses include status, parsed data, and headers. Non-2xx responses throw `HttpFailureError`; transport failures throw `HttpRequestError`.

Only GET requests retry by default, on HTTP 429 or 5xx and retryable transport failures. Use `request({ ..., retrySafe: true })` only when the server guarantees idempotency. One-shot stream bodies are not retried. A timed-out write may already have succeeded, so reconcile before repeating it. `ApiClientConfig` accepts `retries`, `retryDelayMs`, `timeoutMs`, `defaultHeaders`, and `fetchImpl`.
