# Test Vectors

## OAuth Vectors

### TV-OAUTH-001-P
- **Description:** oauth-testing re-exports shared memory adapters.
- **Input:**
```json
{
  "file": "packages/oauth-testing/src/index.ts",
  "assertions": [
    "imports MemoryOAuthStateStore from @superfunctions/oauth-storage",
    "imports MemoryTokenVault from @superfunctions/oauth-storage"
  ]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "duplicateLocalStoreClasses": 0
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-001-N.

### TV-OAUTH-001-N
- **Description:** duplicate local in-memory store class still exists in oauth-testing.
- **Input:**
```json
{
  "file": "packages/oauth-testing/src/index.ts",
  "contains": "class InMemoryOAuthStateStore"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "DUPLICATE_IMPLEMENTATION",
    "message": "oauth-testing contains local state store implementation"
  }
}
```
- **Negative variant(s) when relevant:** Must fail build gate.

### TV-OAUTH-002-P
- **Description:** oauth-flow package exposes required orchestration API.
- **Input:**
```json
{
  "package": "packages/oauth-flow",
  "exports": ["createOAuthFlowService", "OAuthFlowService"]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "apiSurfaceValid": true
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-002-N.

### TV-OAUTH-002-N
- **Description:** missing callback/refresh/disconnect methods on OAuthFlowService.
- **Input:**
```json
{
  "typecheck": "OAuthFlowService missing handleCallback"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "TYPE_CONTRACT_MISSING",
    "message": "OAuthFlowService incomplete"
  }
}
```
- **Negative variant(s) when relevant:** Typecheck failure is required.

### TV-OAUTH-003-P
- **Description:** start() validates and creates PKCE/state correctly.
- **Input:**
```json
{
  "startInput": {
    "providerId": "google",
    "tenantId": "t1",
    "userId": "u1",
    "redirectUri": "https://app.example/callback"
  }
}
```
- **Expected output:**
```json
{
  "ok": true,
  "result": {
    "authorizationUrlContains": ["state=", "code_challenge=", "code_challenge_method=S256"],
    "statePersisted": true
  }
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-003-N.

### TV-OAUTH-003-N
- **Description:** start() rejects non-allowlisted redirect URI.
- **Input:**
```json
{
  "startInput": {
    "providerId": "google",
    "tenantId": "t1",
    "userId": "u1",
    "redirectUri": "https://evil.example/callback"
  }
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "OAUTH_CALLBACK_MISMATCH",
    "message": "redirect URI not allowed"
  }
}
```
- **Negative variant(s) when relevant:** Reject before state creation.

### TV-OAUTH-004-P
- **Description:** first callback consumes state and stores token.
- **Input:**
```json
{
  "callbackInput": {
    "code": "auth-code-1",
    "state": "st_valid",
    "redirectUri": "https://app.example/callback"
  }
}
```
- **Expected output:**
```json
{
  "ok": true,
  "result": {
    "tokenPersisted": true,
    "stateConsumed": true
  }
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-004-N.

### TV-OAUTH-004-N
- **Description:** second callback with same state is rejected.
- **Input:**
```json
{
  "callbackInput": {
    "code": "auth-code-2",
    "state": "st_valid",
    "redirectUri": "https://app.example/callback"
  }
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "OAUTH_STATE_REPLAYED",
    "message": "OAuth state already consumed"
  }
}
```
- **Negative variant(s) when relevant:** Must be deterministic across storage backends.

### TV-OAUTH-005-P
- **Description:** refresh() keeps prior refresh token if provider omits replacement.
- **Input:**
```json
{
  "existingToken": {"refreshToken": "rt_old"},
  "providerResponse": {"accessToken": "at_new", "refreshToken": null}
}
```
- **Expected output:**
```json
{
  "ok": true,
  "storedToken": {
    "accessToken": "at_new",
    "refreshToken": "rt_old"
  }
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-005-N.

### TV-OAUTH-005-N
- **Description:** refresh failure must not overwrite prior encrypted record.
- **Input:**
```json
{
  "providerResponse": {"error": "invalid_grant"}
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "OAUTH_TOKEN_REFRESH_FAILED"},
  "recordUnchanged": true
}
```
- **Negative variant(s) when relevant:** Must preserve pre-failure token data.

### TV-OAUTH-006-P
- **Description:** disconnect with successful remote revoke returns full cleanup flags.
- **Input:**
```json
{
  "disconnectInput": {"connectionId": "conn_1", "providerId": "google", "revokeRemote": true},
  "remoteRevoke": "200"
}
```
- **Expected output:**
```json
{
  "ok": true,
  "result": {
    "remoteRevokeAttempted": true,
    "localTokenDeleted": true,
    "connectionDeleted": true
  }
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-006-N.

### TV-OAUTH-006-N
- **Description:** disconnect still performs local cleanup when remote revoke fails.
- **Input:**
```json
{
  "disconnectInput": {"connectionId": "conn_1", "providerId": "google", "revokeRemote": true},
  "remoteRevoke": "500"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "INTERNAL_ERROR"},
  "localTokenDeleted": true,
  "connectionDeleted": true
}
```
- **Negative variant(s) when relevant:** Failure must occur after local cleanup.

### TV-OAUTH-007-P
- **Description:** identity hook receives callback context.
- **Input:**
```json
{
  "hooks": ["onConnected"],
  "callback": "valid"
}
```
- **Expected output:**
```json
{
  "ok": true,
  "hookCalled": true,
  "hookPayloadContains": ["providerId", "connectionId", "tenantId", "userId"]
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-007-N.

### TV-OAUTH-007-N
- **Description:** hook exception is wrapped with deterministic error.
- **Input:**
```json
{
  "hooks": {"onConnected": "throw new Error('boom')"}
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "HOOK_FAILED",
    "message": "identity hook failed"
  }
}
```
- **Negative variant(s) when relevant:** Core token persistence must remain atomic.

### TV-OAUTH-008-P
- **Description:** oauth-storage db adapter stores OAuth state/token records in explicit models.
- **Input:**
```json
{
  "adapter": "@superfunctions/db memoryAdapter",
  "operations": ["putState", "consumeState", "putToken", "getTokenByConnection"]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "modelsUsed": ["oauth_states", "oauth_token_vault"]
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-008-N.

### TV-OAUTH-008-N
- **Description:** db adapter init without required models/schema mapping fails deterministically.
- **Input:**
```json
{
  "adapterConfig": {"missingModel": "oauth_states"}
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "SCHEMA_MISSING",
    "message": "oauth_states model mapping required"
  }
}
```
- **Negative variant(s) when relevant:** No partial writes allowed.

### TV-OAUTH-009-P
- **Description:** PlugFn OAuth integration path goes through oauth-flow.
- **Input:**
```json
{
  "file": "plugfn/typescript/src/core/connection-manager.ts",
  "assertions": ["imports createOAuthFlowService", "delegates getAuthUrl/handleCallback/refresh/disconnect"]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "delegationVerified": true
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-009-N.

### TV-OAUTH-009-N
- **Description:** duplicated local flow implementation remains in connection manager.
- **Input:**
```json
{
  "grep": ["createDynamicOAuthProviderMap", "mapTokenEndpointResponse"],
  "file": "plugfn/typescript/src/core/connection-manager.ts"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "DUPLICATE_FLOW_LOGIC_PRESENT"}
}
```
- **Negative variant(s) when relevant:** Build gate should fail on duplicated orchestration signatures.

### TV-OAUTH-010-P
- **Description:** PlugFn legacy oauth-flow.ts is wrapper-only.
- **Input:**
```json
{
  "file": "plugfn/typescript/src/auth/oauth-flow.ts"
}
```
- **Expected output:**
```json
{
  "ok": true,
  "containsBusinessLogic": false,
  "containsDeprecationNotice": true
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-010-N.

### TV-OAUTH-010-N
- **Description:** legacy wrapper still defaults to memory store and local exchange internals.
- **Input:**
```json
{
  "file": "plugfn/typescript/src/auth/oauth-flow.ts",
  "contains": ["new MemoryOAuthStateStore", "createOAuthService"]
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "NON_WRAPPER_LEGACY_MODULE"}
}
```
- **Negative variant(s) when relevant:** Fail migration gate.

### TV-OAUTH-011-P
- **Description:** authfn social OAuth behavior preserved after oauth-flow migration.
- **Input:**
```json
{
  "suite": "authfn/ts-sdk/tests/social-oauth.test.ts"
}
```
- **Expected output:**
```json
{
  "ok": true,
  "testsPassed": true
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-011-N.

### TV-OAUTH-011-N
- **Description:** authfn migration breaks public method behavior.
- **Input:**
```json
{
  "call": "createLoginUrl/handleCallback/disconnect",
  "expectedBehavior": "legacy-compatible"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "PUBLIC_API_REGRESSION"}
}
```
- **Negative variant(s) when relevant:** Must block release.

### TV-OAUTH-012-P
- **Description:** recfn calendar refresh uses shared OAuth storage/flow path.
- **Input:**
```json
{
  "files": [
    "recfn/server/src/calendar/token-store.ts",
    "recfn/server/src/calendar/token-refresh.ts"
  ],
  "assertions": ["imports @superfunctions/oauth-storage", "imports @superfunctions/oauth-flow or oauth-http"]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "sharedOAuthUsed": true
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-012-N.

### TV-OAUTH-012-N
- **Description:** recfn retains standalone CalendarTokenStore and TokenRefreshProvider types.
- **Input:**
```json
{
  "grep": ["interface CalendarTokenStore", "interface TokenRefreshProvider"],
  "scope": "recfn/server/src/calendar"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "SHARED_OAUTH_NOT_ADOPTED"}
}
```
- **Negative variant(s) when relevant:** Migration incomplete.

### TV-OAUTH-013-P
- **Description:** OAuth flow emits standardized telemetry events.
- **Input:**
```json
{
  "operations": ["start", "handleCallback", "refresh", "disconnect"]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "events": [
    "oauth.flow.started",
    "oauth.flow.callback.success",
    "oauth.flow.refresh.success",
    "oauth.flow.disconnect.success"
  ]
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-013-N.

### TV-OAUTH-013-N
- **Description:** OAuth error metadata omits status/retryable fields.
- **Input:**
```json
{
  "errorEnvelope": {"code": "OAUTH_TOKEN_REFRESH_FAILED", "message": "x"}
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "INVALID_ERROR_SHAPE"}
}
```
- **Negative variant(s) when relevant:** Must fail envelope contract test.

### TV-OAUTH-014-P
- **Description:** root docs include all OAuth shared package pages.
- **Input:**
```json
{
  "docsNav": ["oauth-core", "oauth-http", "oauth-storage", "oauth-providers", "oauth-testing", "oauth-flow"]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "missingPages": []
}
```
- **Negative variant(s) when relevant:** Covered by TV-OAUTH-014-N.

### TV-OAUTH-014-N
- **Description:** one or more OAuth package docs pages missing.
- **Input:**
```json
{
  "docsCoverageCheck": "oauth-shared-pages"
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {"code": "DOCS_COVERAGE_INCOMPLETE"}
}
```
- **Negative variant(s) when relevant:** Build should fail.

## Reuse Vectors

### TV-REUSE-001-P
- **Description:** shared webhooks package exports sign/verify/deliver.
- **Input:**
```json
{"package": "packages/webhooks", "exports": ["signWebhookPayload", "verifyWebhookSignature", "deliverWebhook"]}
```
- **Expected output:**
```json
{"ok": true}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-001-N.

