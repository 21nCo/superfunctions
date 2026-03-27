# Full Audit

## Metadata

- **Audit date:** 2026-03-26
- **Repository:** `superfunctions`
- **Commit audited:** `5092916`
- **Environment:** Codex Desktop on Darwin arm64 (`macOS 26.3.1`), Node `v22.22.1`, npm `10.9.4`, Python `3.9.6`
- **Worktree state at start:** not clean; `.conduct/logs.csv` was already modified and `.conduct/audits/2026-03-26-pvk2m8q1-full-audit.md` was already untracked from the earlier plugfn audit in this session
- **Audit mode:** read-only package audit; no product code changes made
- **Verdict:** the shared OAuth package family is directionally strong and substantially reusable, but it is not yet production-ready as the canonical default OAuth substrate for all superfunctions consumers

## Audit scope

This follow-up audit answers the user's explicit request to assess the **reusability of the OAuth primitives in `packages/`**.

The scope of this audit is:

- `packages/oauth-core`
- `packages/oauth-http`
- `packages/oauth-storage`
- `packages/oauth-providers`
- `packages/oauth-flow`
- `packages/oauth-testing`
- `packages/oauth-router`
- the corresponding shared docs under `docs/content/docs/authentication/` and `docs/content/docs/architecture/`

This audit does **not** re-audit consumer adoption in `plugfn`, `authfn`, or other function packages except where the shared-package specs explicitly define shared-package responsibilities.

## Inputs audited (intent + spec bundles)

### User intent

- Determine whether the shared OAuth primitives in `packages/` are reusable enough to become the canonical OAuth substrate across superfunctions.
- Judge whether those primitives are production-ready for broad internal adoption, not merely whether plugfn currently imports them.

### Specs and reference inputs used

- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/INTENT_AUDIT.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/REQUIREMENTS.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/SPEC.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/RELEASE_GATE.md`
- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/REQUIREMENTS.md`
- `docs/content/docs/authentication/oauth-core.mdx`
- `docs/content/docs/authentication/oauth-http.mdx`
- `docs/content/docs/authentication/oauth-storage.mdx`
- `docs/content/docs/authentication/oauth-providers.mdx`
- `docs/content/docs/authentication/oauth-flow.mdx`
- `docs/content/docs/authentication/oauth-testing.mdx`
- `docs/content/docs/architecture/oauth-flow-architecture.mdx`

## High-level findings

1. `oauth-core`, `oauth-http`, and `oauth-storage` are the strongest parts of the family. They present reusable boundaries, avoid framework lock-in, and mostly align with the extraction intent.
2. `oauth-flow` is the main blocker to calling the family production-ready as the shared default. It has the right shape, but several contract and safety issues remain in the orchestration layer.
3. `oauth-testing` satisfies its primary extraction goal: it re-exports the shared in-memory stores instead of carrying duplicate implementations.
4. `oauth-providers` is useful as a curated descriptor and policy convenience layer, but its policy registry is still process-local and not durable enough to be mistaken for an audit-grade compliance store.
5. `oauth-router` extends the shared surface area in a useful direction, but it currently ships unauthenticated route defaults and has no dedicated docs coverage.
6. Documentation coverage exists for the core shared packages, but there are correctness and safety gaps: `oauth-storage` docs use the wrong default token table name, and `oauth-flow` docs normalize `MemoryTokenVault` in the quick-start path.
7. Release-gate confidence is still incomplete. Only `@superfunctions/oauth-http` test execution was clean in this worktree; several other package-local test commands failed during workspace resolution before exercising behavior.

## Intent Inventory

1. Shared OAuth packages should provide a reusable substrate that multiple superfunctions can compose without re-implementing orchestration.
2. The high-level flow should be safe enough to use as the default production path for installs, callbacks, refresh, and disconnect.
3. Storage and provider abstractions should support durable multi-tenant production use, not only demos or tests.
4. Package contracts and docs should make internal and external adoption straightforward.
5. The shared family should be verifiable with realistic package-level build and test commands before it becomes the default dependency for future apps.

