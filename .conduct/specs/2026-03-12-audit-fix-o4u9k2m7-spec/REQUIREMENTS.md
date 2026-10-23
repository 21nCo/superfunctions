# Requirements

## Table of contents

- OAUTH-001
- OAUTH-002
- OAUTH-003
- OAUTH-004
- OAUTH-005
- OAUTH-006
- OAUTH-007
- OAUTH-008
- OAUTH-009
- OAUTH-010
- OAUTH-011
- OAUTH-012
- OAUTH-013
- OAUTH-014
- REUSE-001
- REUSE-002
- REUSE-003
- REUSE-004
- REUSE-005
- REUSE-006
- REUSE-007
- REUSE-008
- REUSE-009
- REUSE-010
- REUSE-011
- REUSE-012
- DUPL-001
- DUPL-002
- DUPL-003
- DUPL-004
- DUPL-005
- PLAT-001
- PLAT-002
- PLAT-003
- PLAT-004
- DOCS-001
- DOCS-002
- DOCS-003
- DOCS-004
- DOCS-005
- DOCS-006
- OPS-001
- OPS-002
- OPS-003
- OPS-004

---

### ID: OAUTH-001

- **Priority:** P0
- **Statement:** `@superfunctions/oauth-testing` MUST re-export in-memory state/token stores from `@superfunctions/oauth-storage` instead of maintaining duplicate implementations.
- **Rationale:** Duplicate memory store logic has already diverged and increases maintenance and bug risk.
- **Acceptance criteria:**
  - `packages/oauth-testing/src/index.ts` imports and re-exports memory stores from `@superfunctions/oauth-storage`.
  - No local `Map`-backed store class definitions remain in oauth-testing.
  - Existing oauth-testing tests continue to pass with unchanged runtime behavior.
- **Test vectors:** TV-OAUTH-001-P, TV-OAUTH-001-N
- **Notes:** Backward-compatible export names MUST remain available.

### ID: OAUTH-002

- **Priority:** P0
- **Statement:** A new `@superfunctions/oauth-flow` package MUST provide a high-level OAuth orchestration service API that composes oauth-core/oauth-http/oauth-storage.
- **Rationale:** authfn and plugfn currently duplicate orchestration responsibilities with different behaviors.
- **Acceptance criteria:**
  - `packages/oauth-flow` exists with typed public API and tests.
  - Service exposes start/callback/refresh/disconnect methods.
  - Package has no framework-specific runtime dependency.
- **Test vectors:** TV-OAUTH-002-P, TV-OAUTH-002-N
- **Notes:** Package must remain composable for both authfn and plugfn identity models.

### ID: OAUTH-003

- **Priority:** P0
- **Statement:** `oauth-flow.start()` MUST enforce provider existence, redirect allowlist validation, PKCE generation, and state persistence with TTL.
- **Rationale:** Start-step validation and PKCE consistency are critical for secure OAuth initiation.
- **Acceptance criteria:**
  - Unknown provider returns deterministic validation error.
  - Disallowed redirect URI is rejected before state creation.
  - PKCE challenge/method are included when provider supports PKCE.
  - State record includes expiry timestamp and subject identifiers.
- **Test vectors:** TV-OAUTH-003-P, TV-OAUTH-003-N
- **Notes:** TTL default should align with existing oauth-core defaults unless explicitly overridden.

### ID: OAUTH-004

- **Priority:** P0
- **Statement:** `oauth-flow.handleCallback()` MUST atomically consume state and reject replay, expiry, provider mismatch, and redirect mismatch with deterministic error codes.
- **Rationale:** Replay and callback mismatch protections are core OAuth invariants.
- **Acceptance criteria:**
  - First valid callback succeeds.
  - Replayed callback for same state returns replay error code.
  - Mismatched redirect/provider callback returns mismatch error code.
  - Expired state returns invalid/expired error code.
- **Test vectors:** TV-OAUTH-004-P, TV-OAUTH-004-N
- **Notes:** Callback processing must not leak token material in error details.

### ID: OAUTH-005

