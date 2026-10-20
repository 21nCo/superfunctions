# @userfn/client

The official TypeScript SDK for UserFn - the open-source user engagement platform.

## Features

- **Identity & Segmentation**: Track users and define complex audience segments based on traits.
- **Feature Flags**: Deterministic, rule-based feature flags with percentage rollouts.
- **In-App Messaging**: Targeted campaigns (Modals, Toasts) triggered by URL or Events.
- **Surveys**: Run NPS, CSAT, and custom surveys directly in your app.
- **Feedback**: Collect bug reports and feature requests from users.

## Installation

```bash
npm install userfn
# or
yarn add userfn
```

## Quick Start

```typescript
import { UserFnClient } from 'userfn';

const userfn = new UserFnClient({
  apiKey: '...',
  // Bootstrap flags for immediate availability (SSR/Edge)
  bootstrapFlags: {
    'new-feature': true
  }
});

// 1. Identify User
userfn.identify('user-123', {
  email: 'alice@example.com',
  plan: 'pro',
  beta_tester: true
});

// 2. Check Flags
if (userfn.getFlag('new-feature', false)) {
  console.log('Rendering new feature...');
}

// 3. Trigger Messaging/Surveys (e.g. on route change)
// Checks for eligible campaigns or surveys matching the context
userfn.trigger('url_match', window.location.pathname);

// 4. Submit Feedback
document.getElementById('feedback-btn').onclick = () => {
  userfn.openFeedbackWidget();
};
```

## Advanced Usage

## Self-hosted operator API

The `userfn/operator` export is the authoritative server-side boundary for UserFn administration. `UserFnOperatorService` accepts an injected `UserFnOperatorStore`, so self-hosted installations can use durable database persistence while retaining the same typed service. All records are keyed by the exact installation/workspace/project/environment scope.

```typescript
import { UserFnOperatorService } from "userfn/operator";

const users = new UserFnOperatorService(durableStore);
await users.setFlagEnabled(scope, "new-ui", true);
```

`MemoryUserFnOperatorStore` is intended for tests and single-process development. `@userfn/admin` exposes the operator service through the shared Super Console, REST/OpenAPI, SDK, and MCP contracts; customer-facing evaluation and rendering remain in `UserFnClient`.

### Segments
Define segments in your configuration (loaded from server):
```typescript
{
  id: 'beta-users',
  rules: [
    { field: 'plan', operator: 'equals', value: 'pro' },
    { field: 'beta_tester', operator: 'exists' }
  ]
}
```

### Campaigns
Campaigns are evaluated client-side for performance:
```typescript
{
  id: 'welcome-modal',
  kind: 'modal',
  triggers: [{ type: 'event', pattern: 'signup_complete' }],
  content: { title: 'Welcome!', body: 'Thanks for joining.' }
}
```

## Architecture
- **Core**: Framework-agnostic logic (`src/core`) handles all evaluation.
- **UI**: Vanilla JS renderer (`src/ui`) injects lightweight, themeable DOM elements.
- **Network**: Feedback submits to the dedicated UserFn service; event/config synchronization remains separate unfinished work.

## License
MIT

## Feedback delivery

Configure `endpoint` and `apiKey` to submit to the dedicated `@userfn/service` backend:

```typescript
const client = new UserFnClient({
  endpoint: 'https://feedback.example.com/userfn', // mount the service router here
  apiKey: 'tenant-scoped-token',
  feedbackMaxAttempts: 3,
  feedbackTimeoutMs: 10000,
});
await client.submitFeedback(
  { title: 'Improve search', body: 'Support saved queries', category: 'feature' },
  { idempotencyKey: 'submission-123' },
);
```

The SDK sends `POST <endpoint>/feedback` with bearer authentication and a stable idempotency key across automatic retries. Network failures, HTTP 408/429 and 5xx are retried up to the configured attempt count (1–5). Each attempt has an abort deadline. Other HTTP failures throw `FeedbackHTTPError` with `status`; malformed or negative receipts throw `FeedbackDeliveryError`. Requests and receipts are bounded to 64 KiB. Redirects are rejected. For a later manual retry, reuse the same explicit key and content; conflicting reuse returns 409. Without an explicit key each new call is a separate submission.

