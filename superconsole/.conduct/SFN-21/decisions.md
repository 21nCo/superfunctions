# Architecture decisions

## ADR-001 — One modular control plane

**Decision:** Build one Super Console shell rather than independent dashboards.

**Reason:** Authentication, tenancy, policy, audit, navigation, accessibility, deployment, and cross-function investigations are shared concerns. Function-owned manifests preserve modularity.

## ADR-002 — Explicit registration

**Decision:** Modules are enabled only through server-side deployment configuration.

**Reason:** Credential presence and package installation are unsafe implicit activation signals. One explicit registry can mechanically remove disabled UI/API/MCP exposure.

## ADR-003 — Function-owned admin services

**Decision:** Each function owns its transport-neutral admin package and injected domain-service contract.

**Reason:** The console must not become a second implementation of billing, auth, workflows, storage, search, or other domain logic.

## ADR-004 — Shared kernel and projection

**Decision:** REST/OpenAPI, TypeScript, MCP, and SvelteKit delegate to the same registry dispatcher.

**Reason:** Separate handlers would drift in authorization, validation, errors, idempotency, and audit.

## ADR-005 — SvelteKit, Tailwind, and UIFn

**Decision:** Use SvelteKit and Tailwind configured through UIFn, with UIFn as the exclusive visual system.

**Reason:** This matches the selected stack and strengthens the ecosystem's own Svelte UI layer. UIFn problems are product problems and are fixed at source.

## ADR-006 — Operator/customer separation

**Decision:** Do not merge customer-facing portals or widgets into Super Console.

**Reason:** Their actors, information architecture, security boundaries, and tasks differ even when they share domain contracts and UIFn primitives.

## ADR-007 — Universal tenancy

**Decision:** Use organization → workspace → project → environment, with optional function namespace and region execution attributes.

**Reason:** A common hierarchy enables consistent navigation and policy while preserving DataFn/SearchFn/AuthFn regional and namespaced isolation.

## ADR-008 — Nested ownership

**Decision:** CatchFn and LogFn live under WatchFn; ContentFn lives under CmsFn.

**Reason:** Their operator jobs and existing repository boundaries place investigation in observability and content data in the authoring studio, avoiding redundant top-level products.

## ADR-009 — McpFn for administration MCP

**Decision:** Project eligible registry operations through McpFn, including authorized mutations.

**Reason:** McpFn supplies protocol contracts and testability; sharing dispatcher semantics prevents agent-specific authorization or audit gaps.

## ADR-010 — Merge committed dev, observe dirty dev

**Decision:** Merge fetched `origin/dev` into local `next`, then treat the uncommitted local `dev` diff as read-only forward-compatibility input.

**Reason:** The committed branch contains newer BillFn/ApiFn/AuthFn/DataFn/FileFn/SearchFn work required by the user. Dirty work is user-owned, incomplete, and cannot be silently moved or committed.

## ADR-011 — Self-hosted only

**Decision:** No hosted control-plane dependency.

**Reason:** The stated product boundary is a self-hosted stack. Deployment adapters and durable stores remain configurable.

## ADR-012 — Initial SDK scope

**Decision:** Ship TypeScript plus language-neutral REST/OpenAPI; defer Python administration SDK generation.

**Reason:** It satisfies current consumption needs while keeping other languages unblocked by a stable wire contract.