- **Priority:** P0
- **Statement:** `oauth-flow.refresh()` MUST preserve existing refresh tokens when providers omit a replacement and MUST update encrypted token records deterministically.
- **Rationale:** Some providers do not rotate refresh tokens every refresh response.
- **Acceptance criteria:**
  - Successful refresh updates access token and expiry metadata.
  - Missing new refresh token keeps prior refresh token value.
  - Refresh failure leaves prior token record intact.
- **Test vectors:** TV-OAUTH-005-P, TV-OAUTH-005-N
- **Notes:** Deterministic update timestamps are required for auditability.

### ID: OAUTH-006

- **Priority:** P0
- **Statement:** `oauth-flow.disconnect()` MUST perform local token/connection cleanup even when remote revoke fails.
- **Rationale:** Local credential lifecycle must not depend on remote provider availability.
- **Acceptance criteria:**
  - Successful remote revoke produces full cleanup result.
  - Remote revoke failure still deletes local token and connection records.
  - Result surface includes attempted/cleanup flags.
- **Test vectors:** TV-OAUTH-006-P, TV-OAUTH-006-N
- **Notes:** Failure should be surfaced after cleanup, not before.

### ID: OAUTH-007

- **Priority:** P1
- **Statement:** `oauth-flow` MUST expose identity lifecycle hooks so consumers can attach domain-specific identity persistence without forking OAuth logic.
- **Rationale:** authfn and plugfn have different identity models but share OAuth orchestration needs.
- **Acceptance criteria:**
  - Hook API exists for post-connect and post-disconnect events.
  - Hooks receive normalized flow context and token metadata.
  - Hook failures are surfaced with deterministic error wrappers.
- **Test vectors:** TV-OAUTH-007-P, TV-OAUTH-007-N
- **Notes:** Hooks must not be mandatory for base flow operation.

### ID: OAUTH-008

- **Priority:** P0
- **Statement:** oauth-storage MUST provide a first-class adapter path for `@superfunctions/db` so persistent OAuth state/token storage does not depend on ad-hoc connection-record hacks.
- **Rationale:** PlugFn currently encodes OAuth state/token records through custom adapter metadata on connection records.
- **Acceptance criteria:**
  - New adapter constructor accepts `@superfunctions/db` Adapter.
  - State/token tables/collections are explicit and documented.
  - PlugFn can configure persistent storage without fallback to memory-only stores.
- **Test vectors:** TV-OAUTH-008-P, TV-OAUTH-008-N
- **Notes:** SQL adapter may continue to exist but should not be the only persistent route.

### ID: OAUTH-009

- **Priority:** P0
- **Statement:** PlugFn connection manager MUST use `@superfunctions/oauth-flow` for start/callback/refresh/disconnect orchestration.
- **Rationale:** PlugFn duplicates high-level orchestration already present in authfn and shared packages.
- **Acceptance criteria:**
  - Connection manager delegates flow operations through oauth-flow service.
  - Existing PlugFn OAuth integration tests continue to pass.
  - No duplicated orchestration helper remains in connection manager.
- **Test vectors:** TV-OAUTH-009-P, TV-OAUTH-009-N
- **Notes:** Provider-specific descriptor mapping remains allowed in plugfn provider layer.

### ID: OAUTH-010

- **Priority:** P1
- **Statement:** `plugfn/typescript/src/auth/oauth-flow.ts` MUST be converted to a compatibility wrapper with no business logic.
- **Rationale:** The file currently introduces legacy semantics and memory-store defaults.
- **Acceptance criteria:**
  - Wrapper delegates to oauth-flow or thin adapter functions only.
  - File includes deprecation warning and migration reference.
  - No independent state/token flow logic remains.
- **Test vectors:** TV-OAUTH-010-P, TV-OAUTH-010-N
- **Notes:** Backward-compatible import path should remain for one minor release.

### ID: OAUTH-011

- **Priority:** P0
- **Statement:** AuthFn social OAuth service MUST adopt oauth-flow while preserving existing authfn social OAuth public API behavior.
- **Rationale:** AuthFn is a primary consumer and must remain stable while reducing duplication.
- **Acceptance criteria:**
  - Public method behavior remains backward-compatible.
  - Internal orchestration delegates to oauth-flow.
  - Existing social OAuth tests pass, including revoke-failure behavior.
- **Test vectors:** TV-OAUTH-011-P, TV-OAUTH-011-N
- **Notes:** Comprehensive authfn expansion remains out of scope.

