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

An explicit `feedbackService` still overrides HTTP delivery and must implement the awaited `FeedbackService` receipt contract. Without either service or endpoint, submission rejects. Signed configuration refresh is described below; offline feedback queues, external-source ingestion and browser feedback acceptance remain open. See [service setup](../service/README.md). Use narrowly scoped credentials in browser clients; never embed an administrative key.

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
is used only after explicit `startConfigRefresh()`.

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
await client.closeConfig(); // permanent config-transport close; no late application
```

Keys are base64url SPKI DER Ed25519 public keys provisioned out of band, not keys
from the response. HTTPS is required; `allowInsecureHttp: true` is an explicit
local-test option. WebCrypto with Ed25519 is required (Node20 and Chrome154 acceptance pass;
other browser engines remain open). The SDK verifies exact UTF-8 bytes, fixed
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

Persistent caches, monotonic anti-rollback/freshness policy, automatic
key distribution, cross-browser/load acceptance and WatchFn exposures remain open.


### Background refresh lifecycle

Set `refreshInterval` in milliseconds (default30,000; allowed100–86,400,000), then
call `client.startConfigRefresh()`. Start is idempotent and refreshes immediately;
subsequent requests start only after the previous request settles plus the
interval. Failures preserve values and back off exponentially up to five minutes
(or the configured interval when longer), resetting after a verified success/304.
`getConfigRefreshStatus()` exposes running state, consecutive failures, last error,
last successful refresh time and next scheduled time. No rejection is left
unobserved by the loop.

Always `await client.stopConfigRefresh()` before restarting. Stop cancels active
configuration work and awaits its settlement; it preserves the verified ETag for
restart, but prevents late application. It also cancels any explicit refresh
coalesced with the active request. `await client.closeConfig()` permanently closes
configuration and stops the loop. Constructors still make no network requests.
Node timers are unref'ed; the optional loop alone does not keep a process alive.

### Flag exposures to WatchFn

Configure a separate authenticated Watch ingestion endpoint to record flag
exposures. Evaluation still returns its value synchronously. The SDK reuses
`@watchfn/browser` with RUM disabled; it does not emit page views or user traits.

```ts
const client = new UserFnClient({
  apiKey: 'userfn-service-key',
  exposures: { endpoint: 'https://watch.example/ingest', apiKey: 'watch-key', app: 'shop' },
});
client.getFlag('checkout', false); // Starts bounded asynchronous delivery.
await client.flushExposures();
console.log(client.getExposureStatus()); // pending, dropped, lastError, closed
await client.closeExposures();
```

Events contain the requested flag key, selected variation/rule IDs, environment
and reason (`rule`, `default_variation`, `default_value`, `bootstrap` or
`unavailable`), plus an identified user ID when present. Values, traits and keys
are not event properties. Prerequisite evaluation does not create extra exposures;
equal-valued variations retain their actual selected IDs. Each public evaluation
is an exposure, with no sampling or deduplication.

HTTPS is required; local tests can explicitly set `allowInsecureHttp:true`.
`maxQueueSize` defaults to 1000 (1–100000), `timeoutMs` to 10000 (1–300000).
Failed requests remain queued; `flushExposures` reports failure and explicitly
retries them. IDs remain stable on retry, but Watch ordinary events are
**at least once**: a lost response after persistence can produce duplicate rows.
A full queue or oversized event increments `dropped` without changing evaluation;
the next flush reports those rejected captures once, even if retained events were
delivered. Close fences new capture immediately and drains; a failed close can be
retried. Post-close evaluations still return values and count rejected exposures.
The queue is in memory and is lost on process/page termination.

Watch keys currently authorize more than ingestion and are not tenant-scoped.
Use a trusted application proxy or an appropriately isolated Watch deployment;
this option does not create a browser-safe, tenant-scoped credential.

### Campaign content and CTA URLs

Campaign title/body strings are rendered as literal text in modal and toast
messages. HTML previously interpolated into toast strings is now displayed
literally; the SDK does not currently implement the specification's safe
rich-text/Markdown subset. Do not rely on embedded HTML for formatting.

CTA URLs permit HTTP(S), relative/query/fragment links, `mailto:` and `tel:`.
Executable or unsupported schemes (including `javascript:`, `data:`, `file:` and
`blob:`) and malformed URLs are rejected without navigation. URLs are checked
again when clicked, including after campaign objects are mutated. Applications
remain responsible for choosing trusted destinations and redirect behavior.

### Targeting operator compatibility

Segments and inline flag constraints use type-sensitive JSON equality for
`equals`/`does_not_equal` and array membership `in`/`not_in`. Objects compare
structurally (key order ignored), arrays retain order, and booleans never equal
numbers or strings. Text operators `contains`, `does_not_contain`, `startsWith`
and `regex` require string operands. Numeric comparisons retain decimal-string
support (`"25" >= 18`), but reject booleans, empty strings and nonfinite/hex inputs.
Missing/null traits remain absent; negative operators do not match invalid inputs.

This changes assignments that relied on implicit coercion or object identity.
Normalize traits/rule values explicitly and upgrade TS/Python together; see the
[semantic contract and migration examples](../.conduct/targeting-semantics-readiness.md).
`startsWith` is case-sensitive. Prefix/substring matching follows JS UTF-16 units
in both SDKs. Regex still uses each language's native engine; range, geo and
time-window operators and bounded regex execution remain unfinished.

## React and Svelte flags

React 18 and 19 are optional peers. The vanilla `userfn` entry and the structural
Svelte store adapter do not import either framework.

```tsx
import { UserFnClient } from 'userfn';
import { UserFnProvider, useFlag } from 'userfn/react';

