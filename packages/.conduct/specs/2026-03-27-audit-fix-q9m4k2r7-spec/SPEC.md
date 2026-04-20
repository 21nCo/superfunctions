# Metadata

- Timestamp: `2026-03-27T01:33:22Z`
- Agent: `unknown-agent`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- OS/Shell: `Darwin arm64` / `zsh`
- Repo metadata: git repo; branch `detached`; commit `5092916`; worktree `dirty`
- Spec folder: `2026-03-27-audit-fix-q9m4k2r7-spec`
- Spec path: `packages/.conduct/specs/2026-03-27-audit-fix-q9m4k2r7-spec`
- Spec type: `audit-fix`
- Spec id: `q9m4k2r7`
- Input paths read:
  - `packages/.conduct/STRUCTURE.md`
  - `packages/.conduct/ARCHITECTURE.md`
  - `packages/.conduct/specs/2026-03-21-new-o4p8n2r6-spec/SPEC.md`
  - `packages/.conduct/specs/2026-03-21-new-o4p8n2r6-spec/REQUIREMENTS.md`
  - `.conduct/audits/2026-03-26-y7m3q2k8-full-audit.md`
  - `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/REQUIREMENTS.md`
  - `package.json`
  - `turbo.json`
  - `packages/db/package.json`
  - `packages/oauth-core/package.json`
  - `packages/oauth-http/package.json`
  - `packages/oauth-storage/package.json`
  - `packages/oauth-providers/package.json`
  - `packages/oauth-flow/package.json`
  - `packages/oauth-testing/package.json`
  - `packages/oauth-router/package.json`
  - `packages/oauth-core/src/index.ts`
  - `packages/oauth-core/src/service.ts`
  - `packages/oauth-http/src/index.ts`
  - `packages/oauth-storage/src/index.ts`
  - `packages/oauth-providers/src/index.ts`
  - `packages/oauth-providers/src/policy-registry.ts`
  - `packages/oauth-flow/src/index.ts`
  - `packages/oauth-flow/src/service.ts`
  - `packages/oauth-router/src/index.ts`
  - `packages/oauth-router/src/browser-routes.ts`
  - `packages/oauth-router/src/connection-routes.ts`
  - `packages/oauth-flow/src/__tests__/start-callback.test.ts`
  - `packages/oauth-flow/src/__tests__/refresh-disconnect.test.ts`
  - `packages/oauth-router/src/__tests__/routes.test.ts`
  - `packages/oauth-storage/tests/shared-schema.test.ts`
  - `packages/oauth-providers/tests/policy-registry.test.ts`
  - `docs/content/docs/authentication/meta.json`
  - `docs/content/docs/authentication/oauth-storage.mdx`
  - `docs/content/docs/authentication/oauth-flow.mdx`
  - `docs/content/docs/authentication/oauth-providers.mdx`
  - `docs/content/docs/architecture/meta.json`
  - `docs/content/docs/architecture/oauth-flow-architecture.mdx`
- Audit reference:
  - audit file: `.conduct/audits/2026-03-26-y7m3q2k8-full-audit.md`
  - related packages spec: `packages/.conduct/specs/2026-03-21-new-o4p8n2r6-spec`
  - related root shared-OAuth spec: `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec`

## Overview

Project name: `superfunctions packages`

One-sentence goal: harden the shared OAuth package family so `@superfunctions/oauth-core`, `oauth-http`, `oauth-storage`, `oauth-providers`, `oauth-flow`, `oauth-testing`, and `oauth-router` can serve as the production-default reusable OAuth substrate for future superfunctions consumers.

Target users:

- shared package maintainers
- `plugfn`, `authfn`, `botfn`, `recfn`, and future integration-package authors
- internal and external application teams consuming the published OAuth packages directly

Target environments:

- TypeScript packages executed in Node and Web-Request runtimes
- browser redirect-based OAuth flows
- server-side route factories built on `@superfunctions/http`
- docs site pages under `docs/content/docs`

Languages/packages required:

- TypeScript: `packages/oauth-core`, `packages/oauth-http`, `packages/oauth-storage`, `packages/oauth-providers`, `packages/oauth-flow`, `packages/oauth-testing`, `packages/oauth-router`
- documentation: `docs/content/docs/authentication`, `docs/content/docs/architecture`
- verification tooling: repo-root `package.json`, `turbo.json`, and package-level test/build configuration