### ID: OAUTH-012

- **Priority:** P0
- **Statement:** RecFn calendar token-store and token-refresh components MUST use shared OAuth storage/flow abstractions.
- **Rationale:** RecFn currently defines separate token interfaces that duplicate shared OAuth functionality.
- **Acceptance criteria:**
  - RecFn calendar token storage path uses oauth-storage token vault abstractions.
  - Refresh path uses oauth-flow/oauth-http primitives.
  - RecFn calendar tests pass with shared-package-backed implementation.
- **Test vectors:** TV-OAUTH-012-P, TV-OAUTH-012-N
- **Notes:** Domain-specific calendar scheduling logic remains outside shared OAuth packages.

### ID: OAUTH-013

- **Priority:** P1
- **Statement:** OAuth flow operations MUST emit standardized observability events and deterministic error metadata.
- **Rationale:** Cross-function incident response requires consistent operational signals.
- **Acceptance criteria:**
  - Start/callback/refresh/disconnect events include request IDs and provider IDs.
  - Error payloads include stable code/status/retryable fields.
  - Sensitive secrets/tokens are excluded from emitted fields.
- **Test vectors:** TV-OAUTH-013-P, TV-OAUTH-013-N
- **Notes:** Event naming should be namespace-safe for multi-package consumers.

### ID: OAUTH-014

- **Priority:** P1
- **Statement:** Root shared docs MUST include complete OAuth architecture and package reference coverage for oauth-core/http/storage/providers/testing/flow.
- **Rationale:** OAuth packages currently have incomplete discoverable documentation and no unified onboarding path.
- **Acceptance criteria:**
  - Each OAuth shared package has dedicated docs page.
  - OAuth flow architecture page explains composition and migration from legacy paths.
  - Docs include one external-consumer example and one superfunction-consumer example.
- **Test vectors:** TV-OAUTH-014-P, TV-OAUTH-014-N
- **Notes:** Docs must call out security invariants and common misconfiguration failures.

### ID: REUSE-001

- **Priority:** P0
- **Statement:** A new `@superfunctions/webhooks` package MUST provide reusable signing, verification, and retrying delivery primitives.
- **Rationale:** RecFn and CIFn implement overlapping webhook signature and delivery logic.
- **Acceptance criteria:**
  - Shared package exports sign/verify/deliver APIs.
  - Verification supports timing-safe comparison.
  - Delivery supports bounded retries with backoff.
- **Test vectors:** TV-REUSE-001-P, TV-REUSE-001-N
- **Notes:** Provider-specific header naming can remain configurable.

### ID: REUSE-002

- **Priority:** P0
- **Statement:** RecFn and CIFn webhook implementations MUST consume `@superfunctions/webhooks` instead of local duplicate signing/delivery logic.
- **Rationale:** Extracted package value is realized only through adoption.
- **Acceptance criteria:**
  - RecFn `webhooks/sign.ts` and delivery path delegate to shared package.
  - CIFn webhook signature verification delegates to shared package.
  - Existing webhook tests in both consumers pass.
- **Test vectors:** TV-REUSE-002-P, TV-REUSE-002-N
- **Notes:** Domain-specific trigger routing remains in consumer functions.

### ID: REUSE-003

- **Priority:** P0
- **Statement:** A new `@superfunctions/envelope` package MUST define canonical success/error response envelope constructors.
- **Rationale:** Envelope shape drift exists across recfn/cifn/cmsfn/datafn families.
- **Acceptance criteria:**
  - Canonical envelope types are exported and documented.
  - `ok()` and `err()` helpers produce deterministic shape with meta timestamps.
  - Compat conversion helper exists for legacy `{ ok, result }` and `{ ok, data }` forms.
- **Test vectors:** TV-REUSE-003-P, TV-REUSE-003-N
- **Notes:** Canonical schema should include retryability and status in error envelope.

### ID: REUSE-004

- **Priority:** P0
- **Statement:** A new `@superfunctions/errors` package MUST provide code-to-status mapping, retryability metadata, and typed error construction.
- **Rationale:** Error mapping is duplicated in recfn and inconsistent in other functions.
- **Acceptance criteria:**
  - Registry API supports registering and resolving error code definitions.
  - Typed error class exposes code/status/retryable/details.
  - Integration with envelope helper is documented.
