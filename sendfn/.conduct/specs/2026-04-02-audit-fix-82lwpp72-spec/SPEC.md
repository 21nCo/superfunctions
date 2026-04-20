# Metadata

- timestamp: 2026-04-02T13:46:52Z
- agent_name: unknown-agent
- model: unknown
- launcher: Codex Desktop
- workspace/project path: repo root
- os: Darwin arm64
- shell: zsh
- git.branch: detached HEAD
- git.commit: `7adae77`
- git.dirty: true
- spec_folder: `2026-04-02-audit-fix-82lwpp72-spec`
- spec_path: `sendfn/.conduct/specs/2026-04-02-audit-fix-82lwpp72-spec`
- spec_type: `audit-fix`
- spec_id: `82lwpp72`
- input paths:
  - `sendfn/v0.intent.md`
  - `sendfn/v0.spec.md`
  - `sendfn/typescript/README.md`
  - `sendfn/python/README.md`
  - `sendfn/.conduct/audits/2026-04-02-lnle4mwn-full-audit.md`
  - thread-provided AGENTS instructions for repo root
- audit reference:
  - filename: `2026-04-02-lnle4mwn-full-audit.md`
  - path: `sendfn/.conduct/audits/2026-04-02-lnle4mwn-full-audit.md`
  - audited spec input: `sendfn/v0.spec.md`
  - audited spec folder: `N/A`

# Overview

This spec defines the full remediation program required to bring `sendfn` v0 to a production-ready baseline across both TypeScript and Python SDKs without shrinking scope. The bundle fixes the blockers identified in the April 2 audit while preserving the original v0 intent: a self-deployable, unified communications SDK that supports AWS SES email workflows, in-codebase templates, suppression management, SES event intake, push notifications via FCM/APNS, and persistence through shared Superfunctions abstractions.

Assumption A-001: In this v0, "basic email receiving" means ingesting and processing AWS SES lifecycle events delivered through SNS-compatible webhooks. It does not mean mailbox inbox retrieval or message-body ingestion, because no authoritative input describes inbox storage semantics.

Question Q-001: If mailbox/inbox retrieval was intended in addition to SES lifecycle event intake, that capability requires a separate intent document and separate spec. This question does not block the current audit-fix work.

## Context

- Project name: `sendfn`
- One-sentence goal: Bring `sendfn` v0 to a release-candidate production-readiness baseline by fixing webhook security, transaction/event correlation, packaging, template correctness, performance/scalability limits, shared-abstraction usage, and release-gate verification gaps.
- Target users:
  - application developers integrating self-hosted communications into products
  - maintainers of the Superfunctions monorepo
  - operators running SES/FCM/APNS-backed notification infrastructure
- Target environments:
  - TypeScript SDK: Node.js server runtime
  - Python SDK: Python 3.10+ server runtime
  - HTTP exposure: framework adapters built on shared Superfunctions HTTP abstractions
  - Network model: online only for provider operations; local/offline test mode via memory/test doubles
- Languages/packages required:
  - `sendfn/typescript`
  - `sendfn/python`
  - shared abstractions from `@superfunctions/db`, `@superfunctions/http`, `superfunctions.db`, `superfunctions.http`, and optional Python framework adapters
- Existing systems it must integrate with:
  - AWS SES
  - Firebase Admin / FCM
  - APNS
  - shared Superfunctions DB and HTTP packages
- Data model summary:
  - `email_transactions`
  - `sms_transactions`
  - `push_notifications`
  - `device_tokens`
  - `suppression_list`
  - `communication_events`
- Security model:
  - app-managed `userId` scoping supplied by callers
  - admin API bearer key when HTTP routes are enabled
  - SNS signature verification for public webhook processing
  - no credential, token, or message-body leakage in logs/events
- Performance constraints:
  - email send orchestration overhead MUST remain below the v0 target of p95 `<500ms` excluding provider network latency
  - push send orchestration for 100 devices MUST remain below the v0 target of p95 `<1s` excluding provider network latency
  - FCM batching MUST obey a 500-token cap per provider request
  - APNS concurrency MUST not exceed 10 simultaneous provider sends per logical request
