# Metadata

- Timestamp (UTC): 2026-03-27T04:14:48Z
- agent_name: unknown-agent
- model: unknown
- launcher: Codex Desktop
- workspace: repo root
- OS + shell: Darwin arm64, zsh
- git branch: detached
- git commit: 5092916
- git dirty status: dirty
- spec_folder: 2026-03-27-audit-fix-x4p8m2q7-spec
- spec path: plugfn/.conduct/specs/2026-03-27-audit-fix-x4p8m2q7-spec
- spec_type: audit-fix
- spec_id: x4p8m2q7
- input paths:
  - .conduct/audits/2026-03-26-pvk2m8q1-full-audit.md
  - plugfn/README.md
  - plugfn/SPEC.md
  - plugfn/typescript/README.md
  - plugfn/python/README.md
  - plugfn/python/SUMMARY.md
  - plugfn/.conduct/STATUS.md
  - plugfn/docs/architecture.md
  - plugfn/docs/architecture/hardening-baseline.md
  - plugfn/docs/architecture/provider-policy-matrix.md
  - plugfn/docs/getting-started.md
  - plugfn/docs/operations/release-gates.md
  - plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/INTENT_AUDIT.md
  - plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/PLAN.md
  - plugfn/typescript/package.json
  - plugfn/cli/package.json
  - plugfn/typescript/src/core/connection-manager.ts
  - plugfn/typescript/src/auth/oauth-flow.ts
  - plugfn/typescript/src/router/http-router.ts
  - plugfn/typescript/src/core/workflow-engine.ts
  - plugfn/python/plugfn/providers/__init__.py
  - plugfn/python/plugfn/providers/github.py
  - external skill instructions: spec SKILL.md
- audit reference: .conduct/audits/2026-03-26-pvk2m8q1-full-audit.md

# Overview

PlugFn MUST be re-baselined as the reusable, server-first integration runtime for Superfunctions apps, with a truthful package surface, hardened shared OAuth/webhook/auth behavior, deterministic workflow lifecycle semantics, Python parity for the core provider set, and a reproducible repo-root release gate before any production-ready claim is allowed.

Context summary:

- Project name: PlugFn
- One-sentence goal: make PlugFn safe and truthful enough to be the default integration runtime across repository apps such as nucleus.
- Target users: platform maintainers, app teams, provider implementers, and Python/TypeScript backend teams.
- Target environments: Node.js TypeScript servers, Python servers, framework adapters via `@superfunctions/http` / FastAPI / Flask, and an optional browser helper with no privileged operations.
- Languages/packages required: `plugfn` (TypeScript runtime), `@plugfn/cli`, `plugfn` (Python), `@superfunctions/db`, `@superfunctions/http`, `@superfunctions/oauth-core`, `@superfunctions/oauth-flow`, `@superfunctions/oauth-http`, `@superfunctions/oauth-storage`, `@superfunctions/oauth-providers`.
- Existing systems it must integrate with: downstream apps in this monorepo, `authfn`, shared OAuth packages, shared DB packages, and documented provider surfaces such as GitHub, Linear, ClickUp, and Gmail.
- Data model summary: provider registry, integration config, connection, OAuth state, OAuth token, webhook route binding, workflow, workflow execution, release-gate evidence, and provider parity matrix.
- Security model: multi-tenant, auth-derived principal identity, encrypted token storage, fail-closed webhook verification, no client-side credential exchange, no trust in caller-supplied `userId`/`tenantId`.
- Performance constraints: deterministic connection selection, multi-instance-safe workflow lifecycle, raw-body-preserving webhook verification, and repo-root verification that does not depend on machine-specific paths or ad hoc sibling prebuilds.
- Non-goals: dashboard UI, visual workflow builder, marketplace, 75+ provider completion, and browser-side token exchange.
- Hard constraints: no synthetic connection-record OAuth storage, no contradictory package names, no machine-specific absolute paths in release artifacts, no production-ready claim without a green release gate.

# Glossary