`submitFeedback()` resolves only after a positive service receipt; the backend waits for its database write. The widget uses the same operation and retains its failure state on rejection. Current identity is submitted as client metadata, separate from the server-authenticated actor. Reset sends anonymous client metadata and does not change bearer permissions.

An explicit `feedbackService` still overrides HTTP delivery and must implement the awaited `FeedbackService` receipt contract. Without either service or endpoint, submission rejects. Configuration sync, offline queues, external-source ingestion and browser end-to-end acceptance remain open. See [service setup](../service/README.md). Use narrowly scoped credentials in browser clients; never embed an administrative key.

### Board, votes and status

```typescript
const page = await client.getFeedbackBoard({ limit: 20, status: 'open' });
const next = page.nextCursor
  ? await client.getFeedbackBoard({ limit: 20, status: 'open', after: page.nextCursor })
  : null;
await client.voteFeedback(page.items[0].id, 1); // -1 downvote; 0 remove
await client.setFeedbackStatus(page.items[0].id, 'planned');
```

These operations require independent read, vote and moderate bearer scopes. The server counts one vote per authenticated actor; changing client identity does not create another voter. API keys count as key principals, so use verified user principals for human voting. HTTP errors reject and malformed results are not acknowledged. Operations use the same bounded retry/timeout policy; repeated directions/statuses are idempotent, with last committed update winning concurrent changes. Board results are limited to 100 items and 16 MiB. Custom `feedbackService` implementations may optionally implement `list`, `vote` and `setStatus`; missing methods fail explicitly. See service documentation for schema migration, projection limits and live cursor semantics.

### Filter by tag and product area

After the host completes the service filter-table migration:

```typescript
await client.submitFeedback({ title: 'Search', body: 'Improve matching', category: 'feature', tags: ['UI'], productArea: 'Search' });
let after: string | undefined;
do {
  const page = await client.getFeedbackBoard({ tag: 'UI', productArea: 'Search', status: 'open', limit: 20, after });
  consume(page.items); // May be empty while the cursor advances.
  after = page.nextCursor ?? undefined;
} while (after);
```

Labels are trimmed, NFC-normalized and case-sensitive. Missing/incomplete backfill returns 503. The scan budget can yield partial or empty pages with a progress cursor. Keep all filters unchanged when following `nextCursor`. Continue until `nextCursor` is null, regardless of page length. See the service's migration and per-request scan-budget contract; this is live pagination, not a snapshot.


### Moderate tags and product area

```typescript
await client.setFeedbackMetadata(id, { tags: ['UI', 'Accessibility'], productArea: 'Search' });
await client.setFeedbackMetadata(id, { productArea: null }); // clear area, retain tags
await client.setFeedbackMetadata(id, { tags: [] }); // clear tags
```

Requires the server-verified `userfn:feedback:moderate` scope and completed filter backfill. Tags replace the complete set; omitted fields remain unchanged. The awaited receipt contains `{id, tags, productArea}`. Invalid/mismatching receipts reject. The service commits projections atomically and preserves original submission payloads and idempotency keys; board/filter reads use current metadata. Retryable failures replay the same patch. Concurrent edits use database serialization order without a version precondition. Custom services can implement `setMetadata(id, patch)`; absent support fails explicitly.
## Local flag bootstrap

`new UserFnClient({ apiKey, bootstrapFlags: { checkout: false, limit: 0 } })`
uses these resolved values immediately in `getFlag`, including `false`, `0`,
empty strings, arrays and objects. Missing keys use the caller's fallback.
Only own enumerable keys are loaded. No request is made to obtain these values.

