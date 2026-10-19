---
title: Ports and localhost routes
description: Allocate per-worktree ports and publish concrete local URLs.
---

`@devfn/ports` uses machine-local locking and worktree identity to allocate and reconcile exact, preferred, ranged, ephemeral, and contiguous-block ports. `exact: true` fails closed on collision. Public port exposure needs an explicit manifest choice and `--allow-public` on each start. Inspect allocations with `devfn ports` and the full machine registry with `devfn ports report`.

`@devfn/proxy` manages one lock-protected Caddy route registry with concrete hostnames and loopback targets. It validates generated configuration before reload, returns 404 for unknown hosts, and refuses to take over an unrelated Caddy admin endpoint. Caddy listens on loopback only: ports 8080 and 8443 on macOS, which appear in published URLs, and 80 and 443 on Linux, which need `net.ipv4.ip_unprivileged_port_start` at or below 80 or `cap_net_bind_service` on the Caddy binary. A service already leasing a listener port must move to another port before a proxy route is activated.

Hostname templates accept `{project}` and `{instance}` and resolve to `.localhost` by default. Other development domains need explicit machine registration with `devfn domains register dev.example.test --tls internal`; the domain must already resolve only to loopback, and DevFn never edits DNS, hosts files, or trust stores. A registered route gets `<host>-<worktree>-<suffix>.<domain>` per worktree, plus `<host>.<domain>` for the primary worktree, and can match a path prefix or exact path, optionally stripping the prefix. Internal TLS uses Caddy's local CA, which clients must trust explicitly; certificate TLS uses PEM files whose DNS subject alternative names cover every generated hostname.

DevFn returns HTTP URLs only for explicit hostname routes or ports named by HTTP health checks. A database or arbitrary TCP listener remains a transport allocation rather than an invented HTTP URL. The [configuration reference](/docs/reference/configuration) covers port and hostname fields, while [ports](/docs/reference/ports) and [proxy](/docs/reference/proxy) document package behavior.