- Non-goals / out of scope:
  - adding new email providers beyond AWS SES
  - adding new push providers beyond FCM/APNS
  - introducing mailbox/inbox retrieval semantics
  - broadening SMS beyond the currently shipped basic provider abstraction and console/basic flow
- Hard constraints:
  - no scope reduction from the original v0 intent plus current shipped public surface
  - reuse shared Superfunctions packages instead of copying generic DB/HTTP code locally
  - keep verification commands runnable from repo root
  - no absolute paths in committed artifacts

# Glossary

- `Sendfn client`: The primary SDK object returned by `sendfn(...)` in TypeScript and `create_sendfn(...)` / `Sendfn(...)` in Python.
- `Admin API`: Optional HTTP routes exposed by the SDK for operator-driven email, SMS, push, event, device, and suppression actions.
- `Canonical envelope`: The standard HTTP success/error response shape required for all admin endpoints.
- `Provider message ID`: The identifier returned by AWS SES or other providers for a sent message.
- `Correlated event`: A communication event linked deterministically to an internal `email_transactions`, `sms_transactions`, or `push_notifications` record.
- `Orphan event`: A verified provider event whose provider message ID does not map to a known local transaction.
- `Webhook verifier`: The logic that validates SNS signature, certificate, timestamp freshness, and message shape before lifecycle processing.
- `Lifecycle event`: A provider-originated event such as `sent`, `delivered`, `bounced`, `complained`, `opened`, `clicked`, or `failed`.
- `Suppression entry`: A normalized, unique row in `suppression_list` keyed by email address.
- `Clean checkout`: A freshly installed workspace in which the documented build/test/lint commands run successfully from repo root.

# Goals / Non-goals

## Goals

1. `sendfn` MUST publish and document a coherent public package/import identity across TypeScript and Python.
2. Both SDKs MUST expose a stable public API surface with aligned lifecycle, error, and feature semantics for supported functionality.
3. Email templating MUST deterministically support variables, `#if`, and `#each` semantics in both SDKs.
4. SES lifecycle webhook processing MUST be secure, signature-verified, and deterministically correlated to internal transactions.
5. Suppression behavior MUST correctly reflect permanent bounces, complaints, manual unsubscribe/manual add, and manual removal flows.
6. Push fan-out MUST obey provider limits, deactivate invalid tokens, and return deterministic results.
7. Shared Superfunctions DB/HTTP abstractions MUST remain the integration boundary instead of being reimplemented locally.
8. A clean-checkout release gate MUST verify build, lint, import, packaging, and test behavior for both SDKs.
9. Documentation and examples MUST match the shipped package names and supported feature set.

## Non-goals

1. This spec does not add new email providers, new push providers, or mailbox/inbox retrieval.
2. This spec does not introduce a new authentication model beyond the existing admin bearer-key surface for HTTP routes.
3. This spec does not add a production SMS provider beyond the currently shipped basic abstraction and console/basic development provider.
4. This spec does not migrate `sendfn` onto a different persistence abstraction than the shared Superfunctions DB interfaces.

# Public API

## TypeScript SDK

```ts
export interface SendfnConfig {
  database: Adapter;
  email?: EmailConfig;
  emailProvider?: EmailProvider;
  smsProvider?: SmsProvider;
  push?: PushConfig;
  options?: SendfnOptions;
  enableApi?: boolean;
  apiConfig?: { adminKey?: string };
}

export interface SendfnClient {
  email(params: SendEmailParams): Promise<EmailTransaction>;
  bulkEmail(recipients: SendEmailParams[]): Promise<EmailTransaction[]>;
  sms(params: SendSmsParams): Promise<SmsTransaction>;
  push(params: SendPushParams): Promise<PushNotification>;
  bulkPush(notifications: SendPushParams[]): Promise<PushNotification[]>;
  registerDevice(params: RegisterDeviceParams): Promise<DeviceToken>;
  getDevices(userId: string, platform?: Platform): Promise<DeviceToken[]>;
  deactivateDevice(token: string): Promise<void>;
  refreshDeviceToken(oldToken: string, newToken: string, userId: string, platform: Platform): Promise<DeviceToken>;
  cleanupInactiveDevices(olderThan: Date): Promise<number>;
  registerTemplate(template: EmailTemplate): Promise<void>;
  getTemplate(templateId: string): Promise<EmailTemplate | undefined>;
  listTemplates(): Promise<EmailTemplate[]>;
  getEmailEvents(transactionId: string): Promise<CommunicationEvent[]>;
  getPushEvents(notificationId: string): Promise<CommunicationEvent[]>;
  getSmsEvents(transactionId: string): Promise<CommunicationEvent[]>;
  queryEvents(params: QueryEventsParams): Promise<CommunicationEvent[]>;
  checkSuppressionList(email: string): Promise<SuppressionCheckResult>;
  addToSuppressionList(params: AddSuppressionParams): Promise<SuppressionList>;
  bulkAddToSuppressionList(entries: AddSuppressionParams[]): Promise<void>;
  exportSuppressionList(limit?: number, offset?: number): Promise<SuppressionList[]>;
  removeFromSuppressionList(email: string): Promise<void>;
  getWebhookHandlers(): { awsSes: AwsSesWebhookHandler };
  close(): Promise<void>;
  router?: SendfnHttpRouter;
}

export function sendfn(config: SendfnConfig): SendfnClient;
```

