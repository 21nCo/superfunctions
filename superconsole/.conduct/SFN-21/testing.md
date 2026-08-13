# Testing strategy

## Test layers

### Kernel unit tests

- manifest schema and semantic validation;
- duplicate IDs, routes, OpenAPI operation IDs, and MCP tool names;
- dependency resolution, nested ownership, missing dependency, and cycle detection;
- enabled registry projection;
- scope and permission evaluation;
- schema validation and normalized errors;
- cursor encoding/scope binding plus provider-supplied integrity where hostile clients can submit cursors;
- idempotency replay and collision;
- stable-ID audit reconciliation across repeated post-write failures;
- schema-bound one-time-secret redaction and outcome recording;
- OpenAPI and McpFn projection.

### Function contract tests

Every function admin package proves that:

- its manifest satisfies shared validation;
- declared resources and operations are a truthful subset of real public domain behavior;
- exact handlers delegate through the owning function's service rather than a caller-supplied generic executor;
- actor, scope, namespace/region, request identity, and idempotency reach the real domain boundary;
- operation-specific schemas reject unsupported fields before domain execution;
- each required/optional function binds a real function-owned or mandatory injected operator boundary and exposes no unsupported operations;
- destructive/sensitive operations carry the required metadata;
- nested modules declare the correct parent;
- representative integration tests exercise public domain services/adapters and cross-scope denial.

### Cross-surface contract tests

- registry, REST route, OpenAPI operation, SDK method, and MCP tool parity;
- identical schema acceptance/rejection;
- identical policy outcome;
- identical normalized error code;
- identical request and audit identity;
- disabled-module absence on all surfaces.
- exact 20 required / 6 optional / 2 nested / 1 folded catalog coverage;
- all function clients preserve availability, invoke, pages, raw response, and exact operation maps;
- machine-reviewed credential lifecycle and external-side-effect confirmation assurance.

### Integration tests

- interactive and service authentication;
- workspace/project/environment isolation;
- namespace and region forwarding;
- representative reads and mutations for every module;
- safe, sensitive, destructive, confirmed, and idempotent operations;
- audit query and correlation;
- global search limited to enabled modules and permitted resources;
- startup failure for invalid deployment registration;
- dependency unavailable and partial-health behavior.

### CiFn parity

- run list and pagination;
- run/job/step detail;
- logs;
- artifacts;
- retry and cancel when the service supports them;
- authentication and error behavior.

### UI and accessibility

- keyboard navigation and focus order;
- labels, descriptions, headings, landmarks, error summaries, and status announcements;
- contrast and non-color status communication;
- reduced motion;
- narrow and wide responsive layouts;
- loading, empty, partial-data, error, unauthenticated, forbidden, and not-found states;
- confirmation and audit receipt flows;
- UIFn-only dependency/import enforcement.

### Security

- cross-workspace/project/environment resource substitution;
- namespace/region bypass for DataFn, SearchFn, AuthFn, and FileFn;
- forged provider cursor, idempotency, confirmation, and version tokens;
- service credential confused-deputy cases;
- CSRF for cookie mutations;
- MCP discovery and mutation authorization;
- secret redaction in response, error, audit, logs, and traces;
- concurrency for delete, revoke, reconcile, retry, and rollback.

## Load discipline

During development, package-focused tests run in parallel while only one bounded integrated build runs at a time. Full-monorepo gates are reserved for final convergence so local CPU and memory are not saturated by redundant Turbo/Vite/Svelte builds.

## Completion evidence

Commands, timestamps, exit results, test counts, and material environment caveats are recorded in [verification.md](verification.md). A source review or local unit test does not claim deployment, live provider, external DNS, registry publication, or browser/device proof.
