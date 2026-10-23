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


Messaging bearer requests require HTTPS by default. For an owned local HTTP test only, set `messaging.allowInsecureHttp: true`; never enable this for production credentials.

Campaign metadata now accepts `schedule: { startAt?, endAt? }` in UTC epoch
milliseconds and `cooldownMs`. Start is inclusive and end exclusive. Temporal
campaigns require durable messaging; matching client metadata does not replace
the service's trusted policy. Cooldown counts reservations per verified user and
campaign across sessions, so lost acknowledgements or failed rendering never
refund it. SDK receipt expiry is checked after the HTTP response and again after
writing the presentation fence. A delayed `shown` acknowledgement still reconciles
without redisplay. Keep client/server clocks synchronized: schedule enforcement
covers admission and UI handoff, not cancellation of a visible message. Apply the
new timing tables described in the service README before upgrading the service.


### Local survey response boundaries

Survey response counts are isolated by user ID and survey ID for this client
instance. The legacy `caps.global` name controls that local per-user response
limit: omission defaults to one, zero prevents eligibility, and malformed limits
fail closed. Returning to an earlier identity retains its local count. An
identity change or messaging-consent withdrawal invalidates existing survey
submission callbacks; each presentation accepts at most one matching response.

These counts are process-local. They do not survive reloads or coordinate other
clients. The separate survey service persists responses and enforces lifetime and rolling
response quotas. This local renderer is not connected to that service yet.
Durable display admission and analytics delivery remain unfinished; local
acceptance is not a server persistence receipt.

### Submit a survey response

`submitSurveyResponse(surveyId, answers, {idempotencyKey})` submits explicit
answers to the configured UserFn service and returns its verified persistence
receipt. Generate and persist a key for each intended response before calling;
reuse that key with identical answers after a timeout or lost response. Keep the
same verified server credential when reconciling. Local `identify()` values do
not override the service's authenticated user. The service controls questions,
audience and response quotas.

```ts
const receipt = await client.submitSurveyResponse('nps', [
  {questionId: 'score', value: 8}
], {idempotencyKey: savedResponseKey});
```

`surveyMaxAttempts` defaults to3 (range1–5); `surveyTimeoutMs` defaults to10000
(range1–60000) per attempt, including response-body consumption. Retries preserve
the serialized body and key. Cap denial429 and other permanent4xx errors are
returned without automatic retries. Redirects and ambient cookies are disabled;
requests and receipts are bounded to64KiB. Cancellation or timeout cannot undo a
server commit. Explicit submission is user initiated and does not depend on
passive messaging consent. The renderer uses the service when an endpoint is configured, as described below;
there is no automatic durable queue or analytics forwarding.

### Survey renderer acknowledgements and retries

With `endpoint` configured, the survey's Submit button now awaits a verified
service receipt before displaying **Response saved** or consuming its local
response count. It makes one bounded network attempt per click; `surveyMaxAttempts`
continues to govern the direct `submitSurveyResponse` API, not renderer clicks.
Pending controls are disabled. A timeout, lost response or denial keeps the form
open with an explicit Retry submission action and no success claim.

The client retains one immutable answer payload and key per local user/survey
after its first attempt, including across dismissal and reopen within that client.
Retries cannot change those answers or silently allocate another key. Up to100
unresolved attempts are retained; at capacity new submissions fail before sending
and existing attempts are not evicted. Successful reconciliation removes the entry.
Identity/reset/consent changes fence stale callbacks and dismiss survey UI. A late
receipt remains available only to the original local identity in the same client;
it cannot resurrect the old UI or acknowledge for a different identity. Credentials
are captured by the HTTP transport at client construction; create a new client for
a different authenticated server identity. Local `identify()` never changes the
server credential.

By default these pending answers live only in memory. **Keep the page open after
an unknown outcome unless you opted into the browser journal below.** Reloading,
closing the tab or replacing the client otherwise loses retry state. A server commit cannot be
undone by closing the form, withdrawing consent or timing out an in-flight request.
The service remains authoritative for accepted-response quotas. The opt-in browser
journal below supports reload recovery; automatic offline delivery is not provided.

Without an endpoint, existing local survey behavior remains available; completion
says **Response recorded locally** and does not imply server acceptance. Empty
surveys require an explicit Submit click. Optional unanswered questions are omitted,
CSAT defaults are1–5 (NPS0–10), and choice inputs retain their configured scalar
values. Branching, richer templates and automatic analytics forwarding remain open.


## Conditional surveys and scales

Question types include `nps` (default0–10), `csat` (1–5), `ces` (1–7),
`scale` (1–5), `text` and `choice`. Numeric scales accept integer `min`/`max`
overrides with a span of at most100. The service rejects invalid policy scales;
existing policies with a larger span must be narrowed before using this version.

A question can declare `when: { questionId: 'earlier-question', equals: false }`.
The reference must point to an earlier question; equality preserves primitive
string/number/boolean types without coercion. Missing answers hide the dependent
question. Hidden required questions are skipped; the service rejects submitted
answers to hidden questions and requires all visible required answers. Forward,
self and unknown references, duplicate IDs and nonprimitive conditions are invalid.
The renderer and service share this contract. Skipping the remaining questions
still requires an explicit submission confirmation. Pending retries retain their
original answers and idempotency key.

This is basic forward conditional visibility, not arbitrary expression evaluation
or a looping form graph. Python durable client journals and full survey analytics remain
open.


Survey schedules use `schedule: { startAt, endAt }` with UTC epoch milliseconds, inclusive start
and exclusive end. Omitted bounds mean zero and the maximum supported date.
Invalid/reversed intervals reject configuration. Candidate eligibility uses the
client clock; the service independently enforces its trusted policy and server
clock inside response admission. A committed receipt can still be replayed with
the same key and answers after expiry; an expired new response rejects without
consuming a cap. Client configuration never overrides server policy.