## Intent → Spec coverage matrix

| Intent | Primary spec IDs | Status | Notes |
| --- | --- | --- | --- |
| Canonical shared OAuth substrate | `OAUTH-001`, `OAUTH-002`, `OAUTH-007`, `OAUTH-008`, `OAUTH-013`, `ARCH-001` | Partial | Extraction happened, but the orchestration layer still has contract drift and unsafe defaults. |
| Secure default lifecycle for production apps | `OAUTH-003`, `OAUTH-004`, `OAUTH-005`, `OAUTH-006`, `OAUTH-013` | Partial / Fail | Start and callback invariants are present, but disconnect semantics and plaintext token fallback block a clean production-ready verdict. |
| Multi-tenant and multi-consumer reuse | `OAUTH-002`, `OAUTH-007`, `OAUTH-008`, `OAUTH-014` | Partial | Storage and hooks exist, but `oauth-flow` lacks runtime config resolver parity with `oauth-core`. |
| Low-friction internal adoption | `OAUTH-001`, `OAUTH-002`, `OAUTH-008`, `OAUTH-014` | Partial | Core package composition is understandable, but docs and route-layer ergonomics still leave adoption sharp edges. |
| Credible release verification | `OPS-001` to `OPS-004` as practical gate intent | Fail | Shared-package test and build commands were not cleanly reproducible from this worktree. |

## Requirement coverage summary

Only requirements directly relevant to the shared OAuth package family were scored here.

| Requirement | Status | Summary |
| --- | --- | --- |
| `OAUTH-001` | Pass | `oauth-testing` re-exports the in-memory stores from `oauth-storage` and validates alias identity in tests. |
| `OAUTH-002` | Partial | `oauth-flow` exists, is typed, and is framework-agnostic, but the implementation is not yet strong enough to be the canonical default. |
| `OAUTH-003` | Partial | Start-path invariants are present via `oauth-core`, but full release-gate confidence was limited by workspace-resolution failures. |
| `OAUTH-004` | Partial | Callback invariants are implemented through `oauth-core`, but package-local verification did not run cleanly in this worktree. |
| `OAUTH-005` | Partial | Refresh-token preservation exists, but the fallback persistence path still stores plaintext JSON in `encryptedPayload`. |
| `OAUTH-006` | Fail | `disconnect()` reports `connectionDeleted: true` without actually deleting a consumer connection record. |
| `OAUTH-007` | Partial | Hooks exist and failures are wrapped, but disconnect hooks do not receive normalized token metadata and the contract is thin. |
| `OAUTH-008` | Pass | `oauth-storage` provides real SQL and `@superfunctions/db` adapter bridges instead of synthetic connection-record hacks. |
| `OAUTH-013` | Partial | Standardized events and deterministic error wrappers exist, but the package family still has verification and contract gaps. |
| `OAUTH-014` | Partial | Docs pages exist for the required packages and architecture page exists, but there are correctness and safety issues in the docs set. |

## Requirement-by-requirement results

### `OAUTH-001` — Pass

`packages/oauth-testing/src/index.ts:1-10` re-exports `MemoryOAuthStateStore` and `MemoryTokenVault` from `@superfunctions/oauth-storage` under the backward-compatible `InMemory*` names. `packages/oauth-testing/src/__tests__/exports.test.ts` asserts those aliases point at the shared implementations.

This is the cleanest example in the family of the extraction doing exactly what the spec asked for: one canonical implementation, one compatibility surface, no local divergence.

### `OAUTH-002` — Partial

The package exists and the high-level service surface is correct: `packages/oauth-flow/src/service.ts:193-205` exposes `start()`, `handleCallback()`, `refresh()`, and `disconnect()`, and the package composes `@superfunctions/oauth-core`, `@superfunctions/oauth-http`, and `@superfunctions/oauth-storage` at `packages/oauth-flow/src/service.ts:1-16`.

The package is also framework-agnostic in runtime imports, which is exactly the right architectural direction.

