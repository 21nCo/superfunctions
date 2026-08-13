# Function administration module contract

## Ownership

A function's `admin` package is the source of truth for operator capability. It exports a manifest and a factory that binds an injected domain administration service. Super Console does not discover methods by reflection and does not directly access a function's database.

Pre-existing function-specific admin HTTP routers are compatibility surfaces, not alternate Super Console dispatch paths. In particular, AuthFn's low-level `createAuthFnAdmin` router predates the shared confirmation/idempotency/audit contract and is deprecated for new operator control planes; Super Console uses `createAuthFnAdminAdapter`.

## Manifest identity

Every manifest has:

- stable lowercase module ID;
- human title and description;
- semantic capability version;
- required or optional classification;
- standalone or nested presentation mode;
- dependency module IDs;
- owning parent for nested modules;
- supported scope levels;
- health metadata;
- resource and operation declarations.

Module IDs are stable API identities, not npm package names. Operation IDs are globally unique after namespacing as `<module>.<resource>.<action>`.

## Resource declaration

A resource declares:

- ID, singular/plural labels, description, icon key, and risk classification;
- canonical ID field and safe display fields;
- list/get operation IDs;
- searchable/filterable/sortable fields;
- related-resource references;
- default scope and required permission;
- whether sensitive fields may be exposed and their redaction policy;
- navigation or nested placement.

Resources describe administration state, not generic screen layout.

## Operation declaration

An operation declares:

- stable operation ID and summary;
- HTTP method and registry-relative path;
- input and output JSON schemas;
- required permission;
- safety classification: `read`, `write`, or `destructive`;
- confirmation requirements;
- idempotency and audit requirements;
- an exact resource target and ID input for object actions, or an explicit collection target for collection actions;
- declared input/output redaction fields;
- optional cursor-pagination metadata;
- MCP exposure eligibility;
- the injected service handler.

No mutation may omit permission and audit declarations. Destructive actions must be explicit and cannot be inferred from the HTTP method alone.

Every available action owns an operation-specific input/output schema and an
exact domain handler. Object actions declare their identifier field;
collection actions declare collection ownership. The UI, OpenAPI, TypeScript
client, and MCP all project the same manifest and therefore cannot invent
fields that the domain service does not support.

A caller-supplied `execute({ operationId, input: unknown })` facade is not an
available admin implementation. If a function lacks a canonical operator
service/store, its manifest uses `availability: "unavailable"`, declares a
reason, and exposes zero resources, navigation entries, and operations. The
registry refuses to enable it.

When a function's domain is intentionally owned by another product module,
the child uses `availability: "folded"`, declares its owner, and exposes no
parallel operations. ContentFn follows this rule because CmsFn already binds
the real ContentFn server. CatchFn and LogFn remain true nested modules under
WatchFn because they own distinct domain operations.

## Invocation context

The kernel supplies a frozen context containing:

- authenticated actor ID, actor type, and authentication method;
- installation, workspace, project, and environment IDs (`organizationId` remains a deprecated installation-root alias);
- effective function namespace and optional region;
- actor roles, permissions, and policy metadata;
- request and correlation IDs;
- source surface: console, REST, SDK, or MCP;
- idempotency key where applicable;
- confirmation token where applicable;
- abort signal.

Handlers may narrow scope but may not expand it. They forward context to the domain service, which remains responsible for object-level authorization and namespace isolation.

## Handler result

Successful handlers return typed data plus optional resource references, warnings, pagination, and safe metadata. They do not construct HTTP responses. The dispatcher attaches request and audit identities.

Domain errors are mapped to canonical admin codes while preserving safe details:

- `invalid_argument`;
- `unauthenticated`;
- `forbidden`;
- `not_found`;
- `conflict`;
- `rate_limited`;
- `precondition_failed`;
- `dependency_unavailable`;
- `internal`.

## Audit

Every mutation requires audit infrastructure before domain execution. The dispatcher first durably appends a sanitized `attempted` event; only then may it invoke the function-owned service. After invocation it appends a terminal `succeeded` or `failed` event and returns that terminal audit identity. This is an append-ordering guarantee, not a claim of a distributed transaction between an arbitrary function store and the audit store.

Audit events carry:

- unique audit ID and timestamp;
- actor and canonical tenant scope;
- module, operation, action, and target references;
- source surface;
- request, correlation, and idempotency IDs;
- policy decision;
- sanitized input summary;
- phase/outcome, normalized error code, and duration when terminal;
- function observation references when supplied.

The manifest provides explicit input/output redaction hints. The kernel applies global secret-key detection to audit values as defense in depth and applies declared output redaction before response or idempotency storage.

## Nested ownership

Nested modules register full resources and operations but contribute navigation below their parent. They cannot appear as top-level modules.

- `catchfn` → `watchfn`;
- `logfn` → `watchfn`;
- `contentfn` → `cmsfn`.

Disabling a nested module removes its resources, routes, OpenAPI operations, and MCP tools while leaving the parent active.

## Compatibility

Capability versions follow semantic versioning independently of UI releases. Additive resource fields and operations are minor changes. Removed/renamed operations, scope changes, tightened schemas, or different mutation safety are major changes. A future deprecation contract must reach registry discovery, OpenAPI, the TypeScript client, MCP descriptions, and the UI together; v1 does not yet define deprecation fields.
