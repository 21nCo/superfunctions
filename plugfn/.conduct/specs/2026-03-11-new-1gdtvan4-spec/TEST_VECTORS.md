# Test Vectors

## TV-ARCH-PACKAGES-POS

- **Vector ID**: TV-ARCH-PACKAGES-POS
- **Description**: Shared OAuth package set exists and builds.
- **Input**:
```bash
npm run build --workspace @superfunctions/oauth-core
npm run build --workspace @superfunctions/oauth-http
npm run build --workspace @superfunctions/oauth-storage
npm run build --workspace @superfunctions/oauth-providers
npm run build --workspace @superfunctions/oauth-testing
```
- **Expected output**:
```json
{"ok":true,"built":["oauth-core","oauth-http","oauth-storage","oauth-providers","oauth-testing"]}
```
- **Negative variant(s)**:
  - Missing workspace package returns `ERR_WORKSPACE_NOT_FOUND` with message containing package name.

## TV-ARCH-PACKAGES-NEG

- **Vector ID**: TV-ARCH-PACKAGES-NEG
- **Description**: Missing shared package is detected.
- **Input**:
```bash
rm -rf packages/oauth-storage && npm run build --workspace @superfunctions/oauth-storage
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"ERR_WORKSPACE_NOT_FOUND","message":"workspace @superfunctions/oauth-storage not found"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-ARCH-SHARED-USE-POS

- **Vector ID**: TV-ARCH-SHARED-USE-POS
- **Description**: `plugfn` uses shared OAuth packages only.
- **Input**:
```bash
rg -n "from '@superfunctions/oauth-" plugfn/typescript/src
rg -n "from '../auth/oauth-flow|MemoryTokenStore" plugfn/typescript/src/core plugfn/typescript/src/auth
```
- **Expected output**:
```json
{"ok":true,"sharedImports":">0","legacyOAuthCoreLogic":"0_matches"}
```
- **Negative variant(s)**:
  - Legacy direct OAuth implementation imports return `ERR_LEGACY_OAUTH_DUPLICATION`.

## TV-ARCH-SHARED-USE-NEG

- **Vector ID**: TV-ARCH-SHARED-USE-NEG
- **Description**: Duplicate OAuth logic in `plugfn` is blocked.
- **Input**:
```bash
# re-introduce custom oauth exchange logic in plugfn/typescript/src/auth/oauth-flow.ts
npm run test --workspace plugfn
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"ERR_LEGACY_OAUTH_DUPLICATION","message":"plugfn must use shared oauth packages"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-ARCH-ADAPTERS-POS

- **Vector ID**: TV-ARCH-ADAPTERS-POS
- **Description**: Required email adapters are registered.
- **Input**:
```ts
const names = plug.providers.list().map(p => p.name).sort();
```
- **Expected output**:
```json
{"ok":true,"providers":["forwarding","gmail","icloud","imap-smtp","managed-mail","outlook","yahoo"]}
```
- **Negative variant(s)**:
  - Missing provider returns `PROVIDER_NOT_FOUND` when executing adapter action.

## TV-ARCH-ADAPTERS-NEG