- **Test vectors:** TV-REUSE-004-P, TV-REUSE-004-N
- **Notes:** Package should remain framework-agnostic.

### ID: REUSE-005

- **Priority:** P1
- **Statement:** RecFn, CIFn, and CmsFn MUST adopt shared envelope/error helpers with compatibility adapters where needed.
- **Rationale:** Shared package creation without consumer adoption will not reduce drift.
- **Acceptance criteria:**
  - RecFn middleware envelope helper imports from shared package.
  - CIFn envelope module imports or wraps shared package.
  - CmsFn envelope utilities map to shared package or explicit compatibility shim.
- **Test vectors:** TV-REUSE-005-P, TV-REUSE-005-N
- **Notes:** No forced one-shot breaking envelope migration is required.

### ID: REUSE-006

- **Priority:** P0
- **Statement:** A new `@superfunctions/queue` package MUST provide queue adapter interfaces and memory/FlowFn-backed implementations.
- **Rationale:** Queue adapters are duplicated across recfn and cifn with near-identical semantics.
- **Acceptance criteria:**
  - Shared queue interface supports enqueue/dequeue/peek/size.
  - Memory adapter preserves FIFO behavior.
  - FlowFn HTTP adapter supports authenticated enqueue/dequeue.
- **Test vectors:** TV-REUSE-006-P, TV-REUSE-006-N
- **Notes:** Optional dequeueMatching support may be capability-gated.

### ID: REUSE-007

- **Priority:** P0
- **Statement:** RecFn and CIFn queue adapters MUST migrate to `@superfunctions/queue` and remove duplicated in-memory queue implementations.
- **Rationale:** This is a high-frequency duplicate pattern with operational impact.
- **Acceptance criteria:**
  - Local memory queue class implementations are removed or wrapper-only.
  - Consumer tests validate identical queue behavior after migration.
  - Queue name constants remain stable or are aliased.
- **Test vectors:** TV-REUSE-007-P, TV-REUSE-007-N
- **Notes:** Worker lifecycle logic remains function-specific.

### ID: REUSE-008

- **Priority:** P1
- **Statement:** A new `@superfunctions/metrics` package MUST provide common metrics emitter interfaces and helpers.
- **Rationale:** RecFn currently has local metrics emitter wrappers that are reusable.
- **Acceptance criteria:**
  - Shared metrics emitter package exports no-op and namespaced emitter helpers.
  - RecFn metrics wrapper delegates to shared package.
  - Event emission shape remains backward-compatible for RecFn observability tests.
- **Test vectors:** TV-REUSE-008-P, TV-REUSE-008-N
- **Notes:** Metric naming remains domain-specific per consumer namespace.

### ID: REUSE-009

- **Priority:** P1
- **Statement:** A new `@superfunctions/config` package MUST provide reusable typed env loading helpers for numeric/string/boolean limits.
- **Rationale:** RecFn limit and rate config loader patterns are generic and duplicated elsewhere.
- **Acceptance criteria:**
  - Shared env helper package exposes typed readers with bounds validation.
  - RecFn config loaders use shared readers.
  - Invalid env values deterministically fall back or fail according to declared behavior.
- **Test vectors:** TV-REUSE-009-P, TV-REUSE-009-N
- **Notes:** Default/fallback behavior must be explicitly documented.

### ID: REUSE-010

- **Priority:** P1
- **Statement:** `@superfunctions/auth` MUST provide bearer token extraction and reusable bearer middleware so RecFn auth helper logic is not reimplemented.
- **Rationale:** Bearer parsing/auth scaffolding is repeated and easy to drift.
- **Acceptance criteria:**
  - Shared extraction function handles malformed/missing headers deterministically.
  - Shared middleware supports pluggable token validation callback.
  - RecFn auth helper uses shared extraction/middleware behavior.
- **Test vectors:** TV-REUSE-010-P, TV-REUSE-010-N
- **Notes:** Middleware remains optional for consumers with custom auth stacks.

### ID: REUSE-011