### TypeScript additions required by this spec

- `QueryEventsParams` MUST support:
  - `referenceId`
  - `referenceType`
  - `providerMessageId`
  - `provider`
  - `userId`
  - `eventType`
  - `startAt`
  - `endAt`
  - `limit`
  - `offset`
- `SendfnError` and subclasses MUST expose:
  - `code: string`
  - `retryable: boolean`
  - `details?: Record<string, unknown>`

## Python SDK

```python
class SendfnConfig:
    database: Adapter
    email: EmailConfig | None
    push: PushConfig | None
    sms_provider: SmsProvider | None
    options: SendfnOptions | None

class Sendfn:
    async def send_email(self, params: SendEmailParams) -> EmailTransaction: ...
    async def send_bulk_email(self, recipients: list[SendEmailParams]) -> list[EmailTransaction]: ...
    async def send_sms(self, params: SendSmsParams) -> SmsTransaction: ...
    async def send_push(self, params: SendPushParams) -> PushNotification: ...
    async def send_bulk_push(self, notifications: list[SendPushParams]) -> list[PushNotification]: ...
    async def register_device(self, params: RegisterDeviceParams) -> DeviceToken: ...
    async def get_devices(self, user_id: str, platform: Platform | None = None) -> list[DeviceToken]: ...
    async def deactivate_device(self, token: str) -> None: ...
    async def refresh_device_token(self, old_token: str, new_token: str, user_id: str, platform: Platform) -> DeviceToken: ...
    async def cleanup_inactive_devices(self, older_than: datetime) -> int: ...
    async def register_template(self, template: EmailTemplate) -> None: ...
    async def get_template(self, template_id: str) -> EmailTemplate | None: ...
    async def list_templates(self) -> list[EmailTemplate]: ...
    async def get_email_events(self, transaction_id: str) -> list[CommunicationEvent]: ...
    async def get_push_events(self, notification_id: str) -> list[CommunicationEvent]: ...
    async def get_sms_events(self, transaction_id: str) -> list[CommunicationEvent]: ...
    async def query_events(self, **filters) -> list[CommunicationEvent]: ...
    async def check_suppression_list(self, email: str) -> dict: ...
    async def add_to_suppression_list(...) -> SuppressionList: ...
    async def bulk_add_to_suppression_list(self, entries: list[AddSuppressionParams]) -> None: ...
    async def export_suppression_list(self, limit: int = 1000, offset: int = 0) -> list[SuppressionList]: ...
    async def remove_from_suppression_list(self, email: str) -> None: ...
    def get_webhook_handlers(self) -> dict[str, AwsSesWebhookHandler]: ...
    async def close(self) -> None: ...

def create_sendfn(config: SendfnConfig) -> Sendfn
```

### Python import rules required by this spec

- `import sendfn` MUST succeed with base dependencies only.
- Optional framework helpers such as `sendfn.http.fastapi` MAY require extras, but base package import MUST NOT import them eagerly.
- Attempting to call an optional integration without its dependency installed MUST raise `SendfnError(code="SENDFN_OPTIONAL_DEPENDENCY_MISSING", ...)`.