### TV-REUSE-001-N
- **Description:** verify function is not timing-safe.
- **Input:**
```json
{"implementationCheck": "no timingSafeEqual equivalent"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "INSECURE_SIGNATURE_VERIFY"}}
```
- **Negative variant(s) when relevant:** Security gate fail.

### TV-REUSE-002-P
- **Description:** recfn/cifn webhook code imports shared package.
- **Input:**
```json
{"grepPaths": ["recfn/server/src", "cifn/typescript/control-plane/src"], "import": "@superfunctions/webhooks"}
```
- **Expected output:**
```json
{"ok": true, "localSignImplementations": 0}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-002-N.

### TV-REUSE-002-N
- **Description:** local webhook sign implementation still present.
- **Input:**
```json
{"file": "recfn/server/src/webhooks/sign.ts", "contains": "createHmac"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "DUPLICATE_WEBHOOK_SIGNING"}}
```
- **Negative variant(s) when relevant:** Migration incomplete.

### TV-REUSE-003-P
- **Description:** envelope package returns canonical ok/data/meta shape.
- **Input:**
```json
{"call": "ok({\"x\":1})"}
```
- **Expected output:**
```json
{"ok": true, "data": {"x": 1}, "meta": {"timestamp": "ISO8601"}}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-003-N.