Existing systems it must integrate with:

- `@superfunctions/http`
- `@superfunctions/db`
- existing docs site structure under `docs`
- existing package publishing layout in `packages/*`
- downstream consumers such as `plugfn` and `authfn`

Data model summary:

- OAuth state records and token records from `oauth-storage`
- OAuth flow start/callback/refresh/disconnect inputs and results from `oauth-flow`
- route metadata attached to `@superfunctions/http` routes from `oauth-router`
- provider policy definitions, consent records, and policy audit events from `oauth-providers`

Security model:

- multi-tenant OAuth subjects
- redirect allowlisting and replay protection
- production token storage MUST be encrypted by default
- disconnect routes MUST not be public by default for authenticated connection lifecycles
- emitted events, docs, tests, and examples MUST remain redaction-safe

Performance constraints:

- no new runtime network dependencies
- provider policy persistence MUST remain adapter-light and storage-interface based
- package verification MUST be runnable from `repo root` without bespoke machine-local setup

Non-goals:

- no consumer migration implementation in `plugfn`, `authfn`, or other function packages
- no new provider integrations beyond the already shipped provider set
- no Python shared OAuth expansion beyond what is already present in `packages/.conduct/specs/2026-03-21-new-o4p8n2r6-spec`
- no replacement of product-specific connection/account models inside shared packages

Hard constraints:

- shared package contracts MUST remain framework-agnostic unless a package is explicitly an adapter layer
- no absolute filesystem paths may be added to committed artifacts
- all new public contract behavior MUST be deterministic and testable
- unsafe plaintext token persistence MUST never be the default path

## Glossary

- `Canonical type owner`: the package that defines a shared type and whose exported symbol MUST be imported instead of re-declared elsewhere.
- `Connection cleanup`: the consumer-owned deletion or tombstoning of a domain connection/account-link record associated with an OAuth connection.
- `Disconnect hook context`: the normalized payload passed by `oauth-flow` to consumers after local token cleanup and optional provider revoke.
- `Encrypted vault`: an `EncryptedTokenVault` or equivalent wrapper that guarantees ciphertext-at-rest semantics for token payloads.
- `Insecure plaintext mode`: an explicitly opted-in `oauth-flow` configuration that allows storage of serialized token payloads without encryption for tests or throwaway prototypes.
- `Policy consent record`: the durable record that explains which scopes were approved for which provider feature and subject.
- `Policy audit event`: the durable record describing a provider policy version change.
- `Route meta override`: a caller-supplied `Route.meta` object that replaces the secure defaults chosen by `oauth-router`.
- `Secure default`: a default behavior that is safe for production if a consumer does not supply an override.
- `Verification gate`: the documented build/test commands that MUST pass before the shared OAuth family is considered releasable.

## Goals / Non-goals

### Goals

- The shared OAuth packages MUST become trustworthy as the default integration substrate for new superfunctions work.
- `oauth-flow` MUST use canonical shared types, support runtime config resolution parity with `oauth-core`, and expose truthful disconnect semantics.
- `oauth-flow` MUST default to encrypted token persistence and treat plaintext token persistence as an explicit unsafe mode.
- `oauth-router` MUST become secure by default and documented as part of the shared OAuth architecture.
- `oauth-providers` MUST support durable policy consent/audit persistence instead of presenting process-local arrays as an audit boundary.
- The shared OAuth docs and package READMEs MUST be accurate, production-safe, and discoverable.
- The shared OAuth family MUST have a reproducible local release gate from `repo root`.

### Non-goals

- This spec MUST NOT implement downstream adoption in `plugfn`, `authfn`, or other superfunctions.
- This spec MUST NOT redesign `oauth-storage` table names or provider descriptor catalogs beyond the audit findings.
- This spec MUST NOT add new external dependencies unless they are already available in Node standard library or existing repo tooling.

## Public API

### Canonical type ownership

`@superfunctions/oauth-flow` MUST stop re-declaring lower-level types that already belong to `oauth-core` or `oauth-http`.

Canonical owners:

- `@superfunctions/oauth-core`
  - `OAuthIntentSubject`
  - `OAuthProviderRuntimeConfig`
  - `OAuthProviderRuntimeConfigResolverInput`
  - `OAuthProviderRuntimeConfigResolver`