- **Priority:** P0
- **Statement:** Shared rate-limiting implementation MUST support `fixed-window`, `sliding-window`, and `token-bucket` with actual runtime behavior matching configured algorithm.
- **Rationale:** Existing shared middleware exposes algorithm config that is currently ignored.
- **Acceptance criteria:**
  - Algorithm option affects runtime logic and test outcomes.
  - Sliding-window and token-bucket behavior have deterministic tests.
  - Backward-compatible defaults remain documented.
- **Test vectors:** TV-REUSE-011-P, TV-REUSE-011-N
- **Notes:** May be delivered as `@superfunctions/rate-limit` or enhancement to `@superfunctions/middleware`.

### ID: REUSE-012

- **Priority:** P1
- **Statement:** RecFn and PlugFn rate limiting paths MUST adopt shared algorithm implementations or explicit wrappers around them.
- **Rationale:** Both functions currently carry independent rate-limit logic that should share core semantics.
- **Acceptance criteria:**
  - RecFn middleware uses shared sliding-window/fixed-window utility.
  - PlugFn token-bucket rate limiter uses shared token-bucket utility.
  - Existing rate-limit tests in both functions remain green.
- **Test vectors:** TV-REUSE-012-P, TV-REUSE-012-N
- **Notes:** Provider-specific rate-limit policy remains in consumer logic.

### ID: DUPL-001

- **Priority:** P1
- **Statement:** `packages/storage-s3`, `packages/storage-r2`, and `packages/storage-minio` MUST share a common S3-compatible core implementation to eliminate duplicated object and multipart logic.
- **Rationale:** Audit shows large high-confidence duplication blocks across these adapters.
- **Acceptance criteria:**
  - Shared internal module encapsulates common S3-compatible operations.
  - Provider-specific files contain only endpoint/credential/capability deltas.
  - Adapter tests for each package continue to pass.
- **Test vectors:** TV-DUPL-001-P, TV-DUPL-001-N
- **Notes:** Public adapter factory signatures should remain stable.

### ID: DUPL-002

- **Priority:** P2
- **Statement:** `packages/storage-azure`, `packages/storage-gcs`, and `packages/storage-local` MUST be refactored to share common validation/error helpers where semantics overlap.
- **Rationale:** Secondary duplication exists in constraints/error mapping and test scaffolding.
- **Acceptance criteria:**
  - Shared helper module(s) introduced in `packages/storage`.
  - Provider adapters consume shared helpers for common validation/error mapping.
  - No functional regressions in provider-specific behavior.
- **Test vectors:** TV-DUPL-002-P, TV-DUPL-002-N
- **Notes:** Provider SDK-specific request construction remains local.

### ID: DUPL-003

- **Priority:** P1
- **Statement:** SearchFn adapter codebase MUST establish a single source of truth between `searchfn/adapters` and split `searchfn/adapter-*` packages.
- **Rationale:** Audit indicates extensive duplicated source and test code across monolith and split packages.
- **Acceptance criteria:**
  - One source path is designated canonical.
  - Non-canonical path is generated, re-exported, or removed.
  - Adapter conformance tests run once against canonical implementation.
- **Test vectors:** TV-DUPL-003-P, TV-DUPL-003-N
- **Notes:** Migration docs must describe package import stability.

### ID: DUPL-004

- **Priority:** P1
- **Statement:** Queue-memory duplicate implementations in RecFn and CIFn MUST be removed after adoption of shared queue package.
- **Rationale:** Near-copy queue code in both functions increases maintenance burden and drift.
- **Acceptance criteria:**
  - Duplicate queue classes are deleted or become no-logic wrappers.
  - Both consumers import shared queue adapter implementation.
  - Queue tests validate no behavior regression.
- **Test vectors:** TV-DUPL-004-P, TV-DUPL-004-N
- **Notes:** Wrapper aliases may remain for API continuity.

### ID: DUPL-005

- **Priority:** P2
- **Statement:** Python schema TypedDict boilerplate duplicated across authfn/secfn MUST be replaced with a shared helper module.
- **Rationale:** Shared schema typing boilerplate is repeated with minimal variation.
- **Acceptance criteria:**
  - Shared Python helper module introduced for schema typing primitives.
  - `authfn/python/authfn/schema.py` and `secfn/python/secfn/schema.py` consume helper types.
  - Python type checks/tests remain green.
- **Test vectors:** TV-DUPL-005-P, TV-DUPL-005-N
- **Notes:** Functional schema data shape must remain unchanged.