## HTTP admin API

### Endpoints

- `POST /email`
- `POST /email/bulk`
- `POST /sms`
- `POST /push`
- `POST /push/bulk`
- `POST /devices`
- `GET /devices/{userId}`
- `GET /events`
- `GET /suppression/{email}`
- `POST /suppression`
- `DELETE /suppression/{email}`
- `POST /webhooks/aws-ses`

### Authentication

- When admin API routing is enabled, all non-webhook endpoints MUST require `Authorization: Bearer <adminKey>`.
- Missing or invalid bearer tokens MUST return HTTP `401` with the canonical error envelope.

## Webhook handler

```ts
interface AwsSesWebhookHandler {
  handleSnsNotification(payload: SnsEnvelope): Promise<WebhookProcessResult>;
}
```

```python
class AwsSesWebhookHandler:
    async def handle_webhook(self, sns_message: dict[str, Any]) -> WebhookProcessResult: ...
```

`WebhookProcessResult` MUST include:

```json
{
  "accepted": true,
  "verified": true,
  "matchedTransactions": 1,
  "createdSuppressionEntries": 1,
  "orphanEvents": 0
}
```

# Data formats / protocol

## Canonical success envelope

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "meta": {
    "requestId": "req_01HXYZ",
    "version": "v0"
  }
}
```

## Canonical error envelope

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "SENDFN_VALIDATION_ERROR",
    "message": "Field `to` must contain at least one email address",
    "retryable": false,
    "details": {
      "field": "to"
    }
  },
  "meta": {
    "requestId": "req_01HXYZ",
    "version": "v0"
  }
}
```

## Canonical runtime error codes

- `SENDFN_VALIDATION_ERROR`
- `SENDFN_UNAUTHORIZED`
- `SENDFN_FEATURE_NOT_CONFIGURED`
- `SENDFN_OPTIONAL_DEPENDENCY_MISSING`
- `SENDFN_TEMPLATE_NOT_FOUND`
- `SENDFN_TEMPLATE_RENDER_ERROR`
- `SENDFN_SUPPRESSED`
- `SENDFN_PROVIDER_LIMIT`
- `SENDFN_PROVIDER_RETRY_EXHAUSTED`
- `SENDFN_WEBHOOK_SIGNATURE_INVALID`
- `SENDFN_WEBHOOK_MESSAGE_INVALID`
- `SENDFN_WEBHOOK_TRANSACTION_NOT_FOUND`
- `SENDFN_RATE_LIMITED`
- `SENDFN_INTERNAL_ERROR`

## Canonical verification and release-gate error codes

These codes MAY be emitted by parity checks, documentation checks, packaging checks, or local release-gate tooling. When surfaced through an HTTP/admin context, they MUST still use the canonical error envelope.

- `SENDFN_MANIFEST_MISMATCH`
- `SENDFN_PUBLIC_API_DRIFT`
- `SENDFN_RELEASE_GATE_FAILED`
- `SENDFN_UNIQUE_CONSTRAINT`
- `SENDFN_TEST_DOUBLE_FIDELITY`
- `SENDFN_SHARED_ABSTRACTION_REGRESSION`
- `SENDFN_SECRET_LEAK`
- `SENDFN_BULK_SEQUENTIAL_PATH`
- `SENDFN_DOC_DRIFT`

## SNS envelope input

The webhook route MUST accept the SNS envelope shape:

```json
{
  "Type": "Notification",
  "MessageId": "sns-message-id",
  "TopicArn": "arn:aws:sns:region:acct:topic",
  "Subject": "Amazon SES Email Event Notification",
  "Message": "{\"notificationType\":\"Bounce\", ...}",
  "Timestamp": "2026-04-02T00:00:00Z",
  "SignatureVersion": "1",
  "Signature": "base64-signature",
  "SigningCertURL": "https://sns.us-east-1.amazonaws.com/....pem",
  "UnsubscribeURL": "https://sns.amazonaws.com/..."
}
```

## Query events request shape