- `@superfunctions/oauth-http`
  - `OAuthTokenGrantType`
  - `OAuthTokenAuthMethod`
  - `OAuthResolvedClientSecret`
  - `OAuthSecretResolverContext`
  - `OAuthClientSecretResolver`
- `@superfunctions/oauth-flow`
  - flow-only subjects/results/events/hooks not already owned elsewhere

`oauth-flow` MAY re-export canonical symbols, but it MUST do so via imported aliases rather than local duplicate definitions.

### `oauth-flow` service config

```ts
import type {
  OAuthIntentSubject,
  OAuthProviderRuntimeConfig,
  OAuthProviderRuntimeConfigResolver,
} from "@superfunctions/oauth-core";
import type {
  OAuthClientSecretResolver,
  OAuthResolvedClientSecret,
  OAuthSecretResolverContext,
  OAuthTokenAuthMethod,
  OAuthTokenGrantType,
} from "@superfunctions/oauth-http";
import type {
  EncryptedTokenVault,
  OAuthStateRecord,
  OAuthStateStore,
  TokenRecord,
  TokenVault,
} from "@superfunctions/oauth-storage";

export type OAuthFlowTokenStorageMode =
  | "encrypted-required"
  | "plaintext-unsafe";

export interface OAuthFlowConnectionCleanupResult {
  attempted: boolean;
  deleted: boolean;
  reason: "deleted" | "not-found" | "not-configured";
}

export interface OAuthFlowDisconnectContext {
  providerId: string;
  connectionId: string;
  subject?: OAuthFlowSubject;
  tokenRecord?: TokenRecord | null;
  tokenSet?: OAuthTokenSet | null;
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  requestId?: string;
}

export interface OAuthFlowResolvedIdentity {
  tenantId: string;
  userId: string;
  connectionId?: string;
  metadata?: Record<string, unknown>;
  persistTokens?: boolean;
}

export type OAuthFlowIdentityHooks = {
  resolveBrowserAuthIdentity?: (
    input: OAuthFlowResolveBrowserAuthIdentityInput
  ) => Promise<OAuthFlowResolvedIdentity | null> | OAuthFlowResolvedIdentity | null;
  onConnected?: (
    result: OAuthFlowCallbackResult
  ) => Promise<void> | void;
  onDisconnected?: (
    input: OAuthFlowDisconnectContext
  ) =>
    | Promise<OAuthFlowConnectionCleanupResult | void>
    | OAuthFlowConnectionCleanupResult
    | void;
};

export type OAuthFlowServiceConfig = {
  providers: Record<string, OAuthProviderDescriptor>;
  providerRuntimeConfig?: Record<string, OAuthProviderRuntimeConfig>;
  resolveProviderRuntimeConfig?: OAuthProviderRuntimeConfigResolver;
  stateStore: OAuthStateStore;
  tokenVault: TokenVault | EncryptedTokenVault;
  tokenStorageMode?: OAuthFlowTokenStorageMode;
  tokenHttpClient?: OAuthTokenHttpClient;
  identityHooks?: OAuthFlowIdentityHooks;
  keyRef?: string;
  now?: () => Date;
  emitEvent?: (event: OAuthFlowEvent) => void;
};
```

Resolver precedence:

1. `resolveProviderRuntimeConfig` MUST be used when present.
2. `providerRuntimeConfig` MUST be used only when no resolver is present.
3. If neither yields a `clientId`, `oauth-flow` MUST throw `OAUTH_RUNTIME_CONFIG_INVALID`.

Token-storage mode rules:

1. Default mode MUST be `"encrypted-required"`.
2. In default mode, `oauth-flow` MUST reject a non-encrypted vault with `OAUTH_TOKEN_STORAGE_UNSAFE`.
3. Plaintext storage MUST be allowed only when `tokenStorageMode === "plaintext-unsafe"`.

### `oauth-flow` disconnect result

```ts
export type OAuthFlowDisconnectResult = {
  disconnected: boolean;
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  connectionCleanup: OAuthFlowConnectionCleanupResult;
  connectionDeleted: boolean; // deprecated alias of connectionCleanup.deleted
};
```

Compatibility rule:

- `connectionDeleted` MUST equal `connectionCleanup.deleted`.
- `connectionDeleted` MUST remain present for one minor release after the structured `connectionCleanup` field ships.
- If no disconnect hook is configured, `connectionCleanup` MUST be `{ attempted: false, deleted: false, reason: "not-configured" }`.