- Core runtime: the reusable PlugFn integration surface that downstream apps MAY treat as shared infrastructure.
- Vertical module: Finatron, Fellotron, or mail-specific logic that MAY remain in the repository but MUST NOT silently expand the core production-ready claim.
- Core provider set: the minimum provider matrix that this spec treats as production-relevant: GitHub, Linear, ClickUp, and Gmail.
- Provider readiness matrix: the published inventory of provider IDs, language parity, and support status values (`production`, `beta`, `experimental`, `vertical-only`, `unsupported`).
- Shared OAuth family: `@superfunctions/oauth-core`, `@superfunctions/oauth-flow`, `@superfunctions/oauth-http`, `@superfunctions/oauth-storage`, and `@superfunctions/oauth-providers`.
- First-class OAuth storage: durable OAuth state/token persistence through explicit stores or tables, not through synthetic connection records.
- Raw webhook body: the exact inbound bytes received from the HTTP transport before JSON parsing or reserialization.
- Derived principal: the authenticated tenant/user identity supplied by configured auth integration, not by request body, query string, or an unverified bearer token literal.
- Thin browser helper: an optional browser package limited to initiating server-backed connect flows and reading backend-issued provider metadata; it MUST NOT exchange tokens, verify signatures, or hold provider credentials.
- Release gate: the reproducible repo-root verification command that blocks any production-ready claim when build, typecheck, tests, docs inventory, or end-to-end coverage fail.

# Goals / Non-goals

## Goals

- PlugFn MUST present one coherent product contract as the generic shared integration runtime.
- PlugFn MUST align docs, package manifests, imports, and status artifacts on the actual publishable package names.
- PlugFn MUST persist OAuth state and tokens through first-class shared-package storage contracts anchored to `@superfunctions/db`.
- PlugFn MUST reduce `plugfn/typescript/src/auth/oauth-flow.ts` to a compatibility wrapper only.
- PlugFn MUST expose OAuth, webhook, and management routes through shared HTTP abstractions with deterministic success/error envelopes.
- PlugFn MUST derive auth context from configured auth providers in TypeScript and Python adapters.
- PlugFn MUST verify signed webhooks against raw body bytes and fail closed when verification is required.
- PlugFn MUST make workflow disable/delete and delayed/idempotent execution safe in multi-instance deployments.
- PlugFn MUST provide Python parity for the core provider set and MUST truthfully document anything outside that parity matrix.
- PlugFn MUST ship a repo-root release gate covering TypeScript runtime, CLI, Python, docs inventory, and at least one end-to-end OAuth + webhook path.

## Non-goals

- This spec does NOT require a dashboard UI, workflow builder, or marketplace.
- This spec does NOT require 75+ providers or a general “all Google APIs” surface.
- This spec does NOT require direct browser-side token exchange or browser-side webhook handling.
- This spec does NOT require vertical mail/Finatron/Fellotron features to become part of the core production-ready claim.

# Public API

## Canonical package contract

- TypeScript runtime package MUST publish as `plugfn`.
- CLI package MUST publish as `@plugfn/cli`.
- Python package MUST publish as `plugfn`.
- Public docs MUST NOT instruct consumers to install `@superfunctions/plugfn` or `@superfunctions/plugfn-cli`.

## TypeScript runtime contract

```ts
import type { Adapter } from "@superfunctions/db";
import type { Router } from "@superfunctions/http";

export interface PlugFnPrincipal {
  tenantId?: string;
  userId: string;
  roles?: string[];
  metadata?: Record<string, unknown>;
}

export interface PlugFnAuthProvider {
  authenticate(request: Request): Promise<PlugFnPrincipal | null> | PlugFnPrincipal | null;
}

export interface PlugFnIntegrationConfig {
  type?: "oauth2" | "apiKey" | "basic" | "jwt";
  clientId?: string;
  clientSecret?: string;
  redirectUris?: string[];
  scopes?: string[];
  apiKey?: string;
  webhookSecret?: string;
  [key: string]: unknown;
}

export interface PlugFnConfig {
  database: Adapter;
  auth: PlugFnAuthProvider;
  baseUrl: string;
  encryptionKey: string;
  integrations: Record<string, PlugFnIntegrationConfig>;
  providerMatrix?: PlugFnProviderStatusRegistry;
}

export interface PlugFnProviderStatusRecord {
  providerId: string;
  status: "production" | "beta" | "experimental" | "vertical-only" | "unsupported";
  typescriptReady: boolean;
  pythonReady: boolean;
  notes?: string;
}

export interface PlugFnProviderStatusRegistry {
  coreRuntime: string;
  records: PlugFnProviderStatusRecord[];
}

export interface PlugFnConnectionsApi {
  getAuthUrl(input: {
    userId: string;
    provider: string;
    redirectUri: string;
    scopes?: string[];
    connectionName?: string;
  }): Promise<string>;
  handleCallback(input: {
    code: string;
    state: string;
    provider?: string;
    redirectUri?: string;
    connectionName?: string;
  }): Promise<Connection>;
  list(input: {
    userId: string;
    provider?: string;
    status?: string;
  }): Promise<Connection[]>;
  disconnect(input: {
    userId: string;
    provider: string;
    connectionId?: string;
  }): Promise<void>;
}

export interface PlugFnWebhooksApi {
  handle(
    provider: string,
    event: string,
    payload: unknown,
    headers: Record<string, string>,
    secret?: string
  ): Promise<unknown>;
}

export interface PlugFn {
  readonly router: Router;
  readonly config: PlugFnConfig;
  readonly connections: PlugFnConnectionsApi;
  readonly webhooks: PlugFnWebhooksApi;
  readonly workflows: unknown;
  readonly providers: unknown;
}

export declare function plugFn(config: PlugFnConfig): PlugFn;
```