```json
{
  "referenceId": "uuid-or-synthetic-id",
  "referenceType": "email",
  "providerMessageId": "ses-message-id",
  "provider": "aws-ses",
  "userId": "user-123",
  "eventType": "delivered",
  "startAt": "2026-04-01T00:00:00Z",
  "endAt": "2026-04-02T00:00:00Z",
  "limit": 50,
  "offset": 0
}
```

# Semantics

## Packaging semantics

1. The TypeScript package published from `sendfn/typescript` MUST be named `sendfn`.
2. The TypeScript README, examples, and install/import instructions MUST use `sendfn`.
3. The Python base package MUST expose only dependencies guaranteed by the base install.
4. Optional integrations MUST be loaded lazily and MUST fail only at import/use time with `SENDFN_OPTIONAL_DEPENDENCY_MISSING`.

## Email semantics

1. `email()` and `send_email()` MUST validate required input before creating provider calls.
2. `templateId` and raw `subject`/`html` inputs MAY be used separately or together, but the resolved subject/body MUST be non-empty after rendering.
3. Template rendering MUST:
   - interpolate `{{variable}}`
   - process `{{#if name}}...{{/if}}`
   - process `{{#each items}}...{{/each}}`
   - HTML-escape variable values by default
4. A suppressed recipient MUST short-circuit provider sending and return/raise `SENDFN_SUPPRESSED`.
5. Recipient and attachment caps MUST be checked before provider network calls.
6. Bulk email MUST use bounded concurrency or provider bulk APIs and MUST NOT degenerate into purely sequential send loops in production code paths.

## Persistence and event semantics

1. `providerMessageId` returned from provider sends MUST be stored on the corresponding `email_transactions` row before any correlated webhook can be considered complete.
2. Query helpers MUST support lookup by `providerMessageId`.
3. `queryEvents` MUST support filtering by `referenceId`, `referenceType`, `providerMessageId`, `provider`, `userId`, `eventType`, time window, `limit`, and `offset`.
4. `communication_events` MUST be ordered by `eventTimestamp ASC` for per-reference retrieval.
5. When a verified provider event cannot be correlated to a local transaction, the system MUST NOT fabricate `"unknown"`. It MUST emit an orphan event using the deterministic synthetic reference ID `provider:aws-ses:<providerMessageId>` and `metadata.orphaned=true`.

## Webhook semantics

1. The webhook route MUST verify SNS signature, timestamp freshness, certificate host allowlist, and message shape before parsing the inner SES event body.
2. Invalid or unverifiable webhook payloads MUST return HTTP `400` with `SENDFN_WEBHOOK_SIGNATURE_INVALID` or `SENDFN_WEBHOOK_MESSAGE_INVALID`.
3. Verified lifecycle events MUST update transaction status transitions deterministically:
   - `pending -> sent -> delivered`
   - `pending|sent|delivered -> bounced`
   - `pending|sent|delivered -> complained`
   - terminal states MUST NOT regress to earlier states
4. Duplicate webhook deliveries for the same provider event MUST be idempotent.
5. Bounce/complaint events MUST update suppression state even when the transaction is orphaned.

## Suppression semantics

1. Suppression emails MUST be normalized to trimmed lowercase for uniqueness checks.
2. Permanent bounce MUST auto-add suppression reason `bounce`.
3. Complaint MUST auto-add suppression reason `complaint`.
4. Manual unsubscribe/manual operator action MUST be representable as reason `unsubscribe` or `manual`.
5. Manual removal MUST permit future sends.
6. Public SDK suppression management MUST expose:
   - `bulkAddToSuppressionList` / `bulk_add_to_suppression_list`
   - `exportSuppressionList` / `export_suppression_list`
7. Bulk add and export operations MUST exist for operator workflows.

## Push semantics

1. FCM send requests MUST be chunked into batches of at most 500 device tokens.
2. APNS sends MUST cap in-flight concurrency at 10 logical notifications per request.
3. Invalid device tokens returned by providers MUST be deactivated before the method resolves.
4. A multi-platform push request MUST return a deterministic logical result:
   - records MAY still be stored per platform/provider
   - the public return value MUST be the record for the first processed platform in the stable order `android`, `ios`, `web`
   - `metadata.notificationIds` MUST list all created notification IDs in stable platform order
5. Bulk push MUST use bounded concurrency and MUST NOT be purely sequential in production code paths.

## Device semantics

