# Self-hosting and operations

## Deployment model

Super Console is a SvelteKit server application deployed alongside network-reachable Superfunction services. An installation may run in one process for development or bind remote service clients, but module registration remains explicit and server-only.

The stable composition entry is `superconsole/server`. A deployment compiles a module exporting `superConsole`, `default`, or `createSuperConsoleInstallation`, then sets `SUPERCONSOLE_INSTALLATION` to its absolute path or `file://` URL. See the runnable-shape example in the package [README](../../README.md).

## Required configuration

- network origin, TLS, and trusted proxy settings at the SvelteKit/Node deployment layer;
- AuthFn runtime config and an operator resolver/scope authorizer;
- audit and idempotency stores;
- installation/workspace/project/environment resolver (`organizationId` is a compatibility installation alias);
- explicit enabled module list and each module's service adapter;
- an explicit shell-surface policy and optional per-operation policy evaluator;
- a bound confirmation issuer/verifier when any selected action is destructive;
- WatchFn-backed audit query, SearchFn-backed global search, and function-owned settings/overview services for those optional shell surfaces;
- SecFn-backed secret references and function-specific service credentials where configured;
- retention, rate limit, payload, pagination, and timeout limits.

Secrets must be provided through the deployment secret mechanism or SecFn references. They are not placed in a client-visible module manifest.

## Startup

On startup the server:

1. loads configuration;
2. binds service adapters;
3. validates manifests, dependencies, nested ownership, paths, tools, schemas, and safety metadata;
4. verifies required audit, atomic idempotency, AuthFn mutation authorization, and confirmation capabilities for the selected operations;
5. initializes AuthFn, policy, REST/OpenAPI, and McpFn composition;
6. serves only after the installation module is loaded and the registry is valid.

Invalid configuration fails closed. API requests receive a sanitized 503 until configuration is corrected; the process startup error remains available to the self-hoster's server logging.

## Health

- the current application fails closed at boot and exposes module health metadata to authorized registry/module views;
- module health appears only to authorized operators;
- optional module degradation does not make the whole installation unready unless configured as required;
- health never exposes credentials, tenant data, or internal network addresses to anonymous callers.

Dedicated anonymous liveness/readiness routes are deployment-adapter responsibilities in v1; Super Console does not claim endpoints it does not implement.

## Persistence and backup

Back up:

- AuthFn identity and membership state;
- console policy/configuration state not stored as code;
- durable audit events;
- idempotency records for their retention window;
- function-owned databases and object storage according to each function's runbook;
- encryption keys through the deployment's secure key backup procedure.

Test restores in an isolated environment. Audit ordering and tenant identifiers must survive restore. A backup without object storage or encryption keys is not a complete FileFn/MailFn/RecFn recovery.

## Upgrade

1. review transport and function capability versions;
2. validate the new registry against configuration before traffic switch;
3. run schema/provisioning plans supplied by owning functions;
4. deploy with backward-compatible REST/OpenAPI where possible;
5. verify authentication, tenant selection, audit, enabled module discovery, and representative reads;
6. switch traffic;
7. retain rollback artifacts and compatible data backups.

Removing a module intentionally removes its UI/API/MCP exposure but does not delete domain data. Destructive decommissioning is a separate explicit operation.

## Scaling

Multi-process deployments require shared durable audit and idempotency stores. Sticky sessions must not substitute for durable correctness. Streaming logs, traces, or run updates use bounded connections and backpressure. Operation timeouts and pagination limits are configurable within safe server maxima.

## Incident response

- correlate reports by request and audit ID;
- inspect WatchFn metrics/traces/errors, LogFn logs, and CatchFn feedback inside the WatchFn module;
- revoke compromised AuthFn sessions/service credentials;
- rotate secrets through SecFn/owning provider service;
- disable a module in deployment configuration when containment requires it;
- preserve audit and relevant artifacts before destructive remediation;
- record correction actions as new audit events.

## Development mode

A local development configuration may use in-memory services and stores only when clearly marked and bound to loopback. It must still use the real registry, dispatcher, policy, schemas, REST/OpenAPI, SDK, MCP projection, and UIFn shell; it is not a separate mocked product architecture.