However, the shared family should not be judged only on package existence. `oauth-flow` still carries enough contract drift and unsafe behavior that it is not yet credible as the “default for all integrations” layer:

- local redefinition of lower-level types at `packages/oauth-flow/src/service.ts:18-85` increases internal drift risk
- no runtime config resolver parity with `oauth-core`
- disconnect and token persistence semantics still have material correctness issues

### `OAUTH-003` — Partial

`oauth-flow.start()` delegates into `DefaultOAuthService`, and `oauth-core` clearly implements the expected start-path invariants:

- provider existence enforcement in `packages/oauth-core/src/service.ts:220-223`
- runtime-config lookup and validation in `packages/oauth-core/src/service.ts:226-260`
- redirect allowlist and authorization request handling during `createAuthorizationRequest()` in `packages/oauth-core/src/service.ts:88-95`

This is the right reuse shape. `oauth-flow` is not reinventing those invariants.

I am keeping this at **Partial** rather than **Pass** because `npm exec --workspace @superfunctions/oauth-flow -- vitest --run` and `npm exec --workspace @superfunctions/oauth-core -- vitest --run` did not complete cleanly in this worktree due unresolved workspace-package imports before behavior-level verification.

### `OAUTH-004` — Partial

The callback lifecycle is similarly architected well. `oauth-core` implements callback-state consumption and runtime-config validation, and `oauth-flow` builds on that orchestration rather than forking it.

The acceptance criteria appear covered by code shape and tests present under:

- `packages/oauth-flow/src/__tests__/start-callback.test.ts`
- `packages/oauth-core/tests/oauth-core.test.ts`

This remains **Partial** for the same reason as `OAUTH-003`: package-local command verification was not cleanly runnable in this worktree.

### `OAUTH-005` — Partial

`oauth-flow` correctly preserves the existing refresh token when the provider omits a replacement in `packages/oauth-flow/src/service.ts:682-692`, and the refresh persistence path updates the existing record in place at `packages/oauth-flow/src/service.ts:829-859`.

That satisfies the behavioral intent of refresh-token preservation.

The problem is the fallback persistence contract. When callers provide a plain `TokenVault` instead of an `EncryptedTokenVault`, `oauth-flow` serializes the token set directly into `encryptedPayload`:

- `packages/oauth-flow/src/service.ts:737-750`
- `packages/oauth-flow/src/service.ts:854-859`

That means the “high-level shared default” still permits plaintext durable token storage behind an encrypted-looking field name. For a canonical production substrate, that is too permissive.

### `OAUTH-006` — Fail

This is the clearest correctness failure in the shared orchestration layer.

`disconnect()` deletes the token record with `deleteTokenByConnection()` at `packages/oauth-flow/src/service.ts:616-617`, then unconditionally sets `connectionDeleted = true` at `packages/oauth-flow/src/service.ts:618`, and returns that flag to callers at `packages/oauth-flow/src/service.ts:645-650`.

But `oauth-flow` does not own or delete any consumer-specific connection record. The only post-cleanup consumer hook is `onDisconnected(input)` at `packages/oauth-flow/src/service.ts:185-190` and `620`, which receives the input only and returns no deletion result.

The result is a misleading public contract: callers can receive `connectionDeleted: true` even when no domain connection record was deleted anywhere.

That is material because `OAUTH-006` explicitly requires local token and **connection** cleanup semantics. Today the shared package can only honestly guarantee token cleanup.

### `OAUTH-007` — Partial

Identity hooks exist and hook failures are wrapped deterministically:

- hook contract at `packages/oauth-flow/src/service.ts:178-191`
- wrapper at `packages/oauth-flow/src/service.ts:277-308`

This is enough to prove the package is trying to support multiple identity models.

The disconnect hook contract is still too thin for a canonical reusable substrate:

- `onConnected` receives `OAuthFlowCallbackResult`, including `tokenSet` and resolved identity metadata
- `onDisconnected` receives only `OAuthFlowDisconnectInput`