1. Registering an existing `(userId, token, platform)` tuple MUST reactivate and update the existing row rather than create a duplicate.
2. Device lifecycle MUST support:
   - register
   - get active devices
   - deactivate by token
   - refresh token
   - cleanup inactive tokens older than a caller-supplied threshold
3. Public SDK device lifecycle MUST expose:
   - `refreshDeviceToken` / `refresh_device_token`
   - `cleanupInactiveDevices` / `cleanup_inactive_devices`

## Release-gate semantics

1. From repo root, the documented TypeScript and Python build/test/lint/import commands MUST pass in a clean checkout after dependencies are installed.
2. Test doubles and memory adapters MUST surface uniqueness and lookup failures that production adapters would surface, rather than silently overwriting or ignoring invalid state.

# Invariants

1. All externally visible error codes MUST be stable and deterministic for the same failure class.
2. Webhook verification MUST occur before any database mutation.
3. A verified webhook delivery MUST be processed idempotently using a dedupe key composed of:
   - provider
   - provider message ID
   - lifecycle event type
   - recipient identity
4. Suppression entries MUST remain unique by normalized email.
5. Template rendering output for the same `(template, data)` pair MUST be byte-for-byte stable.
6. `close()` MUST be safe to call multiple times.
7. Admin API success/error envelopes MUST be stable across frameworks.
8. The system MUST NOT log credentials, device tokens, SES signatures, raw provider secrets, or email HTML/text bodies.

# Security

1. Admin API routes MUST require bearer auth when enabled.
2. Webhook routes MUST rely on cryptographic verification rather than bearer auth.
3. Input validation MUST happen before provider calls and before persistence writes that assume valid structure.
4. Optional dependency imports MUST fail safely and explicitly instead of crashing unrelated base-package imports.
5. Logs and emitted errors MUST redact:
   - access keys
   - secret keys
   - refresh tokens
   - device tokens
   - SES signatures
   - raw message bodies
6. Route handlers MUST return canonical envelopes and MUST NOT leak raw stack traces.

# Limits / caps

1. Email recipients per provider request MUST be capped at `50`.
2. Total email attachment size per provider request MUST be capped at `10 MiB`.
3. FCM token batch size MUST be capped at `500`.
4. APNS in-flight concurrency MUST be capped at `10`.
5. `queryEvents` default limit MUST be `50`; maximum limit MUST be `200`.
6. Suppression bulk add MUST accept at most `1000` entries per call.
7. Export suppression list MAY page, but each page MUST use deterministic sort order by normalized email ascending.
8. HTTP admin API JSON request body size SHOULD be capped at `256 KiB`.

# Observability

1. Each admin API response MUST include a `requestId` in `meta`.
2. Email and push operations MUST emit structured logs with:
   - operation name
   - requestId
   - provider
   - userId
   - status
   - counts
3. Webhook processing MUST emit structured logs with:
   - requestId
   - SNS message ID
   - verification result
   - matched transaction count
   - orphan event count
   - suppression mutations count
4. Metrics SHOULD include:
   - `sendfn.email.send.attempt`
   - `sendfn.email.send.success`
   - `sendfn.email.send.failure`
   - `sendfn.push.send.attempt`
   - `sendfn.push.send.success`
   - `sendfn.push.send.failure`
   - `sendfn.webhook.accepted`
   - `sendfn.webhook.rejected`
5. Observability MUST NOT record credentials, token values, or message bodies.

# Compatibility / versioning strategy

1. TypeScript package naming MUST align with the repository convention for core superfunctions packages and publish as `sendfn`.
2. If maintainers choose to preserve `@sendfn/core` temporarily, it MAY exist only as a compatibility shim and MUST contain no divergent runtime logic.
3. Python optional integrations MUST remain optional extras and MUST not become transitive base-import requirements.
4. Public SDK method names SHOULD remain stable where possible.
5. Any return-shape change required for deterministic multi-platform push behavior MUST be documented in README and release notes before shipping.
6. Data-model additions required by this spec MUST be additive or accompanied by a documented migration path.

# Undefined / Explicitly user-deferred only

No scope items were explicitly deferred by the user. Any behavior not specified elsewhere in this document is undefined and not required.