### TV-REUSE-003-N
- **Description:** envelope error missing retryable field.
- **Input:**
```json
{"call": "err({\"code\":\"BAD_REQUEST\",\"message\":\"x\",\"status\":400})"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "INVALID_ENVELOPE_ERROR_SHAPE"}}
```
- **Negative variant(s) when relevant:** Contract must fail.

### TV-REUSE-004-P
- **Description:** errors package resolves code metadata.
- **Input:**
```json
{"registry": [{"code": "RATE_LIMIT_EXCEEDED", "httpStatus": 429, "retryable": true}], "lookup": "RATE_LIMIT_EXCEEDED"}
```
- **Expected output:**
```json
{"ok": true, "result": {"httpStatus": 429, "retryable": true}}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-004-N.

### TV-REUSE-004-N
- **Description:** unknown code without default mapping.
- **Input:**
```json
{"lookup": "UNKNOWN_CODE"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "ERROR_CODE_UNREGISTERED"}}
```
- **Negative variant(s) when relevant:** Deterministic fallback required.

### TV-REUSE-005-P
- **Description:** recfn/cifn/cmsfn compile using shared envelope/errors adapters.
- **Input:**
```json
{"packages": ["recfn/server", "cifn/typescript/control-plane", "cmsfn/core"], "task": "typecheck"}
```
- **Expected output:**
```json
{"ok": true, "typecheck": "passed"}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-005-N.

