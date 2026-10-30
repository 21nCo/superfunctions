# DevFn

DevFn runs heterogeneous local environments through one command contract while keeping application processes native and infrastructure Compose-backed where appropriate.

```bash
npx @devfn/cli init
npx @devfn/cli init --yes
npx @devfn/cli doctor --trust
npx @devfn/cli up --profile default
npx @devfn/cli status --json
npx @devfn/cli logs app
npx @devfn/cli down
npx @devfn/cli domains register dev.example.test --tls internal
npx @devfn/cli domains list
npx @devfn/cli oauth-relay start dev.example.test
npx @devfn/cli oauth-relay status
npx @devfn/cli oauth-relay stop
npx @devfn/cli tunnel urls --profile share
npx @devfn/cli up --profile share --allow-public
```

Registering a domain requires it to resolve already, and only to loopback addresses (`127.0.0.1`, or `::1` where available). A reserved name such as `dev.example.test` does not resolve until you configure local DNS for it yourself; DevFn never edits resolver, hosts or trust-store configuration.

Profiles that declare public processes or ports require `--allow-public` on every start.
`devfn oauth-relay start <domain>` serves one registered OAuth redirect URI host, `auth.<domain>` by default, for every worktree on the machine; see [the relay contract](../docs/configuration.md#oauth-callback-relay). `devfn tunnel register|list|unregister|urls|status|recover` manages public Cloudflare or ngrok tunnel bindings; `tunnel urls` and `tunnel status` report when each binding's public URLs are known and its provider's capability gaps; see [public tunnel routes](../docs/configuration.md#public-tunnel-routes) and [ngrok bindings](../docs/configuration.md#ngrok-bindings).
`devfn ports gc` reconciles leases and retires listener claims with conclusive evidence. It removes the proxy routes of an instance only when its recorded process and container owners, including those of failed or interrupted starts, are all verified dead (for example a deleted worktree); an owner whose identity cannot be read counts as running. Finally, gc collects released records.
`devfn restart` validates the selected profile and registered domains, then reserves replacement ports before stopping a ready instance. A rejected domain, route, or port selection leaves that instance running. After those checks it stops the instance and starts it again from the current working tree. If that start fails, the previous processes are not relaunched and the error says so. Cleanup of the failed start can itself fail and leave some of its new processes or containers running; when the error reports cleanup errors, run `devfn down` again.

The first load of any manifest requires `--trust` because JSON and executable manifests can both declare lifecycle commands. Trust is bound to the manifest digest, so edits require review and trust again. Lifecycle mutations return receipts in JSON mode; read-only commands return command-specific structured data, and failures use stable error codes. Runtime files are written with restrictive permissions under `.devfn/` by default.

Setup tasks (finite `task` processes or Compose services) run before the nodes that depend on them; a start fails, and rolls back, when one fails, times out or is cancelled. The first SIGINT or SIGTERM received while a task runs cancels it and the start; a second of either kind ends DevFn at once. Outside task runs both signals keep their default behavior. A recorded success for a task's current input revision skips it. A non-idempotent task with an attempt since its last success that may have partly applied (an idempotent one reruns instead), or a run-once task whose inputs changed, blocks every later start before anything is mutated until `devfn up --rerun-task <name>` (repeatable; `devfn restart --rerun-task <name>` for a running lifecycle) runs it explicitly. A start also blocks while something an earlier attempt left running cannot be verified stopped. DevFn never reverts what a task did. See the configuration reference for the full rerun contract.

For automation, `devfn up --json` emits one lifecycle receipt object containing `state`, `instanceId`, `invocationId`, allocations, managed processes/services, and resolved URLs. Failures emit `{ "ok": false, "error": { "code": "DEVFN_*", "message": "..." } }` and exit nonzero. Treat fields not documented here as additive.

DevFn v0.1 uses transactional CLI-managed state rather than a daemon. Runtime logic is platform-aware; macOS and Linux are the validated first-release hosts, while Windows process ownership is implemented but requires platform CI before it is declared supported.