That misses part of the spec intent that hooks receive normalized flow context and token metadata. It also contributes to the misleading `connectionDeleted` semantics because the hook cannot report whether it actually removed the caller's domain record.

### `OAUTH-008` — Pass

`oauth-storage` now provides real first-class persistence paths:

- `@superfunctions/db` bridge in `packages/oauth-storage/src/adapters/db.ts`
- SQL adapter in `packages/oauth-storage/src/adapters/sql.ts`
- in-memory adapters and encrypted vault primitives in `packages/oauth-storage/src/adapters/memory.ts` and `packages/oauth-storage/src/token-vault.ts`

This is the right shared abstraction boundary, and it directly addresses the spec intent to move away from consumer-specific connection-record hacks.

### `OAUTH-013` — Partial

`oauth-flow` emits standardized events and wraps failures into stable error shapes:

- event names at `packages/oauth-flow/src/service.ts:207-215`
- error wrapper at `packages/oauth-flow/src/service.ts:257-275`
- start/callback/refresh/disconnect event emissions throughout the service

This is solid platform behavior and should remain the foundation.

The reason this stays **Partial** is not because the event model is wrong. It is because the family still has public-contract mismatches and verification gaps, which makes it too early to call the observability surface fully production-ready.

### `OAUTH-014` — Partial

The required documentation pages do exist:

- `docs/content/docs/authentication/oauth-core.mdx`
- `docs/content/docs/authentication/oauth-http.mdx`
- `docs/content/docs/authentication/oauth-storage.mdx`
- `docs/content/docs/authentication/oauth-providers.mdx`
- `docs/content/docs/authentication/oauth-flow.mdx`
- `docs/content/docs/authentication/oauth-testing.mdx`
- `docs/content/docs/architecture/oauth-flow-architecture.mdx`

The architecture page also explicitly calls out the legacy migration path at `docs/content/docs/architecture/oauth-flow-architecture.mdx:25-29`.

This still falls short of a full **Pass** for two reasons:

1. `oauth-storage` docs are incorrect about the default token table/model name. The README and docs page use `oauth_token_vault` at:
   - `packages/oauth-storage/README.md:9-24`
   - `docs/content/docs/authentication/oauth-storage.mdx:59-67`

   The actual default is `oauth_tokens` at:
   - `packages/oauth-storage/src/adapters/db.ts:51-56`
   - `packages/oauth-storage/src/adapters/sql.ts` default schema helpers

2. `oauth-flow` docs normalize an in-memory token vault in the quick-start and real-world examples:
   - `docs/content/docs/authentication/oauth-flow.mdx:31-49`
   - `docs/content/docs/authentication/oauth-flow.mdx:81-99`

   That is acceptable for examples in isolation, but for a shared production default package it weakens the safe-default story unless the docs explicitly distinguish demo storage from production storage.

## Spec conflicts / spec gaps

1. `OAUTH-006` assumes `oauth-flow` can truthfully report connection cleanup, but the shared package has no explicit domain-connection cleanup abstraction. That under-specification enabled the current misleading `connectionDeleted` flag.
2. `OAUTH-005` requires deterministic encrypted-token updates, but the public `oauth-flow` API still accepts a plain `TokenVault`. The spec does not state whether plaintext durable storage is allowed, discouraged, or forbidden for production consumers.
3. The shared OAuth package family now includes `oauth-router`, but the audited shared-package requirements and docs coverage do not mention it. That leaves a real shared entry point outside the formal architecture and documentation envelope.
4. The requirements emphasize package existence and adoption, but do not explicitly require package-local release-gate reproducibility. In practice, that missing bar makes it easier for a shared package family to look “done” before it is easy to verify in isolation.

## Cross-cutting audits

### Security