### TV-REUSE-005-N
- **Description:** local envelope modules still define standalone canonical types.
- **Input:**
```json
{"grep": ["export function ok", "export function err"], "scope": ["recfn/server/src/middleware/envelope.ts", "cifn/typescript/control-plane/src/api/envelope.ts"]}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "ENVELOPE_DUPLICATION_REMAINS"}}
```
- **Negative variant(s) when relevant:** Wrapper-only allowance if delegating.

### TV-REUSE-006-P
- **Description:** shared queue package memory adapter is FIFO.
- **Input:**
```json
{"queue": "q", "ops": ["enqueue:a", "enqueue:b", "dequeue", "dequeue"]}
```
- **Expected output:**
```json
{"ok": true, "dequeued": ["a", "b"]}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-006-N.

### TV-REUSE-006-N
- **Description:** dequeue from empty queue should return null, not throw.
- **Input:**
```json
{"queue": "empty", "ops": ["dequeue"]}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "QUEUE_EMPTY_BEHAVIOR_INVALID"}}
```
- **Negative variant(s) when relevant:** Contract expects null.

### TV-REUSE-007-P
- **Description:** recfn/cifn import shared queue adapter.
- **Input:**
```json
{"grepImport": "@superfunctions/queue", "paths": ["recfn/server/src", "cifn/typescript/control-plane/src"]}
```
- **Expected output:**
```json
{"ok": true, "localMemoryQueueClassCount": 0}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-007-N.

### TV-REUSE-007-N
- **Description:** local MemoryQueueAdapter remains non-wrapper.
- **Input:**
```json
{"contains": "class MemoryQueueAdapter", "paths": ["recfn/server/src/integrations/flowfn.ts", "cifn/typescript/control-plane/src/integrations/flowfn.ts"]}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "QUEUE_DUPLICATION_REMAINS"}}
```
- **Negative variant(s) when relevant:** Must fail duplication gate.

### TV-REUSE-008-P
- **Description:** metrics package creates no-op and namespaced emitter.
- **Input:**
```json
{"calls": ["createMetricsEmitter()", "createNamespacedEmitter('recfn', emitter)"]}
```
- **Expected output:**
```json
{"ok": true, "noThrow": true, "namespacedEvent": "recfn.event"}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-008-N.

### TV-REUSE-008-N
- **Description:** namespaced emitter mutates original event names incorrectly.
- **Input:**
```json
{"event": "api.request", "namespace": "recfn"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "METRIC_NAMESPACE_INVALID"}}
```
- **Negative variant(s) when relevant:** Must preserve deterministic prefixing.

### TV-REUSE-009-P
- **Description:** config helper reads bounded integer env values.
- **Input:**
```json
{"env": {"RECFN_RATE_LIMIT_WINDOW_MS": "2000"}, "spec": {"key": "RECFN_RATE_LIMIT_WINDOW_MS", "defaultValue": 1000, "min": 100}}
```
- **Expected output:**
```json
{"ok": true, "value": 2000}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-009-N.