## HTTP router contract

```ts
import type { Router } from "@superfunctions/http";

export interface PlugFnRouterOptions {
  authResolver?: PlugFnAuthProvider["authenticate"];
  webhookSecretResolver?:
    | Record<string, string>
    | ((
        provider: string,
        request: Request,
        headers: Record<string, string>
      ) => Promise<string | undefined> | string | undefined);
  maxWebhookPayloadBytes?: number;
}

export declare function createPlugFnRouter(
  plugFn: PlugFn,
  options?: PlugFnRouterOptions
): Router;
```

Router behavior:

- If `options.authResolver` is undefined, the router MUST default to `plugFn.config.auth.authenticate`.
- Webhook routes MUST receive raw request bytes before verification.
- Non-webhook routes MUST reject missing auth with `PLUGFN_AUTH_REQUIRED`.

## Python contract

```python
class PlugFn:
    def __init__(
        self,
        *,
        database,
        auth,
        base_url: str,
        encryption_key: str,
        integrations: dict[str, dict[str, object]],
        provider_matrix: dict[str, object] | None = None,
    ) -> None: ...

def mount_fastapi(app, plug: PlugFn, prefix: str = "/api/plugfn") -> None: ...
def mount_flask(app, plug: PlugFn, prefix: str = "/api/plugfn") -> None: ...
```

Python adapters MUST expose the same canonical route inventory and envelopes as the TypeScript runtime.

## CLI contract

```bash
plugfn test \
  --provider <provider-id> \
  --user-id <user-id> \
  --action <action-id> \
  [--connection-id <connection-id>] \
  [--params-file <path>] \
  [--webhook-fixture <path>] \
  [--json]
```

CLI exit behavior:

- exit `0`: all requested checks passed
- exit `1`: command or validation failure before provider execution
- exit `2`: connection/provider health failure
- exit `3`: webhook verification or callback simulation failure

## Optional browser helper boundary

This spec does not require shipping a browser package. If one is shipped under this spec, it MUST be limited to:

```ts
export interface PlugFnClient {
  getProviderCatalog(): Promise<PlugFnProviderStatusRecord[]>;
  startConnection(input: {
    provider: string;
    redirectUri: string;
    scopes?: string[];
  }): Promise<{ authorizationUrl: string }>;
}
```

The browser helper MUST NOT expose token exchange, refresh, disconnect, webhook verification, or direct action execution using provider credentials.

# Data formats / protocol

## Canonical HTTP success envelope

```json
{
  "ok": true,
  "requestId": "req_01",
  "data": {}
}
```

## Canonical HTTP error envelope

```json
{
  "ok": false,
  "requestId": "req_01",
  "error": {
    "code": "PLUGFN_AUTH_REQUIRED",
    "message": "authentication required",
    "status": 401,
    "retryable": false,
    "details": {}
  }
}
```

## Canonical provider status record

```json
{
  "providerId": "github",
  "status": "production",
  "typescriptReady": true,
  "pythonReady": true,
  "notes": "core provider set"
}
```

## Canonical Python parity record

```json
{
  "providerId": "linear",
  "typescript": {
    "status": "production"
  },
  "python": {
    "status": "production",
    "actions": ["issues.get", "comments.create", "issues.search"],
    "triggers": ["issue.updated", "issue_comment.created"]
  }
}
```

## Canonical release-gate result

```json
{
  "ok": true,
  "gate": "plugfn-release",
  "typescript": {
    "build": "pass",
    "typecheck": "pass",
    "test": "pass"
  },
  "cli": {
    "build": "pass",
    "typecheck": "pass",
    "test": "pass"
  },
  "python": {
    "pytest": "pass"
  },
  "docs": {
    "inventory": "pass",
    "portablePaths": "pass"
  },
  "e2e": {
    "oauth": "pass",
    "webhook": "pass"
  }
}
```

## Canonical failure codes