- `oauth-flow` permits plaintext JSON token persistence when the configured vault is not encrypted (`packages/oauth-flow/src/service.ts:737-750`, `829-859`).
- `oauth-router` sets `meta: { auth: { mode: "none" } }` on all generated routes, including disconnect routes (`packages/oauth-router/src/connection-routes.ts:35-87`, `packages/oauth-router/src/browser-routes.ts:45-105`). For a reusable package, unauthenticated-by-default disconnect routes are a serious footgun.
- The docs currently make insecure storage feel normal by showcasing `MemoryTokenVault` in the main `oauth-flow` path (`docs/content/docs/authentication/oauth-flow.mdx:31-49`, `81-99`).

### API and abstraction hygiene

- `oauth-core` already supports dynamic runtime config resolution via `resolveProviderRuntimeConfig` at `packages/oauth-core/src/service.ts:53-63` and `226-260`.
- `oauth-flow` only supports a static `providerRuntimeConfig: Record<string, OAuthProviderRuntimeConfig>` at `packages/oauth-flow/src/service.ts:229-239` and `779-787`.

That mismatch matters for multi-tenant and multi-region apps, which are exactly the cases most likely to rely on a shared OAuth substrate.

- `oauth-flow` also redefines lower-level contract types locally at `packages/oauth-flow/src/service.ts:18-85` rather than importing or re-exporting a single canonical type family. That is not a runtime bug today, but it is the kind of internal duplication that becomes tomorrow's compatibility drift.

### Provider policy durability

`ProviderPolicyRegistry` stores consent records and audit events only in process memory:

- `packages/oauth-providers/src/policy-registry.ts:121-124`
- `packages/oauth-providers/src/policy-registry.ts:179`
- `packages/oauth-providers/src/policy-registry.ts:233`

It also creates consent IDs with `Math.random()` at `packages/oauth-providers/src/policy-registry.ts:246-248`.

That is acceptable for a convenience registry or test-friendly default, but not for a durable compliance or audit subsystem. The package should either expose this clearly as convenience-only or add a persistence-oriented abstraction.

### Documentation and package ergonomics

- The shared docs pages exist for the required OAuth packages, which is a real improvement.
- Package-local README coverage is sparse: only `packages/oauth-storage/README.md` exists among the audited OAuth packages.
- There is no dedicated docs page for `oauth-router`, and repository searches for `oauth-router` docs returned nothing outside code.

For a family meant to become the “go to for all integrations,” npm/package-page ergonomics and discoverability still need work.

### Verification and release confidence

The package-level verification story is not clean in this worktree:

- `npm exec --workspace @superfunctions/oauth-http -- vitest --run` passed
- `npm exec --workspace @superfunctions/oauth-core -- vitest --run` failed on unresolved `@superfunctions/oauth-storage`
- `npm exec --workspace @superfunctions/oauth-storage -- vitest --run` partially ran, but one suite failed on unresolved `@superfunctions/db/adapters`
- `npm exec --workspace @superfunctions/oauth-providers -- vitest --run` failed on unresolved `@superfunctions/oauth-http`
- `npm exec --workspace @superfunctions/oauth-flow -- vitest --run` failed on unresolved shared-package imports
- `npm exec --workspace @superfunctions/oauth-router -- vitest --run` failed on unresolved `@superfunctions/http`
- `npm exec --workspace @superfunctions/oauth-testing -- vitest --run` failed on unresolved `@superfunctions/oauth-storage`
- `turbo run build --filter=@superfunctions/oauth-router... --filter=@superfunctions/oauth-testing...` failed early because `tsc` was missing in upstream workspaces

Some of those failures may reflect workspace/install state rather than package logic. Even so, they still matter for production-readiness: a shared substrate that is meant to anchor many consumers should be straightforward to verify in repo.

## Recommendations