### `oauth-flow` error codes

`oauth-flow` MUST preserve existing stable codes and add:

- `OAUTH_TOKEN_STORAGE_UNSAFE`
  - status: `500`
  - retryable: `false`
  - meaning: a non-encrypted token vault was supplied while `tokenStorageMode` is not `"plaintext-unsafe"`

Existing disconnect-hook failures MUST continue to surface as `OAUTH_HOOK_FAILED` after local token cleanup has already occurred.

### `oauth-router` configuration

```ts
import type { Route } from "@superfunctions/http";

export interface OAuthRouteMetaOverrides {
  start?: Route["meta"];
  callback?: Route["meta"];
  disconnect?: Route["meta"];
}

export interface OAuthConnectionRouteConfig {
  basePath: string;
  flowService: OAuthFlowService;
  resolveStartInput: (
    request: Request,
    context: RouteContext
  ) => Promise<OAuthFlowStartInput> | OAuthFlowStartInput;
  resolveDisconnectInput?: (
    request: Request,
    context: RouteContext
  ) =>
    | Promise<Omit<OAuthFlowDisconnectInput, "providerId" | "requestId">>
    | Omit<OAuthFlowDisconnectInput, "providerId" | "requestId">;
  resolveCallbackInput?: (
    request: Request,
    context: RouteContext
  ) =>
    | Promise<Partial<Omit<OAuthFlowCallbackInput, "providerId" | "requestId">>>
    | Partial<Omit<OAuthFlowCallbackInput, "providerId" | "requestId">>;
  serializeCallbackResult?: (
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<unknown> | unknown;
  requestIdHeader?: string;
  routeMeta?: OAuthRouteMetaOverrides;
}

export interface OAuthBrowserRouteConfig extends OAuthConnectionRouteConfig {
  callbackMode?: "redirect" | "json" | ((
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<"redirect" | "json"> | "redirect" | "json");
  getRedirectLocation?: (
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<string> | string;
}
```

Secure default route metadata:

- `createOAuthConnectionRoutes()`
  - `start`: `auth.mode = "hybrid"`
  - `callback`: `auth.mode = "none"`
  - `disconnect`: `auth.mode = "hybrid"`
- `createOAuthBrowserRoutes()`
  - `start`: `auth.mode = "none"`
  - `callback`: `auth.mode = "none"`
  - `disconnect`: `auth.mode = "cookie-session"`

Any `routeMeta` override MUST replace the corresponding default metadata for that route only.

### `oauth-providers` persistence API

```ts
import type { OAuthConsentStore } from "@superfunctions/oauth-storage";

export interface ProviderPolicyAuditEventRecord {
  auditEventId: string;
  providerId: OAuthProviderId;
  fromVersion: string;
  toVersion: string;
  actor: string;
  reason: string;
  changedAt: string;
}

export interface ProviderPolicyAuditStore {
  put(event: ProviderPolicyAuditEventRecord): Promise<void>;
  listByProvider(providerId: OAuthProviderId): Promise<ProviderPolicyAuditEventRecord[]>;
}

export interface ProviderPolicyRegistryOptions {
  consentStore?: OAuthConsentStore;
  auditStore?: ProviderPolicyAuditStore;
  idGenerator?: () => string;
  now?: () => string;
}

export interface ScopeValidationResult {
  authorized: true;
  consentRecord: ConsentRecord;
}

export class ProviderPolicyRegistry {
  constructor(
    policies: ReadonlyArray<ProviderPolicyDefinition>,
    options?: ProviderPolicyRegistryOptions
  );

  getPolicy(providerId: OAuthProviderId): ProviderPolicyDefinition;
  listPolicies(): ProviderPolicyDefinition[];
  validateScopes(input: ScopeValidationInput): Promise<ScopeValidationResult>;
  assertOperationAllowed(input: OperationCheckInput): OperationCheckResult;
  recordPolicyVersionUpdate(input: PolicyVersionUpdateInput): Promise<PolicyAuditEvent>;
  listConsentRecords(input: {
    providerId: OAuthProviderId;
    tenantId: string;
    userId: string;
  }): Promise<ConsentRecord[]>;
  listPolicyAuditEvents(input: {
    providerId: OAuthProviderId;
  }): Promise<PolicyAuditEvent[]>;
}

export function createDefaultProviderPolicyRegistry(
  options?: ProviderPolicyRegistryOptions
): ProviderPolicyRegistry;
```