- `PLUGFN_SCOPE_CONFLICT`: product contract or provider matrix contradicts the declared core runtime boundary.
- `PLUGFN_PACKAGE_CONTRACT_INVALID`: docs or manifests advertise unsupported package names or import paths.
- `PLUGFN_AUTH_REQUIRED`: non-webhook route called without derived principal.
- `TENANT_ACCESS_DENIED`: request body/query identity does not match derived principal scope.
- `OAUTH_STORAGE_BACKEND_REQUIRED`: shared OAuth path attempted without first-class store bindings.
- `OAUTH_LEGACY_SHIM_VIOLATION`: legacy shim still performs orchestration logic forbidden by this spec.
- `WEBHOOK_RAW_BODY_REQUIRED`: signature verification attempted without raw request bytes.
- `WEBHOOK_SIGNATURE_INVALID`: signature verification failed against provider raw-body contract.
- `WEBHOOK_SECRET_MISSING`: provider requires verification but no secret or resolver output is available.
- `WORKFLOW_TRIGGER_UNREGISTER_FAILED`: disable/delete could not detach an active trigger.
- `WORKFLOW_DURABILITY_UNSUPPORTED`: workflow behavior attempted that cannot survive restart or multi-instance operation.
- `CLI_PROVIDER_CHECK_FAILED`: CLI provider/action health check failed.
- `PYTHON_PARITY_INCOMPLETE`: Python matrix lacks a required core provider feature or docs overstate parity.
- `PROVIDER_STATUS_UNSUPPORTED`: consumer requested a provider marked unsupported for the requested language or mode.
- `CLIENT_SDK_SERVER_ONLY_OPERATION`: browser helper attempted a server-only operation.
- `RELEASE_GATE_FAILED`: repo-root gate did not reach a clean pass state.

# Semantics

## Product contract and scope

- PlugFn MUST describe itself as the general shared integration runtime.
- Finatron, Fellotron, and mail-specific modules MAY exist, but MUST be documented as optional vertical or experimental layers unless and until they independently meet the same release gate.
- The core production-ready claim MUST be bounded to the provider readiness matrix and MUST NOT imply unsupported providers or vertical features.

## Provider readiness matrix

- PlugFn MUST publish one source of truth for provider readiness.
- The matrix MUST include, at minimum, GitHub, Linear, ClickUp, and Gmail.
- Every provider record MUST declare TypeScript readiness, Python readiness, and support status.
- The strings `75+ providers`, `production ready`, or equivalent MUST NOT appear without a nearby matrix-qualified scope statement.

## Package surface

- Docs, READMEs, and examples MUST use `plugfn` and `@plugfn/cli`.
- Code examples MUST use repository-valid imports.
- Install instructions MUST remain stable across `plugfn/README.md`, `plugfn/typescript/README.md`, and `plugfn/docs/getting-started.md`.

## Shared DB + OAuth storage

- `PlugFnConfig.database` MUST bind to `@superfunctions/db`’s `Adapter` contract directly.
- OAuth state and token records MUST be stored through explicit storage objects or tables, not synthetic connection records or synthetic system users/providers.
- Connections MAY reference token records, but MUST NOT carry the shared OAuth state/token store themselves.

## Shared OAuth orchestration

- `ConnectionManager` MUST use the shared OAuth family as the canonical implementation.
- `plugfn/typescript/src/auth/oauth-flow.ts` MUST remain as a compatibility wrapper only for one minor release.
- The legacy path MUST emit `DEPRECATED_PATH`, name the shared replacement, and avoid owning token exchange, token refresh, state verification, or store instantiation logic.

## Route exposure

- The canonical route inventory is:
  - `GET /callback`
  - `POST /webhooks/:provider/:event`
  - `GET /providers`
  - `GET /connections`
  - `POST /connections/auth`
  - `POST /connections/disconnect`
  - `GET /workflows`
  - `GET /metrics`
- The route inventory MUST be available through TypeScript shared HTTP adapters and through Python FastAPI/Flask adapters.
- Canonical envelopes MUST be consistent across languages.

## Auth semantics

- Non-webhook routes MUST derive principal identity from configured auth integration.
- Caller-supplied `userId`, `tenantId`, or equivalent MAY appear in request bodies for auditability, but MUST be treated as claims to validate, never as the source of truth.
- A raw bearer token string MUST NOT be treated as the user ID.

## Webhook semantics

- Signed providers MUST verify against raw request body bytes.
- Parsed JSON MAY be used after successful verification, but MUST NOT be the input to the signature computation.
- When provider verification is configured or required, missing secrets or resolver failures MUST fail the request.

## Workflow semantics