1. Fix `oauth-flow.disconnect()` before broader adoption. Either remove `connectionDeleted` from the public result, or introduce an explicit consumer-supplied connection cleanup hook that returns an actual deletion outcome.
2. Make encrypted token storage the production-default story in `oauth-flow`. The cleanest fix is to require `EncryptedTokenVault` for production code paths or make unsafe plaintext storage an explicitly named opt-in mode with loud docs.
3. Add `resolveProviderRuntimeConfig` support to `oauth-flow` so it matches `oauth-core` and can serve multi-tenant or region-aware apps without wrapper code.
4. Collapse duplicated contract types in `oauth-flow` into imported or shared exported types. The shared OAuth family should not drift internally.
5. Harden `oauth-router` before treating it as a reusable default. At minimum, stop defaulting disconnect routes to `auth: none` and add a dedicated docs page with explicit security expectations.
6. Either persist provider-policy consents/audit events through a real store abstraction or clearly label `ProviderPolicyRegistry` as an in-memory convenience tool rather than an audit-grade subsystem.
7. Correct the `oauth-storage` docs to use `oauth_tokens`, and revise `oauth-flow` docs so production examples use encrypted storage or clearly mark in-memory vaults as test/demo-only.
8. Make package-level build and test commands reproducible from a fresh workspace. That verification bar is especially important if these packages are going to underpin future apps like nucleus.

## Appendix: commands run + environment details

### Commands run

```bash
pwd
git rev-parse --short HEAD
git status --short
ls .conduct/audits | tail -n 5
tail -n 5 .conduct/logs.csv

rg --files packages | rg '^packages/(oauth|oauth-)'
rg -n 'oauth-flow|oauth-storage|oauth-http|oauth-providers|oauth-core' .conduct/specs plugfn/.conduct/specs packages -g 'README.md' -g 'SPEC.md' -g 'REQUIREMENTS.md' -g 'INTENT_AUDIT.md'
rg --files docs/content/docs/authentication | sort | rg 'oauth'
rg -n 'oauth-router' docs packages .conduct/specs -g 'README.md' -g '*.md' -g '*.mdx' -g 'REQUIREMENTS.md'

nl -ba packages/oauth-core/src/service.ts | sed -n '45,95p'
nl -ba packages/oauth-core/src/service.ts | sed -n '220,265p'
nl -ba packages/oauth-flow/src/service.ts | sed -n '1,220p'
nl -ba packages/oauth-flow/src/service.ts | sed -n '225,320p'
nl -ba packages/oauth-flow/src/service.ts | sed -n '610,760p'
nl -ba packages/oauth-flow/src/service.ts | sed -n '820,900p'
nl -ba packages/oauth-providers/src/policy-registry.ts | sed -n '115,260p'
nl -ba packages/oauth-router/src/connection-routes.ts | sed -n '1,220p'
nl -ba packages/oauth-router/src/browser-routes.ts | sed -n '1,170p'
nl -ba packages/oauth-storage/src/adapters/db.ts | sed -n '1,140p'
nl -ba packages/oauth-storage/src/adapters/sql.ts | sed -n '1,120p'
nl -ba packages/oauth-storage/README.md | sed -n '1,220p'
nl -ba docs/content/docs/authentication/oauth-flow.mdx | sed -n '1,170p'
nl -ba docs/content/docs/authentication/oauth-storage.mdx | sed -n '1,220p'
nl -ba docs/content/docs/architecture/oauth-flow-architecture.mdx | sed -n '1,240p'
nl -ba .conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/REQUIREMENTS.md | sed -n '1,260p'

npm exec --workspace @superfunctions/oauth-core -- vitest --run
npm exec --workspace @superfunctions/oauth-http -- vitest --run
npm exec --workspace @superfunctions/oauth-storage -- vitest --run
npm exec --workspace @superfunctions/oauth-providers -- vitest --run
npm exec --workspace @superfunctions/oauth-flow -- vitest --run
npm exec --workspace @superfunctions/oauth-router -- vitest --run
npm exec --workspace @superfunctions/oauth-testing -- vitest --run
turbo run build --filter=@superfunctions/oauth-router... --filter=@superfunctions/oauth-testing...

date '+%Y-%m-%dT%H:%M:%S%z'
uname -sm
sw_vers -productVersion
node -v
npm -v
python3 --version
```

### Environment details

- OS: Darwin arm64
- macOS: 26.3.1
- Node: v22.22.1
- npm: 10.9.4
- Python: 3.9.6
- Shell: `zsh`
- Working directory: repo root