### ID: PLAT-001

- **Priority:** P0
- **Statement:** PlugFn database contract MUST bind to `@superfunctions/db` Adapter types (or exact type aliases) instead of standalone ad-hoc interfaces.
- **Rationale:** PlugFn currently declares custom adapter interfaces despite depending on `@superfunctions/db`.
- **Acceptance criteria:**
  - PlugFn config types import and use `@superfunctions/db` types.
  - Type-level compatibility tests enforce contract.
  - CLI init and runtime docs show canonical adapter wiring.
- **Test vectors:** TV-PLAT-001-P, TV-PLAT-001-N
- **Notes:** A compatibility type alias is acceptable during migration.

### ID: PLAT-002

- **Priority:** P0
- **Statement:** AuthFn and PlugFn HTTP exposure MUST remain implemented through `@superfunctions/http` router abstractions with documented adapter usage.
- **Rationale:** Shared HTTP abstraction is a core ecosystem design invariant.
- **Acceptance criteria:**
  - No framework-specific router hard-coding replaces shared router usage.
  - Docs include Express/Fastify/Hono examples for mounting authfn/plugfn routers.
  - Route auth/callback/webhook examples compile.
- **Test vectors:** TV-PLAT-002-P, TV-PLAT-002-N
- **Notes:** Framework adapters remain direct consumer dependencies.

### ID: PLAT-003

- **Priority:** P0
- **Statement:** PlugFn connection selection MUST be deterministic with a stable explicit tiebreaker when timestamps are equal.
- **Rationale:** Existing logic can return ambiguous ordering for identical timestamp records.
- **Acceptance criteria:**
  - Sort order is explicitly defined and documented.
  - Tie cases include connection ID (or equivalent stable field) tiebreaker.
  - Ambiguous selection behavior is tested and deterministic.
- **Test vectors:** TV-PLAT-003-P, TV-PLAT-003-N
- **Notes:** Error behavior for truly ambiguous policies must remain deterministic.

### ID: PLAT-004

- **Priority:** P1
- **Statement:** Every relocated module path introduced by this spec MUST provide deprecation shims and migration notes for one minor release.
- **Rationale:** Large reuse extraction can otherwise create avoidable breaking changes.
- **Acceptance criteria:**
  - Legacy import paths compile with warnings.
  - Migration guide maps old path/function names to new package APIs.
  - Removal target version is documented.
- **Test vectors:** TV-PLAT-004-P, TV-PLAT-004-N
- **Notes:** Shims must not carry duplicated business logic.

### ID: DOCS-001

- **Priority:** P0
- **Statement:** A root `docs/` workspace app MUST be created using Fumadocs and `@superfunctions/docs-theme` shared styling.
- **Rationale:** Shared package documentation currently lacks a single discoverable entry point.
- **Acceptance criteria:**
  - `docs/` app exists with Next.js + Fumadocs configuration.
  - Shared layout/theme tokens are consumed from `@superfunctions/docs-theme`.
  - App is included in root workspace and build scripts.
- **Test vectors:** TV-DOCS-001-P, TV-DOCS-001-N
- **Notes:** Styling should follow existing datafn/searchfn docs conventions.

### ID: DOCS-002

- **Priority:** P0
- **Statement:** Root docs MUST include dedicated pages for every shared package in `packages/*` and `packages/python-*`.
- **Rationale:** User requested full shared package docs coverage, not partial docs.
- **Acceptance criteria:**
  - Navigation includes all shared package entries.
  - Missing-package coverage report fails build.
  - OAuth and reuse-extraction new packages are documented at launch.
- **Test vectors:** TV-DOCS-002-P, TV-DOCS-002-N
- **Notes:** Internal-only workspace tooling packages may be marked internal but still listed.

### ID: DOCS-003

- **Priority:** P0
- **Statement:** Shared package docs MUST be beginner-friendly and external-consumer oriented with elaborative examples.
- **Rationale:** Shared packages are intended for use beyond internal superfunction consumers.
- **Acceptance criteria:**
  - Each package page includes quick-start and production-oriented examples.
  - Examples avoid monorepo-only assumptions.
  - Common pitfalls and troubleshooting are documented.