### TV-REUSE-009-N
- **Description:** invalid integer env falls outside bounds and should fail or fallback deterministically.
- **Input:**
```json
{"env": {"RECFN_RATE_LIMIT_WINDOW_MS": "-1"}, "spec": {"key": "RECFN_RATE_LIMIT_WINDOW_MS", "defaultValue": 1000, "min": 100}}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "ENV_VALUE_OUT_OF_RANGE"}}
```
- **Negative variant(s) when relevant:** If fallback mode chosen, expected value must equal documented default.

### TV-REUSE-010-P
- **Description:** bearer extraction utility parses valid header.
- **Input:**
```json
{"headers": {"Authorization": "Bearer api-key-123"}}
```
- **Expected output:**
```json
{"ok": true, "token": "api-key-123"}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-010-N.

### TV-REUSE-010-N
- **Description:** malformed bearer header returns null and middleware rejects.
- **Input:**
```json
{"headers": {"Authorization": "Basic abc"}}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "UNAUTHORIZED", "message": "Missing or invalid Authorization header"}}
```
- **Negative variant(s) when relevant:** Must not throw parsing exception.

### TV-REUSE-011-P
- **Description:** rate limiter executes sliding-window and token-bucket according to algorithm setting.
- **Input:**
```json
{"algorithm": "sliding-window", "requests": 5, "windowMs": 1000, "sequence": [0,100,200,300,400,500]}
```
- **Expected output:**
```json
{"ok": true, "behaviorMatches": "sliding-window"}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-011-N.

### TV-REUSE-011-N
- **Description:** algorithm flag ignored (all algorithms behave fixed-window).
- **Input:**
```json
{"algorithm": "token-bucket", "sameTrafficAsFixedWindow": true}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "ALGORITHM_FLAG_IGNORED"}}
```
- **Negative variant(s) when relevant:** Must fail contract tests.

### TV-REUSE-012-P
- **Description:** recfn and plugfn rate-limit paths import shared rate limiter.
- **Input:**
```json
{"grepImport": ["@superfunctions/rate-limit", "@superfunctions/middleware"], "paths": ["recfn/server/src/middleware/rate-limit.ts", "plugfn/typescript/src/middleware/rate-limiter.ts"]}
```
- **Expected output:**
```json
{"ok": true, "sharedCoreUsed": true}
```
- **Negative variant(s) when relevant:** Covered by TV-REUSE-012-N.

### TV-REUSE-012-N
- **Description:** plugfn still ships independent token bucket code path.
- **Input:**
```json
{"file": "plugfn/typescript/src/middleware/rate-limiter.ts", "contains": "class RateLimiter"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "RATE_LIMIT_DUPLICATION_REMAINS"}}
```
- **Negative variant(s) when relevant:** Wrapper-only allowed if delegating shared core.

## Duplication Vectors

### TV-DUPL-001-P
- **Description:** storage s3/r2/minio share common core module.
- **Input:**
```json
{"files": ["packages/storage-s3/src/adapter.ts", "packages/storage-r2/src/adapter.ts", "packages/storage-minio/src/adapter.ts"], "assertImport": "from @superfunctions/storage/internal/s3-compatible"}
```
- **Expected output:**
```json
{"ok": true, "duplicationReduced": true}
```
- **Negative variant(s) when relevant:** Covered by TV-DUPL-001-N.

### TV-DUPL-001-N
- **Description:** >100-line duplication remains between storage adapters.
- **Input:**
```json
{"jscpdPair": ["packages/storage-r2/src/adapter.ts", "packages/storage-s3/src/adapter.ts"], "minLines": 100}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "HIGH_DUPLICATION_REMAINS"}}
```
- **Negative variant(s) when relevant:** Release gate fail.

### TV-DUPL-002-P
- **Description:** azure/gcs/local share validation helpers.
- **Input:**
```json
{"assertions": ["shared validation helper imported", "shared error mapping helper imported"]}
```
- **Expected output:**
```json
{"ok": true}
```
- **Negative variant(s) when relevant:** Covered by TV-DUPL-002-N.