Durability rules:

- `createDefaultProviderPolicyRegistry()` MUST still work without caller-supplied stores by using explicit in-memory convenience stores.
- The docs and README MUST label the default in-memory path as non-durable and not audit-grade.
- `Math.random()` MUST NOT be used for consent or audit event identifiers.

### Documentation surface

The following files MUST exist after implementation:

- `packages/oauth-core/README.md`
- `packages/oauth-http/README.md`
- `packages/oauth-storage/README.md`
- `packages/oauth-providers/README.md`
- `packages/oauth-flow/README.md`
- `packages/oauth-testing/README.md`
- `packages/oauth-router/README.md`
- `docs/content/docs/authentication/oauth-router.mdx`

The following docs files MUST be updated:

- `docs/content/docs/authentication/meta.json`
- `docs/content/docs/authentication/oauth-storage.mdx`
- `docs/content/docs/authentication/oauth-flow.mdx`
- `docs/content/docs/authentication/oauth-providers.mdx`
- `docs/content/docs/architecture/oauth-flow-architecture.mdx`

### Release-gate surface

The repo-root gate MUST include a dedicated shared-OAuth command:

```bash
npm run gate:packages-oauth-shared
```

The gate MUST verify:

- buildability of the shared OAuth package dependency closure
- package-local tests for `oauth-core`, `oauth-http`, `oauth-storage`, `oauth-providers`, `oauth-flow`, `oauth-testing`, and `oauth-router`
- docs inventory for the shared OAuth family

## Data formats / protocol

### Disconnect cleanup envelope

```json
{
  "disconnected": true,
  "remoteRevokeAttempted": true,
  "localTokenDeleted": true,
  "connectionCleanup": {
    "attempted": true,
    "deleted": true,
    "reason": "deleted"
  },
  "connectionDeleted": true
}
```

The envelope MUST be deterministic:

- `connectionDeleted` MUST mirror `connectionCleanup.deleted`
- `reason` MUST be one of `deleted`, `not-found`, or `not-configured`
- no token material may appear in the result

### Unsafe token storage configuration

```json
{
  "tokenStorageMode": "plaintext-unsafe"
}
```

Rules:

- absence of `tokenStorageMode` MUST behave as `encrypted-required`
- any other value is invalid
- the configured mode MUST affect only token persistence behavior, not emitted event redaction

### Route metadata defaults

`oauth-router` route factories MUST materialize `Route.meta.auth.mode` according to the secure-default table in the Public API section before any caller overrides are applied.

### Provider policy audit record

```json
{
  "auditEventId": "policy_audit_01",
  "providerId": "google",
  "fromVersion": "2026-03-11",
  "toVersion": "2026-03-27",
  "actor": "admin-user",
  "reason": "compliance-update",
  "changedAt": "2026-03-27T00:00:00.000Z"
}
```

The ID value itself is allowed to vary unless an `idGenerator` override is supplied. The shape and required fields MUST NOT vary.

## Semantics

### `oauth-flow` type ownership

- `oauth-flow` MUST import canonical runtime-config and HTTP-secret types from the owning packages.
- `oauth-flow` MAY continue to export those symbols for convenience, but the exported values MUST be aliases to imported canonical definitions.
- Any flow-only type that references lower-level types MUST use the lower-level canonical symbols directly.

### Runtime config resolution

- `oauth-flow.start()`, `handleCallback()`, `refresh()`, and `disconnect()` MUST all resolve provider runtime configuration through the same precedence rules.
- When `resolveProviderRuntimeConfig` is configured, `oauth-flow` MUST pass the normalized subject, redirect URI, requested scopes, prompt, and login hint through to the resolver exactly once per operation.
- Static `providerRuntimeConfig` MUST remain supported for simple consumers.

### Token persistence

- In `encrypted-required` mode, `oauth-flow` MUST fail before writing any token record if `tokenVault` is not encrypted.
- In `plaintext-unsafe` mode, plaintext serialization MAY continue for tests and prototypes, but the stored field name MUST remain `encryptedPayload` only if docs explicitly describe that it is a compatibility field name rather than a security guarantee.
- Docs, READMEs, and examples MUST treat plaintext mode as test-only or prototype-only.

