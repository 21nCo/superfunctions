# DEV-1 implementation decisions

- Source line: Superfunctions `next`, isolated detached worktree until the hosted workflow's publication approval gate.
- Runtime: TypeScript on Node 22, independently published npm packages.
- Process ownership: browser-neutral `@devfn/processes`, available for later ProbeFn adoption without ProbeFn coupling.
- Shared state: transactional CLI-managed locks and atomic files for v0.1; no background daemon.
- Command: `devfn` only; no automatic generic `dev` alias.
- Platform: macOS and Linux validated first. Windows-aware paths are implemented but not declared supported without Windows CI.
- Proxy: one shared Caddy instance with explicit `.localhost` routes and no catch-all.
- Safety: digest-bound manifest trust, allowlisted child environments, loopback defaults, non-destructive Compose shutdown, PID-birth checks, and stable machine errors.