### TV-DUPL-002-N
- **Description:** each provider keeps independent duplicated validation blocks.
- **Input:**
```json
{"jscpdScope": "packages/storage-azure|storage-gcs|storage-local", "threshold": "exceeded"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "STORAGE_VALIDATION_DUPLICATION"}}
```
- **Negative variant(s) when relevant:** Must fail duplication threshold.

### TV-DUPL-003-P
- **Description:** searchfn adapter canonical source selected and non-canonical path re-exported/generated.
- **Input:**
```json
{"check": "single-source-policy", "paths": ["searchfn/adapters", "searchfn/adapter-*"]}
```
- **Expected output:**
```json
{"ok": true, "canonicalPath": "declared"}
```
- **Negative variant(s) when relevant:** Covered by TV-DUPL-003-N.

### TV-DUPL-003-N
- **Description:** duplicated source files remain editable in both canonical and compatibility paths.
- **Input:**
```json
{"jscpdPair": ["searchfn/adapter-indexeddb/src/index.ts", "searchfn/adapters/src/indexeddb.ts"], "minLines": 200}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "SEARCHFN_CANONICAL_SOURCE_NOT_ENFORCED"}}
```
- **Negative variant(s) when relevant:** Must block release.

### TV-DUPL-004-P
- **Description:** queue duplication removed from recfn/cifn.
- **Input:**
```json
{"grep": "class MemoryQueueAdapter", "paths": ["recfn/server/src", "cifn/typescript/control-plane/src"]}
```
- **Expected output:**
```json
{"ok": true, "matches": 0}
```
- **Negative variant(s) when relevant:** Covered by TV-DUPL-004-N.

### TV-DUPL-004-N
- **Description:** queue class still appears in both recfn and cifn.
- **Input:**
```json
{"grep": "class MemoryQueueAdapter", "paths": ["recfn/server/src/integrations/flowfn.ts", "cifn/typescript/control-plane/src/integrations/flowfn.ts"]}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "QUEUE_MEMORY_DUPLICATE"}}
```
- **Negative variant(s) when relevant:** Must fail duplication gate.

### TV-DUPL-005-P
- **Description:** authfn/secfn Python schema modules use shared schema helper.
- **Input:**
```json
{"files": ["authfn/python/authfn/schema.py", "secfn/python/secfn/schema.py"], "assertImport": "from superfunctions_schema_helpers import"}
```
- **Expected output:**
```json
{"ok": true}
```
- **Negative variant(s) when relevant:** Covered by TV-DUPL-005-N.

### TV-DUPL-005-N
- **Description:** duplicated TypedDict blocks still present in both schema files.
- **Input:**
```json
{"jscpdPair": ["authfn/python/authfn/schema.py", "secfn/python/secfn/schema.py"], "minLines": 40}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "PY_SCHEMA_HELPER_NOT_ADOPTED"}}
```
- **Negative variant(s) when relevant:** Fails dedupe check.

## Platform Vectors

### TV-PLAT-001-P
- **Description:** plugfn types compile against `@superfunctions/db` adapter contract.
- **Input:**
```json
{"typecheckTarget": "plugfn/typescript", "assertions": ["types/config.ts imports @superfunctions/db Adapter"]}
```
- **Expected output:**
```json
{"ok": true}
```
- **Negative variant(s) when relevant:** Covered by TV-PLAT-001-N.

### TV-PLAT-001-N
- **Description:** plugfn still defines standalone adapter contract.
- **Input:**
```json
{"file": "plugfn/typescript/src/types/config.ts", "contains": "export interface Adapter"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "PLUGFN_DB_CONTRACT_DRIFT"}}
```
- **Negative variant(s) when relevant:** Must fail contract gate.

### TV-PLAT-002-P
- **Description:** authfn/plugfn routers mount with @superfunctions/http adapters.
- **Input:**
```json
{"docsExamples": ["express", "fastify", "hono"], "imports": ["@superfunctions/http", "@superfunctions/http-express"]}
```
- **Expected output:**
```json
{"ok": true, "examplesCompile": true}
```
- **Negative variant(s) when relevant:** Covered by TV-PLAT-002-N.

### TV-PLAT-002-N
- **Description:** router docs/example uses framework-specific direct APIs only.
- **Input:**
```json
{"docsSnippet": "app.get('/callback', ...) // no superfunctions router"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "HTTP_ABSTRACTION_BYPASSED"}}
```
- **Negative variant(s) when relevant:** Docs lint fails.

