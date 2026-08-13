# Product rationale

## Thesis

Superfunctions should compose as one platform without collapsing into one runtime. Super Console supplies a consistent operator surface while functions retain domain ownership. It serves human operators through SvelteKit, application developers through REST/OpenAPI and a TypeScript client, and agents through McpFn.

## Problem

Before SFN-21, operator support was uneven:

- CiFn had an isolated React dashboard for runs, job logs, and artifacts.
- CmsFn had a Studio package centered on content authoring.
- WatchFn had a dashboard package with hard-coded prototype data.
- AuthFn exposed only a small set of framework-neutral admin routes.
- most functions had SDKs, CLIs, specifications, or planned dashboards but no coherent administration plane.

Building a separate dashboard for every function would duplicate authentication, tenant selection, authorization, audit, layout, accessibility, API semantics, deployment, and maintenance. It would also make cross-function investigation unnecessarily fragmented.

## Users and jobs

### Installation owner

- register exactly the functions deployed in the installation;
- configure workspaces, projects, environments, identity, access, providers, secrets, domains, quotas, retention, and integrations;
- inspect health, usage, cost, incidents, and audit history;
- upgrade or disable a function without leaving a stale UI, API path, schema, or MCP tool.

### Operator and support engineer

- find permitted resources across enabled modules;
- correlate runs, workflows, messages, deliveries, logs, traces, recordings, files, deployments, and incidents;
- execute safe retries, cancellations, rotations, purges, replays, rollbacks, and repairs;
- receive a stable terminal audit receipt for each completed mutation attempt, while rejected preconditions return normalized errors and required mutations still record sanitized intent before domain invocation.

### Developer and automation author

- consume stable administration operations without scraping a console;
- use identical pagination, validation, errors, authorization, and idempotency through REST, TypeScript, and MCP;
- discover installation capabilities at runtime.

### Auditor

- inspect grants, policy decisions, mutations, evidence, findings, exceptions, configuration history, retention, and security events in a stable tenant scope.

## Product principles

1. **Selected means exposed.** Only registered modules exist on any surface.
2. **The function owns the domain.** The shell composes; it does not redefine business logic.
3. **One dispatch path.** UI, REST, SDK, and MCP share policy, validation, execution, and audit.
4. **Self-hosted first.** No Superfunctions-hosted control plane is required.
5. **Human and agent parity.** Safe console operations have API and MCP equivalents.
6. **UIFn or improve UIFn.** Visual-system gaps are fixed at their source.
7. **Use Superfunctions to operate Superfunctions.** Identity, MCP, observability, security, data, files, and other concerns use their owning packages.
8. **Operator UI is not customer UI.** Customer portals and widgets remain separate products.
9. **Safe mutations are a contract.** Scope, permission, confirmation, validation, idempotency, and audit are declared rather than page-specific behavior.
10. **Complexity follows deployment.** A small installation sees a small console.

## Success conditions

- adding a function does not require new shell routing logic;
- disabling a function removes all five projections: UI, dispatch, REST/OpenAPI, SDK discovery, and MCP;
- every required and optional module is selectable and exposes its declared inventory through injected service adapters; representative live work depends on the self-hoster binding real domain services, and final per-action payload schemas remain function-owned follow-up where the inventory is still generic;
- console, REST, SDK, and MCP return the same result and audit identity;
- tenancy isolation and permission tests cover every dispatcher entry;
- CiFn workflows remain usable after migration;
- UIFn is the only operator visual system;
- installation, backup, upgrade, and troubleshooting are documented for self-hosters.

## Boundaries

SFN-21 does not build a hosted SaaS, a Python admin SDK, or standalone admin products for component/rendering libraries. It does not merge customer billing portals, auth widgets, feedback widgets, or file pickers into operator administration. Stable non-admin SDKs remain compatible.