- Disabling or deleting a workflow MUST unregister active triggers, timers, subscriptions, and handler bindings.
- Delayed or resumed executions MUST persist enough state to survive process restart and multi-instance execution.
- If a provider trigger cannot be unregistered automatically, the runtime MUST return `WORKFLOW_TRIGGER_UNREGISTER_FAILED` and MUST log the orphaned binding explicitly.

## CLI semantics

- `plugfn test` MUST execute against real configured provider/runtime wiring.
- The command MUST validate connection resolution, at least one provider action, and an OAuth or webhook diagnostic path when requested.
- Human-readable output MAY exist, but `--json` MUST emit deterministic machine-readable output with exit codes.

## Python parity semantics

- The Python package MUST be importable and test-green before any parity or production claim.
- Python MUST match the core provider matrix only; anything outside that subset MUST be marked beta, experimental, or unsupported.
- Python adapters MUST enforce the same auth and webhook rules as the TypeScript runtime.

## Client boundary semantics

- The core production-ready claim does not require a browser package.
- If a browser helper is shipped, it MUST call server routes only.
- Browser code MUST NOT hold provider credentials, refresh tokens, webhook secrets, or signature logic.

## Release-gate semantics

- A single repo-root release gate MUST be the authoritative production-readiness proof.
- The gate MUST cover:
  - TypeScript runtime build, typecheck, tests
  - CLI build, typecheck, tests
  - Python `pytest`
  - docs/status inventory and portable-path checks
  - at least one end-to-end OAuth path
  - at least one end-to-end webhook path
- `plugfn/.conduct/STATUS.md` MUST NOT claim production readiness unless the gate is green on the same commit.

# Invariants

- Connection selection MUST remain deterministic across identical inputs.
- Shared OAuth state/token persistence MUST NOT depend on connection-record hacks.
- Webhook signature verification MUST be byte-for-byte deterministic for the received body.
- Auth resolution MUST be derived from configured auth providers, not caller-controlled fields.
- Package names, install instructions, and import paths MUST be globally consistent across PlugFn docs.
- Provider readiness status MUST be explicit; unspecified providers are `undefined` and therefore not production-ready.
- Python parity claims MUST never exceed the tested provider matrix.
- Release-gate commands MUST be runnable from repo root without machine-specific absolute paths.
- Optional browser helpers MUST remain server-delegating and deterministic in visible outputs.

# Security

- Provider tokens, client secrets, webhook secrets, and refresh tokens MUST never be logged in plaintext.
- Raw webhook bodies MAY be hashed for diagnostics but MUST NOT be emitted verbatim in logs by default.
- Cross-tenant or cross-user access MUST return `TENANT_ACCESS_DENIED`.
- OAuth state MUST be single-use and expire deterministically.
- Token storage MUST remain encrypted at rest.
- Python and TypeScript adapters MUST apply the same fail-closed auth and webhook posture.
- Release-gate output MUST be safe to store as evidence and MUST NOT include local absolute paths or secret values.

# Limits/caps

- Default maximum webhook payload size MUST remain 2 MiB unless a provider-specific lower bound is documented.
- The provider readiness matrix MUST list at least the core provider set and MAY list additional providers.
- Only one minor release of legacy compatibility is allowed for `plugfn/auth/oauth-flow` after the thin-shim migration.
- Browser helper scope is capped to connect-initiation and provider catalog reads only.

# Observability

- PlugFn MUST emit structured events for:
  - OAuth connect success/failure
  - webhook verification success/failure
  - workflow trigger register/unregister success/failure
  - CLI diagnostics pass/fail
  - release-gate pass/fail
- Every emitted event MUST include provider ID when relevant and MUST redact secrets/tokens.
- Status docs and release-gate artifacts MUST be aligned with real verification outputs.

# Compatibility / versioning strategy

- `plugfn/auth/oauth-flow` MUST stay as a deprecation shim for one minor release only.
- Package-name corrections from `@superfunctions/plugfn` to `plugfn` and from `@superfunctions/plugfn-cli` to `@plugfn/cli` MUST be documented as breaking documentation fixes if any consumer doc currently depends on the old names.
- Python parity MUST be versioned by the provider readiness matrix, not by blanket marketing language.
- Production-ready status MUST be additive only after a passing release gate on the same commit.

# Undefined / Explicitly user-deferred only

- Dashboard UI behavior is undefined.
- Visual workflow-builder behavior is undefined.
- Marketplace/community provider installation behavior is undefined.
- Provider implementations outside the published provider readiness matrix are undefined for production readiness.
- Browser-side token exchange, token refresh, disconnect, and webhook verification are undefined.
