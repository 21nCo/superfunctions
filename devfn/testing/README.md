# @devfn/testing

Deterministic fixture manifests, temporary projects, and fake listeners for allocator, lifecycle, crash-recovery, and CLI contract tests.

## Networking qualification harness

`@devfn/testing/networking` holds the versioned matrix (`devfn.networking-qualification/v1`) that DevFn's networking contract must pass on real hosts, and the harness that runs it. Each scenario names its deferred-matrix row, the prerequisites it needs, the assertions a live run must observe, the disposable resources it may create, and the local contract tests that cover the same behavior. Those tests are fixture evidence only; they never count as a live pass.

The rows are: native and Compose endpoint wiring before start, two simultaneous worktrees, hostname/path isolation, internal TLS and registered domains (1); Google OAuth sign-in in two worktrees through one relay redirect URI (2); Cloudflare and ngrok reserved/ephemeral public journeys (3); startup failure, concurrent change, crash, one-worktree stop and proxy/tunnel reload (4); and the opaque-owner endpoint interface (5). The DEV-2 networking outcome needs every scenario passed on both macOS and Linux at the exact head (`gate`).

From a built checkout (`npx turbo run build --filter=@devfn/cli --filter=@devfn/testing`):

```sh
node devfn/testing/dist/networking/cli.js plan [--approval approval.json] [--browser-operator]
node devfn/testing/dist/networking/cli.js run --head <sha> --out receipt.json [--scenario <id>]... [--row <n>]... [--approval approval.json] [--browser-operator]
node devfn/testing/dist/networking/cli.js gate --head <sha> macos.json linux.json
```

`plan` only probes. `run` drives the built DevFn CLI against a new state directory under a temporary run root, using generic fixture repositories and worktrees. It exits 0 only when every selected scenario passed.

- A scenario is `passed` only when its driver observed every planned assertion and none failed, every resource it created was removed and read back absent, and the operator's own DevFn state (allocations, routes, domains, tunnel bindings) and the OS trust stores are unchanged. Otherwise it is `failed`. `blocked` means a prerequisite or driver was unavailable (`EXTERNAL_ACCEPTANCE_GATE: …`), and `unsupported` means the host is not macOS or Linux. Neither is a pass, and Windows is never qualified.
- Prerequisites are read-only probes that fail closed. They check Node.js 22+, the built CLI, git and Caddy. The DevFn proxy ports (2019, the platform listener ports and 8444) must be free, because another runtime holding them is never touched. They also check Docker Compose and the approved resources. The harness never installs tools, trust roots or resolver entries. A registered domain must already resolve only to loopback.
- Every resource is recorded before it is created, and only inside the approved scope: the run root, an approved domain, or a run-prefixed binding or hostname. Cleanup runs even when a driver fails. It stops the run's own Caddy, reaps any process left in a run checkout, and keeps the run root for inspection when anything is not confirmed absent.
- The receipt (`networking-qualification-contract`, mode 0600) records the host, prerequisites, each observation and cleanup read-back, the endpoint interface version and provider limitations. Credential values from approved variables are redacted.

The approval file names nonproduction resources and the environment variables that hold credentials, never their values. Unknown fields, production, expired approvals and malformed names are refused:

```json
{
  "version": 1, "nonproduction": true, "approvedBy": "owner", "expiresAt": "2026-12-31T00:00:00Z",
  "domain": "dev.example.test",
  "oauth": { "provider": "google", "clientIdEnv": "QUAL_GOOGLE_CLIENT_ID", "clientSecretEnv": "QUAL_GOOGLE_CLIENT_SECRET", "relayHost": "auth", "redirectUri": "https://auth.dev.example.test:8443/oauth/callback" },
  "cloudflare": { "domain": "preview.example.test", "accountId": "<32 hex>", "zoneId": "<32 hex>", "tunnelId": "<uuid>", "credentialsFile": "/abs/tunnel.json", "apiTokenEnv": "QUAL_CF_TOKEN" },
  "ngrokReserved": { "domain": "ngrok.example.test", "authtokenEnv": "QUAL_NGROK_AUTHTOKEN", "apiKeyEnv": "QUAL_NGROK_API_KEY" },
  "ngrokEphemeral": { "authtokenEnv": "QUAL_NGROK_AUTHTOKEN", "apiKeyEnv": "QUAL_NGROK_API_KEY" }
}
```

The OAuth redirect URI must be the relay origin on this host: `https://<relayHost>.<domain>` with port 8443 on macOS and the default port on Linux. With `--browser-operator`, the run prints each worktree's login URL and waits up to 10 minutes. A person or browser agent completes the Google sign-in, and opening the URLs needs an explicit trust decision in that browser for the DevFn internal CA. The fixture apps report outcomes only, never codes or tokens. The crash scenario waits out the five-minute stale window of a killed start's lifecycle lock.