### TV-PLAT-003-P
- **Description:** plugfn connection selection tie-break is deterministic.
- **Input:**
```json
{"connections": [{"id":"c2","lastUsedAt":"same","connectedAt":"same","createdAt":"same"},{"id":"c1","lastUsedAt":"same","connectedAt":"same","createdAt":"same"}]}
```
- **Expected output:**
```json
{"ok": true, "selected": "c1"}
```
- **Negative variant(s) when relevant:** Covered by TV-PLAT-003-N.

### TV-PLAT-003-N
- **Description:** ambiguous tie returns non-deterministic connection.
- **Input:**
```json
{"repeatRuns": 20, "sameInput": true}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "NON_DETERMINISTIC_CONNECTION_SELECTION"}}
```
- **Negative variant(s) when relevant:** Must fail deterministic test.

### TV-PLAT-004-P
- **Description:** legacy module path resolves and warns.
- **Input:**
```json
{"import": "plugfn/auth/oauth-flow", "runtime": "node"}
```
- **Expected output:**
```json
{"ok": true, "warning": "DEPRECATED_PATH", "replacement": "@superfunctions/oauth-flow"}
```
- **Negative variant(s) when relevant:** Covered by TV-PLAT-004-N.

### TV-PLAT-004-N
- **Description:** legacy import removed without migration notice.
- **Input:**
```json
{"import": "plugfn/auth/oauth-flow", "expect": "compat"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "MIGRATION_SHIM_MISSING"}}
```
- **Negative variant(s) when relevant:** Release blocked.

## Docs Vectors

### TV-DOCS-001-P
- **Description:** root docs app boots and builds.
- **Input:**
```json
{"command": "npm -w docs run build"}
```
- **Expected output:**
```json
{"ok": true, "exitCode": 0}
```
- **Negative variant(s) when relevant:** Covered by TV-DOCS-001-N.

### TV-DOCS-001-N
- **Description:** docs workspace missing from root workspaces.
- **Input:**
```json
{"file": "package.json", "assert": "workspaces contains docs"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "DOCS_WORKSPACE_NOT_REGISTERED"}}
```
- **Negative variant(s) when relevant:** Must fail workspace check.

### TV-DOCS-002-P
- **Description:** all shared package pages exist in docs tree.
- **Input:**
```json
{"coverageScript": "docs/scripts/check-shared-package-coverage.mjs"}
```
- **Expected output:**
```json
{"ok": true, "undocumented": []}
```
- **Negative variant(s) when relevant:** Covered by TV-DOCS-002-N.

### TV-DOCS-002-N
- **Description:** missing docs page for one shared package.
- **Input:**
```json
{"missing": "@superfunctions/middleware"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "SHARED_PACKAGE_PAGE_MISSING"}}
```
- **Negative variant(s) when relevant:** Coverage script fails.

### TV-DOCS-003-P
- **Description:** package page includes beginner quick-start + production example + troubleshooting.
- **Input:**
```json
{"page": "docs/content/docs/shared/http.mdx"}
```
- **Expected output:**
```json
{"ok": true, "sectionsPresent": ["Quick Start", "Production Example", "Troubleshooting"]}
```
- **Negative variant(s) when relevant:** Covered by TV-DOCS-003-N.

### TV-DOCS-003-N
- **Description:** docs page assumes monorepo-only usage and lacks external install instructions.
- **Input:**
```json
{"page": "docs/content/docs/shared/db.mdx", "missing": "npm install @superfunctions/db"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "EXTERNAL_CONSUMER_GUIDE_MISSING"}}
```
- **Negative variant(s) when relevant:** Docs lint fails.

### TV-DOCS-004-P
- **Description:** docs snippet and link validation passes.
- **Input:**
```json
{"commands": ["npm -w docs run check:snippets", "npm -w docs run check:links"]}
```
- **Expected output:**
```json
{"ok": true, "allChecks": "passed"}
```
- **Negative variant(s) when relevant:** Covered by TV-DOCS-004-N.

### TV-DOCS-004-N
- **Description:** broken import/link in docs snippet.
- **Input:**
```json
{"snippet": "import { missing } from '@superfunctions/oauth-flow'"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "DOCS_SNIPPET_INVALID"}}
```
- **Negative variant(s) when relevant:** Build fails.