`setFlags(definitions)` replaces all local definitions, including bootstrap
values; `setSegments(segments)` configures the segment evaluator used by rules.
Identity changes do not erase configuration. Bootstrap values are already
resolved and have no audience rules: supply an appropriate bootstrap for the
current user, or replace it with rule definitions before switching audiences.
Opt-in explicit verified remote refresh is described below; `refreshInterval`
does not schedule background requests.

## Local flag prerequisites and environments

```ts
const client = new UserFnClient({ apiKey: 'local-config', environment: 'production' });
client.setFlags([
  { key: 'billing-ready', enabled: true, defaultValue: false, variations: [], rules: [],
    environmentOverrides: { production: { defaultValue: true } } },
  { key: 'checkout', enabled: true, defaultValue: 'new', variations: [], rules: [],
    prerequisites: [{ key: 'billing-ready', expectedValue: true }] },
]);
client.getFlag('checkout', 'disabled'); // 'new'
```

Prerequisites are ANDed and compare evaluated JSON values structurally, without
coercing booleans, strings or numbers. All dependencies use the same current user
and client environment. Missing, disabled, unmet or cyclic dependencies make the
requested flag return its **caller-supplied fallback**; a dependency fallback
never satisfies a prerequisite. Choose a safe fallback for gated features.

Environment names are exact and case-sensitive. An omitted or unknown environment
uses base configuration. An override can replace `enabled`, `defaultValue`,
`defaultVariationId` and the complete ordered `rules` array. Omitted fields inherit;
`defaultVariationId: null` clears the inherited variation so `defaultValue` can
apply. A default variation still takes precedence if not cleared. Base
`enabled: false` is a global kill switch that an override cannot re-enable.
Variations and prerequisites remain shared and cannot be replaced by an override.

`setFlags` validates and snapshots definitions atomically; malformed JSON values,
nonfinite numbers, duplicate keys, unknown variation IDs and malformed rules or
overrides throw `TypeError`, preserving the previous configuration. Returned
structured values are copies. Existing segment operators and rule ordering remain
unchanged. See verified remote configuration below for explicit fetch; exposure
transport is added here. See [configuration contract and evidence](../.conduct/flag-context-readiness.md).

### Verified remote configuration

Configure explicit trusted Ed25519 keys and expected tenant/environment, then
await refresh; constructing the client makes no configuration request:

```ts
const client = new UserFnClient({
  apiKey: readerKey,
  endpoint: 'https://userfn.example',
  environment: 'production',
  bootstrapFlags: { checkout: false },
  config: {
    tenantId: 'tenant-a',
    trustedKeys: { 'key-1': publicKeySpkiBase64url },
    timeoutMs: 10_000,
  },
});
await client.refreshConfig(); // true: new verified snapshot; false: verified 304 reuse
client.getFlag('checkout', false);
client.closeConfig(); // permanent config-transport close; no late application
```

Keys are base64url SPKI DER Ed25519 public keys provisioned out of band, not keys
from the response. HTTPS is required; `allowInsecureHttp: true` is an explicit
local-test option. WebCrypto with Ed25519 is required (Node20 acceptance passes;
browser acceptance remains open). The SDK verifies exact UTF-8 bytes, fixed
algorithm/version, expected tenant/environment, trusted key ID and the matching
SHA-256 ETag before applying validated flags and segments synchronously.

A total request deadline, 264 KiB response cap, 4,096 read-chunk cap and 20-level
JSON depth bound protect fetching. Configuration responses must use identity
content encoding; compressed responses are rejected before consuming the body.
Redirects and ambient cookies are disabled. Concurrent refresh calls share one
operation. A 304 is accepted only for the retained verified snapshot. Successful
manual `setFlags/setSegments` calls invalidate conditional reuse. A manual change
or close during a request prevents its late application, even if fetch ignores
abort. Invalid signatures/definitions, authentication failures and timeouts reject
with `ConfigRefreshError` and preserve bootstrap or the last good configuration.

This API is explicit refresh only: `refreshInterval` still does not schedule
requests. Persistent caches, monotonic anti-rollback/freshness policy, automatic
key distribution, browser acceptance and WatchFn exposures remain open.