### Opt-in browser survey journal

```typescript
const client = new UserFnClient({
  apiKey: 'user-scoped-service-credential',
  endpoint: 'https://your-service.example',
  surveyJournal: { storageKey: 'product-surveys-v1' },
});
```

This persists renderer submissions in `localStorage` under
`userfn.surveys.product-surveys-v1`. It requires Web Locks and Web Crypto in a
secure browser context; missing capabilities or inaccessible/corrupt storage fail
closed. The direct `submitSurveyResponse` API remains caller-keyed and does not
use this journal. Python retains its existing in-memory behavior.

Before the first request, the journal saves an immutable answer payload and UUID.
A lost response, timeout, reload or tab closure keeps that same payload/key
available for explicit retry. Only a verified receipt followed by a successful
local write removes pending answers and increments the accepted count. Failed
receipt persistence leaves the saved key retryable. No background delivery or
scheduled retry runs. A pending attempt may be reopened after local schedule
expiry solely to replay its frozen payload; the server decides whether it is an
already-accepted replay or a denied new response. Recovery requires the survey
still be supplied through `setSurveys`; it does not restore survey definitions.

Same-origin cooperating tabs sharing the storage key use a Web Lock held across
the request and receipt write. A stale peer form cannot allocate another key
when the saved count changed. Waiting for that lock has no deadline: a suspended
tab or another same-origin lock holder can delay it. A timeout bounds each active
request when browser timers run, not total lock-wait time or browser suspension.
Different origins, partitions, profiles, devices or independently chosen storage
keys do not coordinate. A custom `storage` must provide durable, atomic synchronous
`getItem`/`setItem` semantics shared by those same cooperating tabs; a memory-only
adapter cannot provide reload durability. This is not hostile-process isolation.

**Privacy and retention:** pending answers, local user IDs and survey IDs are
stored in plaintext and can be read by other scripts on the origin. The stored
SHA-256 endpoint/credential scope is a mismatch check, not encryption or access
control. Credentials themselves are not stored, but weak credentials may be
recoverable by guessing their hash. Use only where persistent answer storage is
appropriate. Identity change or consent withdrawal dismisses/fences UI and stops
new admission; it does not erase an existing journal or undo an in-flight server
commit. Late receipts remain associated with the original local owner. Credential
or endpoint changes with the same key reject access instead of replaying under
new credentials; hosts must plan rotation/reconciliation explicitly.

There is no automatic expiration or eviction. Both pending attempts and completed
counts occupy up to100 user/survey entries; the serialized journal is capped at
262144 UTF-8 bytes, and each answer payload at65536 bytes/100 answers. These are
logical payload bounds, not a browser disk quota. Capacity/quota failures prevent
new sends; uncertain entries are never evicted to make room. Hosts own retention
and deletion (for example `localStorage.removeItem('userfn.surveys.product-surveys-v1')`)
and must coordinate it with active tabs and unresolved receipts. Deletion or
browser eviction loses replay keys and counts, so a later submission may get a
new key; service-side quotas remain authoritative. No automatic deletion on logout,
consent withdrawal, credential rotation or service retention expiry is claimed.

### Open a survey explicitly

`await client.openSurvey('survey-id')` opens that configured survey using the
same dialog, validation and submission path as automatic triggers. It returns
`true` when presented and `false` when no renderer/identity is available, consent
is denied, the ID is unknown or the survey is ineligible. Malformed IDs throw.
Explicit opening selects the survey without matching its automatic URL/event
triggers or displaying an unrelated campaign. Enabled state, audience, schedule
and response caps still apply. Configured journal recovery can surface a frozen
pending response after local expiry, with service replay/admission authoritative.

```ts
client.setSurveys([{ id: 'checkout-score', enabled: true, triggers: [],
  questions: [{ id: 'score', type: 'csat', title: 'How was checkout?', required: true }],
  caps: { global: 1 } }]);
const shown = await client.openSurvey('checkout-score');
```

Opening does not imply service acceptance: the dialog reports local recording or
verified service storage only after submission. This API uses the modal renderer;
an inline mounting API remains separate work. Python has no browser renderer.

### Embeddable feedback board

```ts
const board = client.mountFeedbackBoard(document.querySelector('#feedback')!, {
  title: 'Product feedback', limit: 20, status: 'open',
});
// Reload the selected filters after a host-side change.
await board.refresh();
// Remove only this board, preserving the container's other content.
board.dispose();
```

The board lists feedback through the configured service with status, tag and
product-area filters, explicit pagination, and upvote/downvote/remove-vote
controls. Text is rendered as text, including titles and bodies. Labels, live
status, pressed vote state and focus restoration use native accessible elements.
The board updates votes only after a matching receipt. After an uncertain vote,
voting stays disabled until a successful refresh reads authoritative state.
Refresh is available after load errors; it resets pagination. At most1,000 items
are displayed; narrow filters beyond that bound. Cursor pages are live views,
not a snapshot or a ranked/sorted export.

`identify` and `reset` dispose all boards owned by that client and ignore late
responses. They do not change the API credential: recreate the client when the
verified server identity changes. Explicit disposal also ignores late results;
existing requests can finish within the HTTP transport's configured timeout.
Dispose the handle when its host component unmounts. Each board appends its own
section without replacing other container children. Avoid mounting multiple
boards in the same region unless you deliberately want independent views.

This is an explicitly mounted read/vote UI; it does not emit analytics or start
messaging automatically. Service authorization and tenant isolation remain
mandatory. Feedback creation is available through the separate widget/API;
moderation, ranked sorting, external-source ingestion and merge tools remain
separate requirements. Python uses the same existing listing/voting endpoints
and has no browser renderer.