### Disconnect cleanup

- Local token deletion MUST always happen before reporting hook failure or provider revoke failure.
- Consumer connection cleanup MUST be reported only from an explicit disconnect hook result or equivalent cleanup callback.
- A missing disconnect hook MUST never be reported as a deleted connection.
- A disconnect hook throw MUST surface as `OAUTH_HOOK_FAILED` after local token cleanup has already completed.
- A disconnect hook return value MUST be validated. Invalid result shape MUST surface as `VALIDATION_ERROR`.

### Provider policy persistence

- Consent decisions MUST be durably storable through an injected consent store.
- Policy audit events MUST be durably storable through an injected audit store.
- The in-memory default registry MUST exist only as a convenience mode.
- All persistence-facing methods MUST be Promise-based.

### Documentation and package ergonomics

- Each shared OAuth package README MUST include install, quick start, production safety caveats, link to canonical docs page, and package-boundary description.
- `oauth-router` MUST have a docs page and authentication nav entry.
- `oauth-flow` and `oauth-storage` docs MUST show encrypted production paths before or alongside in-memory examples.
- `oauth-providers` docs MUST state that in-memory stores are convenience-only unless persistent stores are supplied.

### Release verification

- The shared OAuth family MUST define a canonical release gate from `repo root`.
- Package-local tests MUST resolve sibling workspace packages without requiring manually prebuilt `dist` artifacts.
- The release gate MUST fail if README/docs inventory is incomplete for the audited package set.

## Invariants

- Redirect/state validation behavior MUST remain deterministic.
- Resolver precedence MUST be deterministic and stable.
- Error codes, statuses, and retryable flags for new failure cases MUST be deterministic.
- `oauth-flow` MUST remain redaction-safe: no access token, refresh token, client secret, or raw encrypted payload may appear in emitted events, thrown error `details`, README examples that describe failures, or test snapshots.
- `connectionDeleted` MUST never be `true` unless `connectionCleanup.deleted` is `true`.
- Package READMEs and docs page names MUST remain stable once introduced in this spec.
- The release gate MUST be runnable from `repo root` without machine-specific paths.

## Security

- `oauth-flow` MUST default to encrypted token persistence.
- Plaintext persistence MUST require an explicit unsafe mode and MUST be documented as unsafe.
- `oauth-router` MUST not expose authenticated connection start/disconnect endpoints as public by default.
- The callback route MAY remain public because OAuth providers redirect into it.
- Provider policy persistence stores MUST not leak tokens or client secrets; they store only policy, consent, and actor metadata.
- Docs and READMEs MUST not present test-only patterns as production defaults.

## Limits/caps

- No new payload-size caps are introduced by this spec; existing HTTP and storage limits remain in effect.
- README minimum content is capped to concise package guidance; full tutorials remain in docs pages.
- The release gate MUST cover exactly the shared OAuth family audited here and MAY additionally cover `@superfunctions/db` and `@superfunctions/http` when required as direct dependencies.

## Observability

- `oauth-flow` MUST keep emitting start/callback/refresh/disconnect success/failure events.
- New unsafe-storage configuration failures MUST emit `oauth.flow.start.failed` or the relevant operation failure event with `errorCode = "OAUTH_TOKEN_STORAGE_UNSAFE"` and no secret-bearing `details`.
- Disconnect success/failure events SHOULD include structured `connectionCleanup` details in a redaction-safe form.
- The release gate SHOULD print package-by-package status so maintainers can locate failing workspace resolution quickly.

## Compatibility / versioning strategy

- This spec intentionally changes some public package behavior to fix production-readiness gaps.
- `oauth-flow`
  - MUST preserve `connectionDeleted` as a deprecated alias for one minor release
  - MUST add `connectionCleanup` immediately
  - MUST document the default switch to encrypted-required storage as a breaking behavioral change
- `oauth-providers`
  - MAY convert persistence-facing APIs from synchronous to asynchronous
  - MUST document any async migration in README and CHANGELOG
- `oauth-flow` re-exported lower-level types MAY remain available, but they MUST become aliases to canonical definitions
- Public-breaking changes introduced by this spec MUST be called out in package CHANGELOGs where they exist, otherwise in package READMEs

## Undefined / Explicitly user-deferred only

None explicitly deferred by the user.

Anything not specified in this document is undefined and is not required for this spec.