// Own this client outside rendering; use a separate instance per SSR request.
const client = new UserFnClient({ apiKey: '...', bootstrapFlags: { feature: false } });
function Feature() {
  const enabled = useFlag('feature', false);
  return enabled === true ? <NewFeature /> : <OldFeature />;
}
<UserFnProvider client={client}><Feature /></UserFnProvider>;
```

For Svelte, use the readable-store contract with ordinary `$store` subscription:

```svelte
<script>
  import { flagStore } from 'userfn/svelte';
  export let client;
  $: feature = flagStore(client, 'feature', false);
</script>
{#if $feature === true}<p>Feature enabled</p>{/if}
```

Both helpers update after `identify`, `reset`, `setFlags`, `setSegments`, and
successful verified config refreshes. A verified 304 or failed refresh does not
publish a change. Change traits and segment definitions through these methods;
mutating previously supplied objects is not a notification mechanism. Snapshot
JSON values are deeply frozen. Return types remain `FlagValue`: the fallback
alone cannot guarantee the type of a remotely configured variation.

React uses `useSyncExternalStore` and emits configured Watch exposures only in a
committed effect. SSR and abandoned renders emit none; StrictMode effect replay
emits once per observation snapshot. Svelte emits when it delivers a browser
subscription value, not during SSR. Multiple subscribers to the same Svelte store
share its exposure identity. A new committed client revision, including A→B→A
or identity reset, is a new selection and can emit again. A remount/new store is
also a new observation. These are selection exposures, not viewport visibility
or exactly-once analytics.

The provider and stores never start or close config refresh or exposure delivery.
The application owns `startConfigRefresh`, `stopConfigRefresh`, `closeConfig`,
`flushExposures`, and `closeExposures`. Use the same bootstrap and identity on the
server and the browser for hydration, and do not share a mutable client between
SSR requests.

Other framework integrations can use `client.observeFlag(key, fallback)`. Its
`getSnapshot()` is stable until a published client revision and has no exposure
side effects; `subscribe(listener)` returns an idempotent unsubscribe. Call
`track(snapshot)` only after consuming that exact snapshot. Tracking is idempotent
per snapshot, retains its original identity/rule even if state changes before
commit, and rejects a snapshot from a different observation.

## Consent and do-not-track

```ts
const client = new UserFnClient({
  apiKey: '...',
  consent: { analytics: false, messaging: false },
  doNotTrack: false, // Forward a request/browser preference when using SSR.
});
client.setConsent({ analytics: true });
client.setConsent({ messaging: true });
client.setConsent({ analytics: false }); // Discard unsent exposures and cancel owned delivery.
console.log(client.getConsent(), client.getExposureStatus().discarded);
```

Omitted consent flags retain enabled behavior for compatibility. Explicit `false`
denies that category. A forwarded `doNotTrack: true`, or a live browser
`navigator.doNotTrack`/`window.doNotTrack` equal to `"1"` or `"yes"`, vetoes both
categories even when the application grants them. `setConsent` accepts validated
boolean patches, including `doNotTrack`; invalid patches apply nothing. Identity
`reset()` does not grant consent. Browser signals are checked at API, delivery
and UI-interaction boundaries; there is no continuous DNT observer.

Analytics denial leaves flag values and signed config refresh available but
prevents new flag exposures, including framework committed effects. Revocation
clears queued exposures and aborts owned in-flight delivery. An already-pending
flush rejects when discarded; a later empty flush succeeds. `discarded` counts
queued entries removed (including entries handed to an in-flight request), while
`dropped` remains overflow/serialization failures. Denied evaluations increment
neither count. Regranting does not replay discarded events or pre-withdrawal
framework snapshots. New reads/selections can emit again.

A request already handed to the network may have been accepted remotely; abort
cannot retract it, and this API does not delete acknowledged server data.
Messaging denial blocks campaign/survey triggers and callbacks and removes only
this client's active campaign/survey elements and timers. It leaves other clients'
UI and explicitly opened feedback forms intact. Local flags, configuration,
identity and user-requested feedback are not treated as analytics. The existing
`track`/`render` placeholders are gated but remain placeholders. Consent collection,
storage across reloads, and selecting the application's initial flags are owned
by the application.

### Durable campaign caps and async triggers

Capped campaigns require service-backed admission. Configure a stable journal
namespace per authenticated application session and await the existing trigger:

```ts
const client = new UserFnClient({
  apiKey: verifiedUserBearer,
  endpoint: 'https://userfn.example',
  messaging: { storageKey: stableAuthenticatedSessionKey },
});
client.identify(localUserId);
client.setCampaigns(campaigns);
await client.trigger('event', 'show');
```

The service must supply trusted `perUser`/`perSession` policies and verified
session identity. Browser delivery uses localStorage plus Web Locks. Lost
responses retain a stable reservation; `getMessageDeliveryStatus()` reports
pending/shown/uncertain states. An uncertain presentation is not redisplayed
or refunded automatically. Handle trigger rejection and preserve the journal
across reloads. See [the migration contract](../.conduct/durable-campaign-caps-readiness.md).