### TV-DOCS-005-P
- **Description:** required architecture docs pages exist and linked.
- **Input:**
```json
{"requiredPages": ["oauth-flow-architecture", "webhooks-architecture", "envelope-errors", "queue-rate-limit", "http-db-integration"]}
```
- **Expected output:**
```json
{"ok": true, "missing": []}
```
- **Negative variant(s) when relevant:** Covered by TV-DOCS-005-N.

### TV-DOCS-005-N
- **Description:** architecture page missing from nav.
- **Input:**
```json
{"missingInNav": "queue-rate-limit"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "ARCH_DOC_NAV_GAP"}}
```
- **Negative variant(s) when relevant:** Fail docs nav check.

### TV-DOCS-006-P
- **Description:** migration docs include old-to-new API mapping table.
- **Input:**
```json
{"page": "docs/content/docs/migrations/oauth-flow.mdx"}
```
- **Expected output:**
```json
{"ok": true, "contains": ["Old API", "New API", "Compatibility Window"]}
```
- **Negative variant(s) when relevant:** Covered by TV-DOCS-006-N.

### TV-DOCS-006-N
- **Description:** migration page exists without rollback guidance.
- **Input:**
```json
{"page": "docs/content/docs/migrations/reuse-extraction.mdx", "missing": "Rollback"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "MIGRATION_ROLLBACK_GUIDE_MISSING"}}
```
- **Negative variant(s) when relevant:** Migration gate fails.

## Ops Vectors

### TV-OPS-001-P
- **Description:** duplication guard passes under threshold.
- **Input:**
```json
{"command": "npm run check:duplication"}
```
- **Expected output:**
```json
{"ok": true, "thresholdExceeded": false}
```
- **Negative variant(s) when relevant:** Covered by TV-OPS-001-N.

### TV-OPS-001-N
- **Description:** targeted duplication threshold exceeded.
- **Input:**
```json
{"jscpd": {"pair": ["recfn/server/src/integrations/flowfn.ts", "cifn/typescript/control-plane/src/integrations/flowfn.ts"], "lines": 16}}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "DUPLICATION_GATE_FAILED"}}
```
- **Negative variant(s) when relevant:** CI must fail.

### TV-OPS-002-P
- **Description:** release gate checklist passes across all targeted packages.
- **Input:**
```json
{"command": "npm run gate:audit-fix-o4u9k2m7"}
```
- **Expected output:**
```json
{"ok": true, "packagesPassed": ["authfn", "plugfn", "recfn", "cifn", "searchfn", "packages/storage*"]}
```
- **Negative variant(s) when relevant:** Covered by TV-OPS-002-N.

### TV-OPS-002-N
- **Description:** one package still uses duplicate local module.
- **Input:**
```json
{"gateFinding": "recfn still imports local envelope helper"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "RELEASE_GATE_BLOCKED"}}
```
- **Negative variant(s) when relevant:** Completion disallowed.

### TV-OPS-003-P
- **Description:** affected packages include changelog and deprecation notes.
- **Input:**
```json
{"packages": ["oauth-testing", "oauth-flow", "plugfn", "recfn", "cifn"], "check": "CHANGELOG includes migration"}
```
- **Expected output:**
```json
{"ok": true}
```
- **Negative variant(s) when relevant:** Covered by TV-OPS-003-N.

### TV-OPS-003-N
- **Description:** package release has breaking move without deprecation warning.
- **Input:**
```json
{"package": "plugfn", "missing": "deprecation warning for auth/oauth-flow path"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "DEPRECATION_NOTICE_MISSING"}}
```
- **Negative variant(s) when relevant:** Release gate fail.

### TV-OPS-004-P
- **Description:** turbo build/test includes new packages and docs workspace.
- **Input:**
```json
{"commands": ["turbo run build --filter=@superfunctions/oauth-flow", "turbo run build --filter=docs"]}
```
- **Expected output:**
```json
{"ok": true, "allTasksIncluded": true}
```
- **Negative variant(s) when relevant:** Covered by TV-OPS-004-N.

### TV-OPS-004-N
- **Description:** new package omitted from workspace scripts/pipeline.
- **Input:**
```json
{"missingFilter": "@superfunctions/oauth-flow"}
```
- **Expected output:**
```json
{"ok": false, "error": {"code": "WORKSPACE_PIPELINE_GAP"}}
```
- **Negative variant(s) when relevant:** CI fails.
