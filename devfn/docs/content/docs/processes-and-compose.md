---
title: Processes and Compose
description: Run native applications and worktree-scoped infrastructure.
---

Native process adapters include `command`, `npm`, `pnpm`, `turbo`, `wrangler`, `xcode`, and `extfn`. Commands run locally under supervision with declared working directory, dependency order, environment, ports, readiness, and shutdown timeout. Turbo, Wrangler, and ExtFn resolve project-local binaries without downloading missing tools; pnpm follows the repository's Corepack pin. Yarn and Bun discovery is proposed and does not create guessed processes.

Compose services use Docker Compose 2.24.4 or newer. DevFn names the Compose project with a digest of the project prefix and the worktree owner, generates host-port overrides with loopback mapping by default, starts only the requested service with `--no-deps`, and preserves persistent volumes during ordinary cleanup. Services with `secretEnv` disable Docker log persistence and cannot use log-pattern readiness. Sibling Compose services on a shared network receive container-context `DEVFN_URL_*` values such as `http://web:8080`, while native processes receive loopback URLs. Ready receipts fingerprint the effective Compose service and its referenced definitions, so an edited Compose source degrades status and the next start restarts the owned service.

Readiness checks may use HTTP, TCP, command, or log patterns. Local-process exposure verification needs `lsof` on macOS/Linux or `netstat` on Windows. Run `doctor` to surface missing prerequisites. See [processes](/docs/reference/processes), [Compose](/docs/reference/compose), and [configuration](/docs/reference/configuration) for exact settings.