- **Vector ID**: TV-ARCH-ADAPTERS-NEG
- **Description**: Missing adapter registration fails deterministically.
- **Input**:
```ts
await plug.gmail["mail.sync"]({tenantId:"t1",userId:"u1",params:{}});
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_NOT_FOUND","message":"Provider gmail not found"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-ARCH-MODEL-POS

- **Vector ID**: TV-ARCH-MODEL-POS
- **Description**: Gmail and Outlook messages normalize to one schema.
- **Input**:
```json
{
  "gmailMessage": {"id":"g1","threadId":"gt1","payload":{"headers":[]}},
  "graphMessage": {"id":"m1","conversationId":"ct1","internetMessageHeaders":[]}
}
```
- **Expected output**:
```json
{
  "ok": true,
  "normalized": [
    {"providerMessageId":"g1","threadId":"gt1","hasAttachments":false},
    {"providerMessageId":"m1","threadId":"ct1","hasAttachments":false}
  ]
}
```
- **Negative variant(s)**:
  - Missing required normalized field returns `VALIDATION_ERROR` with `field=providerMessageId`.

## TV-ARCH-MODEL-NEG

- **Vector ID**: TV-ARCH-MODEL-NEG
- **Description**: Invalid normalized message is rejected.
- **Input**:
```json
{"providerMessageId":"","receivedAt":"not-a-date"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"invalid normalized mail message"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-AUTHURL-POS

- **Vector ID**: TV-OAUTH-AUTHURL-POS
- **Description**: Auth URL includes state and PKCE challenge.
- **Input**:
```json
{"providerId":"google","tenantId":"t1","userId":"u1","redirectUri":"https://app/callback"}
```
- **Expected output**:
```json
{"ok":true,"data":{"authorizationUrl":"https://...&state=...&code_challenge=...&code_challenge_method=S256","stateId":"st_..."}}
```
- **Negative variant(s)**:
  - Unsupported redirect URI returns `OAUTH_CALLBACK_MISMATCH`.

## TV-OAUTH-AUTHURL-NEG

- **Vector ID**: TV-OAUTH-AUTHURL-NEG
- **Description**: Non-allowlisted redirect URI is rejected.
- **Input**:
```json
{"providerId":"google","tenantId":"t1","userId":"u1","redirectUri":"https://evil.example/cb"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"OAUTH_CALLBACK_MISMATCH","message":"redirect URI not allowed"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-STATESTORE-POS

- **Vector ID**: TV-OAUTH-STATESTORE-POS
- **Description**: State survives restart and is consumable once.
- **Input**:
```json
{"op":"createStateThenCallbackAfterProcessRestart","stateId":"st_123"}
```
- **Expected output**:
```json
{"ok":true,"stateRecovered":true,"consumed":true}
```
- **Negative variant(s)**:
  - Expired state returns `OAUTH_STATE_INVALID`.

## TV-OAUTH-STATESTORE-NEG

- **Vector ID**: TV-OAUTH-STATESTORE-NEG
- **Description**: Expired state cannot be consumed.
- **Input**:
```json
{"stateId":"st_expired","now":"after_expiresAt"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"OAUTH_STATE_INVALID","message":"OAuth state is invalid or expired"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-CALLBACK-POS

- **Vector ID**: TV-OAUTH-CALLBACK-POS
- **Description**: Valid callback exchanges code and persists encrypted tokens.
- **Input**:
```json
{"provider":"google","code":"valid-code","state":"st_123","redirectUri":"https://app/callback"}
```
- **Expected output**:
```json
{"ok":true,"data":{"connectionId":"conn_...","tokenPersistedEncrypted":true}}
```
- **Negative variant(s)**:
  - Reused state returns `OAUTH_STATE_REPLAYED`.

## TV-OAUTH-CALLBACK-NEG

- **Vector ID**: TV-OAUTH-CALLBACK-NEG
- **Description**: Replayed callback is blocked.
- **Input**:
```json
{"provider":"google","code":"valid-code","state":"st_123","redirectUri":"https://app/callback","repeat":true}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"OAUTH_STATE_REPLAYED","message":"OAuth state already consumed"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-TOKEN-POS

- **Vector ID**: TV-OAUTH-TOKEN-POS
- **Description**: Token exchange supports provider auth method and content format.
- **Input**:
```json
{"provider":"github","tokenAuthMethod":"client_secret_post","contentType":"application/x-www-form-urlencoded"}
```
- **Expected output**:
```json
{"ok":true,"data":{"accessToken":"...","tokenType":"bearer"}}
```
- **Negative variant(s)**:
  - Unsupported token auth method returns `VALIDATION_ERROR`.

## TV-OAUTH-TOKEN-NEG

- **Vector ID**: TV-OAUTH-TOKEN-NEG
- **Description**: Unsupported provider token auth method fails.
- **Input**:
```json
{"provider":"x","tokenAuthMethod":"private_key_jwt"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"unsupported token auth method"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-VAULT-POS

- **Vector ID**: TV-OAUTH-VAULT-POS
- **Description**: Token vault persists only encrypted payload with key reference.
- **Input**:
```json
{"accessToken":"at","refreshToken":"rt","keyRef":"kms-key-1"}
```
- **Expected output**:
```json
{"ok":true,"stored":{"encryptedPayload":"<ciphertext>","keyRef":"kms-key-1"},"plaintextStored":false}
```
- **Negative variant(s)**:
  - Decrypt with wrong key returns `INTERNAL_ERROR` (or typed crypto error).

## TV-OAUTH-VAULT-NEG

- **Vector ID**: TV-OAUTH-VAULT-NEG
- **Description**: Missing key reference blocks token persistence.
- **Input**:
```json
{"accessToken":"at","refreshToken":"rt","keyRef":null}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"keyRef is required"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-SCOPES-POS

- **Vector ID**: TV-OAUTH-SCOPES-POS
- **Description**: Allowed feature scope map is accepted and recorded.
- **Input**:
```json
{"provider":"google","feature":"mail.read.metadata","requestedScopes":["https://www.googleapis.com/auth/gmail.readonly"]}
```
- **Expected output**:
```json
{"ok":true,"data":{"authorized":true,"consentRecord":{"scopes":["https://www.googleapis.com/auth/gmail.readonly"]}}}
```
- **Negative variant(s)**:
  - Over-scoped request returns `OAUTH_SCOPE_DISALLOWED`.

## TV-OAUTH-SCOPES-NEG

- **Vector ID**: TV-OAUTH-SCOPES-NEG
- **Description**: Disallowed scope request is rejected.
- **Input**:
```json
{"provider":"google","feature":"mail.read.metadata","requestedScopes":["https://mail.google.com/"]}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"OAUTH_SCOPE_DISALLOWED","message":"requested scope not allowed for feature"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-AUTHFN-POS

- **Vector ID**: TV-OAUTH-AUTHFN-POS
- **Description**: `authfn` social login uses shared OAuth service.
- **Input**:
```bash
rg -n "@superfunctions/oauth-core|@superfunctions/oauth-http|@superfunctions/oauth-storage" authfn/ts-sdk/src
```
- **Expected output**:
```json
{"ok":true,"sharedOAuthImportsFound":true,"localDuplicatedOAuthCore":false}
```
- **Negative variant(s)**:
  - Local duplicate OAuth implementation triggers `ERR_LEGACY_OAUTH_DUPLICATION`.

## TV-OAUTH-AUTHFN-NEG

- **Vector ID**: TV-OAUTH-AUTHFN-NEG
- **Description**: `authfn` duplicate OAuth logic is detected.
- **Input**:
```bash
# add custom oauth exchange implementation in authfn/ts-sdk/src/social-oauth.ts
npm run test --workspace @authfn/core
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"ERR_LEGACY_OAUTH_DUPLICATION","message":"authfn must use shared oauth packages"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OAUTH-REVOKE-POS

- **Vector ID**: TV-OAUTH-REVOKE-POS
- **Description**: Disconnect revokes provider token and deletes local token record.
- **Input**:
```json
{"connectionId":"conn_1","provider":"google","revokeSupported":true}
```
- **Expected output**:
```json
{"ok":true,"data":{"remoteRevokeAttempted":true,"localTokenDeleted":true,"connectionDeleted":true}}
```
- **Negative variant(s)**:
  - Remote revoke failure still requires local cleanup and audit event.

## TV-OAUTH-REVOKE-NEG

- **Vector ID**: TV-OAUTH-REVOKE-NEG
- **Description**: Disconnect without local cleanup fails release checks.
- **Input**:
```json
{"connectionId":"conn_1","provider":"google","simulateRemoteRevokeFailure":true,"simulateLocalDeleteDisabled":true}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"local token cleanup failed"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-ROUTE-AUTH-POS

- **Vector ID**: TV-PLUG-ROUTE-AUTH-POS
- **Description**: Authenticated route ignores spoofed `userId` query and uses session identity.
- **Input**:
```http
GET /api/plugfn/v2/connections?userId=spoofed
Authorization: Bearer valid-session-for-user-u1
```
- **Expected output**:
```json
{"ok":true,"data":{"connectionsFor":"u1"}}
```
- **Negative variant(s)**:
  - Missing auth header returns `TENANT_ACCESS_DENIED`/`AUTHENTICATION_FAILED`.

## TV-PLUG-ROUTE-AUTH-NEG

- **Vector ID**: TV-PLUG-ROUTE-AUTH-NEG
- **Description**: Unauthenticated route call is rejected.
- **Input**:
```http
GET /api/plugfn/v2/connections
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"TENANT_ACCESS_DENIED","message":"authentication required"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-WEBHOOK-VERIFY-POS

- **Vector ID**: TV-PLUG-WEBHOOK-VERIFY-POS
- **Description**: Valid webhook signature is accepted.
- **Input**:
```json
{"provider":"gmail","event":"mail.update","headers":{"x-signature":"valid"},"payload":{"id":"evt_1"}}
```
- **Expected output**:
```json
{"ok":true,"data":{"verified":true,"eventAccepted":true}}
```
- **Negative variant(s)**:
  - Missing secret or invalid signature returns deterministic verification errors.

## TV-PLUG-WEBHOOK-VERIFY-NEG

- **Vector ID**: TV-PLUG-WEBHOOK-VERIFY-NEG
- **Description**: Invalid webhook signature is rejected.
- **Input**:
```json
{"provider":"gmail","event":"mail.update","headers":{"x-signature":"bad"},"payload":{"id":"evt_1"}}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"WEBHOOK_SIGNATURE_INVALID","message":"signature verification failed"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-WEBHOOK-MAP-POS

- **Vector ID**: TV-PLUG-WEBHOOK-MAP-POS
- **Description**: Webhook route maps path/event to trigger key correctly.
- **Input**:
```http
POST /api/plugfn/v2/webhooks/gmail/mail.update
```
- **Expected output**:
```json
{"ok":true,"data":{"trigger":"gmail:mail.update","handlerExecuted":true}}
```
- **Negative variant(s)**:
  - Unknown event key returns `VALIDATION_ERROR`.

## TV-PLUG-WEBHOOK-MAP-NEG

- **Vector ID**: TV-PLUG-WEBHOOK-MAP-NEG
- **Description**: Unknown webhook event key is rejected.
- **Input**:
```http
POST /api/plugfn/v2/webhooks/gmail/not-real
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"unknown webhook event"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-CONNECTION-POS

- **Vector ID**: TV-PLUG-CONNECTION-POS
- **Description**: Deterministic default connection selection chooses latest healthy connection.
- **Input**:
```json
{"tenantId":"t1","userId":"u1","provider":"gmail","connections":[{"id":"c1","lastUsedAt":"2026-03-10T00:00:00Z"},{"id":"c2","lastUsedAt":"2026-03-11T00:00:00Z"}]}
```
- **Expected output**:
```json
{"ok":true,"data":{"selectedConnectionId":"c2"}}
```
- **Negative variant(s)**:
  - Ambiguous tie without deterministic tiebreaker returns `CONNECTION_AMBIGUOUS`.

## TV-PLUG-CONNECTION-NEG

- **Vector ID**: TV-PLUG-CONNECTION-NEG
- **Description**: Ambiguous connection selection fails.
- **Input**:
```json
{"tenantId":"t1","userId":"u1","provider":"gmail","connections":[{"id":"c1"},{"id":"c2"}],"deterministicRuleDisabled":true}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"CONNECTION_AMBIGUOUS","message":"multiple active connections require explicit connectionId"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-HTTP-POS

- **Vector ID**: TV-PLUG-HTTP-POS
- **Description**: HTTP client sends form payload unchanged for form endpoints.
- **Input**:
```json
{"method":"POST","contentType":"application/x-www-form-urlencoded","body":"grant_type=refresh_token&refresh_token=rt"}
```
- **Expected output**:
```json
{"ok":true,"data":{"serializedAs":"form","requestBody":"grant_type=refresh_token&refresh_token=rt"}}
```
- **Negative variant(s)**:
  - JSON serialization of form payload returns provider `400` and test failure.

## TV-PLUG-HTTP-NEG

- **Vector ID**: TV-PLUG-HTTP-NEG
- **Description**: Incorrect JSON serialization of form request is detected.
- **Input**:
```json
{"method":"POST","contentType":"application/x-www-form-urlencoded","body":"grant_type=refresh_token","forceJsonStringify":true}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"OAUTH_TOKEN_EXCHANGE_FAILED","message":"invalid_request"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-RATELIMIT-POS

- **Vector ID**: TV-PLUG-RATELIMIT-POS
- **Description**: Rate limiter honors provider `Retry-After` and schedules retry.
- **Input**:
```json
{"provider":"outlook","responseStatus":429,"headers":{"retry-after":"7"}}
```
- **Expected output**:
```json
{"ok":true,"data":{"retryScheduledInSeconds":7,"attemptsRemaining":true}}
```
- **Negative variant(s)**:
  - Exceeding max attempts returns `PROVIDER_RATE_LIMITED`.

## TV-PLUG-RATELIMIT-NEG

- **Vector ID**: TV-PLUG-RATELIMIT-NEG
- **Description**: Infinite retry loop is blocked at max attempts.
- **Input**:
```json
{"provider":"outlook","statusSequence":[429,429,429,429,429,429],"maxAttempts":5}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_RATE_LIMITED","message":"max retry attempts exceeded"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-WORKFLOW-POS

- **Vector ID**: TV-PLUG-WORKFLOW-POS
- **Description**: Workflow execution survives restart and remains idempotent.
- **Input**:
```json
{"workflowId":"wf_1","idempotencyKey":"ik_1","simulateCrashAfterStep":1}
```
- **Expected output**:
```json
{"ok":true,"data":{"resumed":true,"duplicateSideEffects":0,"status":"completed"}}
```
- **Negative variant(s)**:
  - Re-run without idempotency guard duplicates side effects and fails tests.

## TV-PLUG-WORKFLOW-NEG

- **Vector ID**: TV-PLUG-WORKFLOW-NEG
- **Description**: Missing idempotency enforcement causes duplicate side effects.
- **Input**:
```json
{"workflowId":"wf_1","idempotencyKey":"ik_1","disableIdempotency":true}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"workflow side effect duplication detected"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-PLUG-CLI-POS

- **Vector ID**: TV-PLUG-CLI-POS
- **Description**: CLI `test` executes real checks and returns success.
- **Input**:
```bash
plugfn test --provider gmail --json
```
- **Expected output**:
```json
{"ok":true,"checks":{"config":true,"authUrl":true,"callbackValidation":true}}
```
- **Negative variant(s)**:
  - Unknown provider exits nonzero with deterministic code.

## TV-PLUG-CLI-NEG

- **Vector ID**: TV-PLUG-CLI-NEG
- **Description**: CLI rejects invalid provider.
- **Input**:
```bash
plugfn test --provider notreal --json
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_NOT_FOUND","message":"provider notreal is not registered"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-GMAIL-POS

- **Vector ID**: TV-MAIL-GMAIL-POS
- **Description**: Gmail full + incremental sync progression works.
- **Input**:
```json
{"provider":"gmail","modeSequence":["full","incremental"],"watchRenewal":true}
```
- **Expected output**:
```json
{"ok":true,"data":{"fullSyncCheckpoint":"cp1","incrementalCheckpoint":"cp2","watchRenewed":true}}
```
- **Negative variant(s)**:
  - Invalid history checkpoint returns `MAIL_SYNC_CHECKPOINT_INVALID`.

## TV-MAIL-GMAIL-NEG

- **Vector ID**: TV-MAIL-GMAIL-NEG
- **Description**: Gmail invalid history checkpoint triggers rebaseline flow.
- **Input**:
```json
{"provider":"gmail","mode":"incremental","checkpoint":"invalid-history-id"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"MAIL_SYNC_CHECKPOINT_INVALID","message":"gmail checkpoint invalid; rebaseline required"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-OUTLOOK-POS

- **Vector ID**: TV-MAIL-OUTLOOK-POS
- **Description**: Outlook subscription renewal and delta sync succeed.
- **Input**:
```json
{"provider":"outlook","subscriptionExpiresSoon":true,"deltaToken":"dt_1"}
```
- **Expected output**:
```json
{"ok":true,"data":{"subscriptionRenewed":true,"nextDeltaToken":"dt_2"}}
```
- **Negative variant(s)**:
  - Expired delta token returns `MAIL_SYNC_CHECKPOINT_INVALID`.

## TV-MAIL-OUTLOOK-NEG

- **Vector ID**: TV-MAIL-OUTLOOK-NEG
- **Description**: Outlook expired delta token is rejected.
- **Input**:
```json
{"provider":"outlook","deltaToken":"expired"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"MAIL_SYNC_CHECKPOINT_INVALID","message":"outlook delta token invalid"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-YAHOO-POS

- **Vector ID**: TV-MAIL-YAHOO-POS
- **Description**: Yahoo OAuth IMAP setup allowed by policy connects.
- **Input**:
```json
{"provider":"yahoo","policy":{"imapOauthAllowed":true},"credentials":"valid"}
```
- **Expected output**:
```json
{"ok":true,"data":{"imapConnected":true,"smtpConnected":true}}
```
- **Negative variant(s)**:
  - Policy disallow returns `PROVIDER_POLICY_BLOCKED`.

## TV-MAIL-YAHOO-NEG

- **Vector ID**: TV-MAIL-YAHOO-NEG
- **Description**: Yahoo policy-blocked mode is rejected.
- **Input**:
```json
{"provider":"yahoo","policy":{"imapOauthAllowed":false}}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_POLICY_BLOCKED","message":"yahoo policy disallows requested integration mode"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-ICLOUD-POS

- **Vector ID**: TV-MAIL-ICLOUD-POS
- **Description**: iCloud IMAP/SMTP credentials authenticate.
- **Input**:
```json
{"provider":"icloud","mode":"imap-smtp","appSpecificPassword":"valid"}
```
- **Expected output**:
```json
{"ok":true,"data":{"imapConnected":true,"smtpConnected":true}}
```
- **Negative variant(s)**:
  - POP setup returns `VALIDATION_ERROR`.

## TV-MAIL-ICLOUD-NEG

- **Vector ID**: TV-MAIL-ICLOUD-NEG
- **Description**: POP setup request is rejected.
- **Input**:
```json
{"provider":"icloud","mode":"pop"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"icloud does not support POP"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-IMAP-POS

- **Vector ID**: TV-MAIL-IMAP-POS
- **Description**: Generic IMAP/SMTP with TLS succeeds.
- **Input**:
```json
{"provider":"imap-smtp","host":"mail.example.com","tls":true}
```
- **Expected output**:
```json
{"ok":true,"data":{"imapConnected":true,"smtpConnected":true,"tls":true}}
```
- **Negative variant(s)**:
  - TLS disabled without explicit override returns `PROVIDER_POLICY_BLOCKED`.

## TV-MAIL-IMAP-NEG

- **Vector ID**: TV-MAIL-IMAP-NEG
- **Description**: Insecure generic IMAP mode blocked by default.
- **Input**:
```json
{"provider":"imap-smtp","host":"mail.example.com","tls":false,"explicitInsecureOverride":false}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_POLICY_BLOCKED","message":"insecure transport disabled"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-FORWARD-POS

- **Vector ID**: TV-MAIL-FORWARD-POS
- **Description**: Optional forwarding connector ingests inbound messages.
- **Input**:
```json
{"provider":"forwarding","enabled":true,"forwardTo":"fin+u1@fellotron.mail"}
```
- **Expected output**:
```json
{"ok":true,"data":{"inboundIngestActive":true,"outboundEnabled":false}}
```
- **Negative variant(s)**:
  - Product setup requiring forwarding by default fails policy checks.

## TV-MAIL-FORWARD-NEG

- **Vector ID**: TV-MAIL-FORWARD-NEG
- **Description**: Mandatory forwarding mode is blocked.
- **Input**:
```json
{"provider":"forwarding","setupFlow":{"isOnlyOption":true}}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_POLICY_BLOCKED","message":"forwarding cannot be mandatory"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-MANAGED-POS

- **Vector ID**: TV-MAIL-MANAGED-POS
- **Description**: Managed mailbox finance mode requires explicit opt-in and backup channel.
- **Input**:
```json
{"provider":"managed-mail","financeCritical":true,"userOptIn":true,"backupChannelConfirmed":true,"riskAck":true}
```
- **Expected output**:
```json
{"ok":true,"data":{"managedMailboxEnabled":true,"backupChannel":"confirmed"}}
```
- **Negative variant(s)**:
  - Missing backup channel returns `MAIL_SEND_BLOCKED`/policy error.

## TV-MAIL-MANAGED-NEG

- **Vector ID**: TV-MAIL-MANAGED-NEG
- **Description**: Managed mailbox finance setup without safeguards is rejected.
- **Input**:
```json
{"provider":"managed-mail","financeCritical":true,"userOptIn":true,"backupChannelConfirmed":false,"riskAck":false}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_POLICY_BLOCKED","message":"backup channel and risk acknowledgment required"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-PARSER-POS

- **Vector ID**: TV-MAIL-PARSER-POS
- **Description**: Finatron parser runs deterministic rules first and stores confidence/provenance.
- **Input**:
```json
{"message":{"subject":"Your bank statement","bodyText":"Txn INR 450"}}
```
- **Expected output**:
```json
{"ok":true,"data":{"extraction":{"amount":450,"currency":"INR"},"method":"deterministic","confidence":0.98,"provenance":["regex:txn_amount"]}}
```
- **Negative variant(s)**:
  - Missing confidence/provenance fails validation.

## TV-MAIL-PARSER-NEG

- **Vector ID**: TV-MAIL-PARSER-NEG
- **Description**: Parser output without provenance is rejected.
- **Input**:
```json
{"extraction":{"amount":450},"method":"llm","confidence":0.52,"provenance":[]}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"financial extraction must include provenance"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-SEND-POS

- **Vector ID**: TV-MAIL-SEND-POS
- **Description**: Send governor allows compliant send and enqueues idempotent job.
- **Input**:
```json
{"provider":"gmail","tenantId":"t1","recipientCount":1,"idempotencyKey":"ik_send_1"}
```
- **Expected output**:
```json
{"ok":true,"data":{"queued":true,"jobId":"send_...","policyPassed":true}}
```
- **Negative variant(s)**:
  - Rate cap breach returns `MAIL_SEND_BLOCKED`.

## TV-MAIL-SEND-NEG

- **Vector ID**: TV-MAIL-SEND-NEG
- **Description**: Send governor blocks over-cap or abuse-risk send.
- **Input**:
```json
{"provider":"gmail","tenantId":"t1","recipientCount":5000,"idempotencyKey":"ik_send_2"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"MAIL_SEND_BLOCKED","message":"send policy limit exceeded"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-MAIL-POLICY-POS

- **Vector ID**: TV-MAIL-POLICY-POS
- **Description**: Provider policy registry allows operation under current version.
- **Input**:
```json
{"provider":"gmail","operation":"mail.watch.create","policyVersion":"2026-03-11"}
```
- **Expected output**:
```json
{"ok":true,"data":{"allowed":true,"policyVersion":"2026-03-11"}}
```
- **Negative variant(s)**:
  - Blocked operation returns `PROVIDER_POLICY_BLOCKED`.

## TV-MAIL-POLICY-NEG

- **Vector ID**: TV-MAIL-POLICY-NEG
- **Description**: Disallowed provider operation is blocked.
- **Input**:
```json
{"provider":"gmail","operation":"mail.read.fullbody","featureMode":"metadata-only"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"PROVIDER_POLICY_BLOCKED","message":"operation not allowed by policy"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-SEC-LIFECYCLE-POS

- **Vector ID**: TV-SEC-LIFECYCLE-POS
- **Description**: Export and delete cascade across all user records.
- **Input**:
```json
{"tenantId":"t1","userId":"u1","operation":["export","delete"]}
```
- **Expected output**:
```json
{"ok":true,"data":{"exported":true,"deleted":{"connections":true,"tokens":true,"messages":true,"parseArtifacts":true}}}
```
- **Negative variant(s)**:
  - Residual token record triggers `INTERNAL_ERROR` lifecycle failure.

## TV-SEC-LIFECYCLE-NEG

- **Vector ID**: TV-SEC-LIFECYCLE-NEG
- **Description**: Partial delete is detected as failure.
- **Input**:
```json
{"tenantId":"t1","userId":"u1","simulateResidual":"token_vault_records"}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"deletion incomplete: token_vault_records"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-SEC-REDACTION-POS

- **Vector ID**: TV-SEC-REDACTION-POS
- **Description**: Logs redact tokens and message bodies.
- **Input**:
```json
{"logEvent":{"accessToken":"at_123","messageBody":"secret"}}
```
- **Expected output**:
```json
{"ok":true,"data":{"logged":{"accessToken":"[REDACTED]","messageBody":"[REDACTED]"}}}
```
- **Negative variant(s)**:
  - Plaintext secret in logs fails with `INTERNAL_ERROR` during redaction tests.

## TV-SEC-REDACTION-NEG

- **Vector ID**: TV-SEC-REDACTION-NEG
- **Description**: Secret leak in telemetry fails checks.
- **Input**:
```json
{"logEvent":{"refreshToken":"rt_plaintext"},"simulateRedactionDisabled":true}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"sensitive telemetry leak detected"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-SEC-ISOLATION-POS

- **Vector ID**: TV-SEC-ISOLATION-POS
- **Description**: Tenant-scoped query returns only tenant-owned records.
- **Input**:
```json
{"session":{"tenantId":"t1","userId":"u1"},"query":{"connectionId":"conn_t1"}}
```
- **Expected output**:
```json
{"ok":true,"data":{"record":{"tenantId":"t1"}}}
```
- **Negative variant(s)**:
  - Cross-tenant fetch returns `TENANT_ACCESS_DENIED`.

## TV-SEC-ISOLATION-NEG

- **Vector ID**: TV-SEC-ISOLATION-NEG
- **Description**: Cross-tenant access is denied.
- **Input**:
```json
{"session":{"tenantId":"t1","userId":"u1"},"query":{"connectionId":"conn_t2"}}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"TENANT_ACCESS_DENIED","message":"cross-tenant access denied"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-SEC-E2EE-POS

- **Vector ID**: TV-SEC-E2EE-POS
- **Description**: E2EE mode metadata and key mode are explicit.
- **Input**:
```json
{"managedMailboxId":"mb1","mode":"non-recoverable"}
```
- **Expected output**:
```json
{"ok":true,"data":{"securityMode":"non-recoverable","serverSideRecoveryAllowed":false}}
```
- **Negative variant(s)**:
  - Unspecified mode fails validation.

## TV-SEC-E2EE-NEG

- **Vector ID**: TV-SEC-E2EE-NEG
- **Description**: Missing key mode metadata is rejected.
- **Input**:
```json
{"managedMailboxId":"mb1","mode":null}
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"managed mailbox security mode is required"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OPS-HARDEN-POS

- **Vector ID**: TV-OPS-HARDEN-POS
- **Description**: Previously failing `plugfn` tests pass after hardening.
- **Input**:
```bash
cd plugfn/typescript && npm test -- --run
```
- **Expected output**:
```json
{"ok":true,"data":{"failed":0}}
```
- **Negative variant(s)**:
  - Reintroducing mock encrypted credential mismatch fails regression suite.

## TV-OPS-HARDEN-NEG

- **Vector ID**: TV-OPS-HARDEN-NEG
- **Description**: Regression to encryption handling is caught.
- **Input**:
```bash
# set mock connection encrypted payload to invalid format then run tests
cd plugfn/typescript && npm test -- --run
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Invalid encrypted data format"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OPS-MATRIX-POS

- **Vector ID**: TV-OPS-MATRIX-POS
- **Description**: Full impacted workspace matrix passes.
- **Input**:
```bash
turbo run build test --filter=@superfunctions/oauth-core --filter=@superfunctions/oauth-http --filter=@superfunctions/oauth-storage --filter=@superfunctions/oauth-providers --filter=plugfn --filter=@authfn/core
```
- **Expected output**:
```json
{"ok":true,"data":{"allRequiredWorkspacesPassed":true}}
```
- **Negative variant(s)**:
  - Any required workspace failure blocks release gate with nonzero exit.

## TV-OPS-MATRIX-NEG

- **Vector ID**: TV-OPS-MATRIX-NEG
- **Description**: Matrix gate fails when one required workspace fails.
- **Input**:
```bash
# break oauth-core export and run matrix
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"ERR_RELEASE_GATE_FAILED","message":"required workspace failed"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OPS-RUNBOOK-POS

- **Vector ID**: TV-OPS-RUNBOOK-POS
- **Description**: Operational runbooks exist and simulation passes.
- **Input**:
```bash
ls plugfn/docs/runbooks && npm run test:runbooks --workspace plugfn
```
- **Expected output**:
```json
{"ok":true,"data":{"runbooksPresent":true,"simulationPassed":true}}
```
- **Negative variant(s)**:
  - Missing runbook file fails runbook validation command.

## TV-OPS-RUNBOOK-NEG

- **Vector ID**: TV-OPS-RUNBOOK-NEG
- **Description**: Missing runbook is caught.
- **Input**:
```bash
rm plugfn/docs/runbooks/oauth-incident.md && npm run test:runbooks --workspace plugfn
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"ERR_RUNBOOK_MISSING","message":"oauth-incident runbook missing"}}
```
- **Negative variant(s)**:
  - N/A.

## TV-OPS-DOCS-POS

- **Vector ID**: TV-OPS-DOCS-POS
- **Description**: Docs show shared OAuth and provider policy guidance.
- **Input**:
```bash
rg -n "@superfunctions/oauth-core|provider policy|managed mailbox risk" plugfn/docs authfn/ts-sdk/README.md
```
- **Expected output**:
```json
{"ok":true,"data":{"requiredDocsPresent":true}}
```
- **Negative variant(s)**:
  - Stale docs referencing old OAuth implementation fail docs lint.

## TV-OPS-DOCS-NEG

- **Vector ID**: TV-OPS-DOCS-NEG
- **Description**: Stale docs are blocked.
- **Input**:
```bash
# leave old docs instructing plugfn/typescript/src/auth/oauth-flow.ts direct usage
npm run lint:docs --workspace plugfn
```
- **Expected output**:
```json
{"ok":false,"error":{"code":"ERR_DOCS_STALE_REFERENCE","message":"stale oauth implementation reference"}}
```
- **Negative variant(s)**:
  - N/A.