- **Test vectors:** TV-DOCS-003-P, TV-DOCS-003-N
- **Notes:** “External builder” examples should use npm/pip install and plain app setup.

### ID: DOCS-004

- **Priority:** P1
- **Statement:** Docs code snippets and referenced imports MUST be validated in CI by automated checks.
- **Rationale:** Stale or non-compiling examples degrade onboarding quality.
- **Acceptance criteria:**
  - Docs snippet checks run in CI.
  - Broken links fail CI.
  - Invalid import paths in docs are detected automatically.
- **Test vectors:** TV-DOCS-004-P, TV-DOCS-004-N
- **Notes:** Check implementation can use example test harnesses or markdown code extraction.

### ID: DOCS-005

- **Priority:** P1
- **Statement:** Root docs MUST include architecture pages for OAuth flow, webhook pipeline, envelope/errors, queue/rate-limit, and HTTP/DB integration patterns.
- **Rationale:** Users need system-level understanding beyond isolated API references.
- **Acceptance criteria:**
  - Architecture pages exist and are linked from navigation.
  - Pages include deterministic sequence diagrams/workflows where applicable.
  - Security and operational caveats are explicitly called out.
- **Test vectors:** TV-DOCS-005-P, TV-DOCS-005-N
- **Notes:** Architecture pages should be reusable for both internal and external audiences.

### ID: DOCS-006

- **Priority:** P1
- **Statement:** Root docs MUST include migration guides for recfn/cifn/plugfn/authfn transitions to shared reusable packages.
- **Rationale:** This audit-fix introduces major code movement requiring guided migration.
- **Acceptance criteria:**
  - Migration guide exists for OAuth-flow adoption.
  - Migration guide exists for webhook/envelope/error/queue/rate-limit/config extraction.
  - Guide includes old-to-new API mapping tables.
- **Test vectors:** TV-DOCS-006-P, TV-DOCS-006-N
- **Notes:** Migration guidance must include rollback and compatibility-shim notes.

### ID: OPS-001

- **Priority:** P1
- **Statement:** A duplication guard MUST be added to CI (targeted jscpd thresholds and ignore rules) for shared packages and high-risk consumer modules.
- **Rationale:** Preventing reintroduction of duplicates is necessary after extraction.
- **Acceptance criteria:**
  - CI step runs duplication scan with tuned scope.
  - Threshold violations fail CI.
  - Vendor/build/test fixture noise is excluded.
- **Test vectors:** TV-OPS-001-P, TV-OPS-001-N
- **Notes:** Thresholds should be tuned per directory to avoid false positives.

### ID: OPS-002

- **Priority:** P0
- **Statement:** Release gates MUST validate adoption completion across authfn, plugfn, recfn, cifn, searchfn, and storage adapters before marking this spec complete.
- **Rationale:** Multi-package refactors require explicit readiness checks.
- **Acceptance criteria:**
  - Gate document includes package-by-package checklists and commands.
  - Gate enforces migrated imports and removed duplicate logic.
  - Failing package gates block completion status.
- **Test vectors:** TV-OPS-002-P, TV-OPS-002-N
- **Notes:** Gates should be runnable locally without external CI dependencies.

### ID: OPS-003

- **Priority:** P1
- **Statement:** Changelogs and deprecation notices MUST be added for every affected package with clear migration timelines.
- **Rationale:** Consumers require explicit versioning and removal expectations.
- **Acceptance criteria:**
  - Affected package changelogs include migration notes.
  - Deprecated paths emit warnings with replacement guidance.
  - Removal version target is documented.
- **Test vectors:** TV-OPS-003-P, TV-OPS-003-N
- **Notes:** Include docs links in warning messages where practical.

### ID: OPS-004

- **Priority:** P0
- **Statement:** Turbo workspace configuration and package scripts MUST include all new shared packages and root docs so build/test/lint coverage is complete.
- **Rationale:** New packages/docs are non-viable if not included in standard workspace pipelines.
- **Acceptance criteria:**
  - Workspace definitions include newly added package paths.
  - Build/test/typecheck commands run for new packages and docs app.
  - CI matrix includes docs build and shared package type checks.
- **Test vectors:** TV-OPS-004-P, TV-OPS-004-N
- **Notes:** Avoid introducing nested monorepo patterns.
