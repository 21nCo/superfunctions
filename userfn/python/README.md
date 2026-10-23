# UserFn Python SDK

The official Python SDK for UserFn.

This SDK provides server-side evaluation for UserFn features, allowing you to implement feature flags, user segmentation, and messaging triggers directly in your Python services.

## Features

- **Identity & Segmentation**: Track users and evaluate audience segments based on traits.
- **Feature Flags**: Deterministic, rule-based feature flags with percentage rollouts.
- **Messaging Triggers**: Evaluate eligibility for campaigns (Modals, Banners) based on context and user traits.
- **Cross-Language Consistency**: Uses FNV-1a hashing to ensure consistent flag rollout buckets across Python and TypeScript SDKs.

## Installation

```bash
pip install userfn
```

## Quick Start

```python
from userfn.client import UserFnClient, UserFnOptions

# 1. Initialize Client
client = UserFnClient(UserFnOptions(
    api_key='your-api-key',
    # Optional: Pre-load flags for immediate availability
    bootstrap_flags={'new-feature': True}
))

# 2. Identify User
# Traits are used for rule evaluation (segments, flags)
client.identify('user-123', {
    'email': 'alice@example.com',
    'plan': 'pro',
    'beta_tester': True
})

# 3. Check Feature Flags
# Returns the variation value (boolean, string, number, or dict)
if client.get_flag('new-feature', default_value=False):
    print('Rendering new feature...')

# 4. Check Messaging Triggers
# Check if the user is eligible for any campaigns on this route/event
campaigns = client.trigger('url_match', '/dashboard')

for campaign in campaigns:
    print(f"Triggered campaign: {campaign.id} ({campaign.kind})")
    print(f"Content: {campaign.content.body}")
```

## Core Concepts

### Identity

All evaluations are context-aware. Use `client.identify(id, traits)` to set the current user context. The traits you provide are matched against Segment and Flag rules.

### Feature Flags

Flags are evaluated locally based on the loaded configuration.

- **Rules**: Target specific users or segments.
- **Rollouts**: deterministic percentage-based rollouts (e.g., "50% of users").
- **Variations**: Flags can return complex JSON objects, not just booleans.

### Segments

Define reusable audience rules (e.g., "Pro Users", "Internal Staff"). These are referenced by Feature Flags and Messaging Campaigns.

### Messaging

The Python SDK evaluates **eligibility** for messaging campaigns. Unlike the client-side JS SDK, it does not render UI. It ensures that backend triggers (like an API call or a specific route) adhere to frequency caps and targeting rules defined in your campaigns.

## Usage Guide

### Manual Configuration

If you are running in an environment where you need to inject configuration manually (e.g. testing):

```python
from userfn.types import FlagConfig, FlagVariation, FlagRule

# Define a flag programmatically
my_flag = FlagConfig(
    key='beta-access',
    enabled=True,
    default_value=False,
    variations=[
        FlagVariation(id='on', value=True),
        FlagVariation(id='off', value=False)
    ],
    rules=[
        FlagRule(id='r1', rollout_percentage=10, variation_id='on')
    ]
)

client.set_flags([my_flag])
```

## Development

### Running Tests

```bash
# Install dependencies
pip install -e ".[dev]"

# Run tests
pytest
```

## License

MIT

## Feedback delivery

```python
client = UserFnClient(UserFnOptions(
    endpoint="https://feedback.example.com/userfn",
    api_key="tenant-scoped-token",
    feedback_max_attempts=3,
    feedback_timeout_ms=10000,
))
await client.submit_feedback(
    FeedbackSubmission(title="Improve search", body="Saved queries", category="feature"),
    idempotency_key="submission-123",
)
```

This sends an actual bearer-authenticated POST to `<endpoint>/feedback`. A stable key is reused across bounded retries for network errors, HTTP 408/429 and 5xx. Manual retries should reuse the explicit key and content; conflicting reuse raises `FeedbackHTTPError` with status 409. Other non-retryable statuses fail immediately. Positive, nonempty receipts are required before success. Requests and receipts are limited to 64 KiB, redirects are rejected, and ambient proxy settings are disabled for this credential-bearing transport.

HTTP runs through the standard-library transport on an asyncio worker thread. `feedback_timeout_ms` bounds socket operations, not the total duration of a slow streaming response. Cancelling the awaiting task does not terminate the worker thread or undo a committed write; reuse the same idempotency key when reconciling an uncertain outcome. Attempts are limited to 1–5.

An explicit async `feedback_service` overrides HTTP delivery and retains its awaited receipt contract. Missing configuration fails. Identity remains client metadata, distinct from the server-authenticated actor. See [service setup](../service/README.md). Offline delivery and source integrations remain open.

### Board, votes and status

```python
page = await client.get_feedback_board(limit=20, status="open")
if page["nextCursor"]:
    next_page = await client.get_feedback_board(limit=20, status="open", after=page["nextCursor"])
feedback_id = page["items"][0]["id"]
await client.vote_feedback(feedback_id, 1)  # -1 downvote; 0 remove
await client.set_feedback_status(feedback_id, "planned")
```

Results are dictionaries using the HTTP field names (`items`, `nextCursor`, `viewerVote`). Read, vote and moderate scopes are independent. Voting identity is the verified server principal, not `identify()` metadata; an API key represents one key actor rather than one human. Repeated direction/removal/status writes are idempotent; concurrent changes use the last committed update. Custom services may provide async `list(options)`, `vote(id, direction)` and `set_status(id, status)`; otherwise these operations fail explicitly. Board results are capped at 16 MiB and 100 items. See the service documentation for live pagination and the configurable bounded score projection.

### Filter by tag and product area

```python
await client.submit_feedback(FeedbackSubmission(
    title="Search", body="Improve matching", category="feature",
    tags=["UI"], product_area="Search",
))
after = None
while True:
    page = await client.get_feedback_board(tag="UI", product_area="Search", status="open", limit=20, after=after)
    consume(page["items"])  # Can be empty while scanning makes progress.
    after = page["nextCursor"]
    if after is None:
        break
```

The SDK maps `product_area` to the canonical HTTP `productArea` field. Labels are trimmed, NFC-normalized and case-sensitive. The host must complete the service's normalized-table migration; incomplete migration fails with 503. A per-request scan budget can return partial/empty pages with a non-null progress cursor. Preserve filters and continue until the cursor is null; this is live pagination, not a snapshot.


### Moderate tags and product area

```python
await client.set_feedback_metadata(feedback_id, {"tags": ["UI", "Accessibility"], "productArea": "Search"})
await client.set_feedback_metadata(feedback_id, {"productArea": None})  # retain tags
await client.set_feedback_metadata(feedback_id, {"tags": []})
```

The patch dictionary uses canonical HTTP keys (`productArea`); the awaited result contains `id`, `tags`, and `productArea`. Tags replace the complete set; `None` clears product area; omitted fields are unchanged. Moderator scope and completed backfill are required. Invalid/mismatching acknowledgments reject. Original submissions and idempotency remain immutable while board filters use updated metadata. Retryable failures replay the same patch; concurrent edits have no version precondition. Custom services can implement async `set_metadata(id, patch)`; missing support fails explicitly.
## Local flag bootstrap

`UserFnClient(UserFnOptions(api_key="...", bootstrap_flags={"checkout": False, "limit": 0}))`
uses these resolved values immediately in `get_flag`. Missing keys use the
caller's fallback; false, zero, empty strings, lists and dictionaries remain
valid values. `set_flags(definitions)` replaces all local definitions, including
bootstrap values, and `set_segments(segments)` supplies rule segments.

Identity changes preserve configuration. Bootstrap values have no audience
rules: supply values appropriate to the current user or replace them with rule
definitions before switching audiences. No network request is made for this
bootstrap. Explicit verified remote refresh is described below;
`refresh_interval` is used only after explicit `start_config_refresh()`.

## Local flag prerequisites and environments

```python
from userfn import UserFnClient, UserFnOptions
from userfn.types import FlagConfig, FlagPrerequisite, FlagEnvironmentOverride

client = UserFnClient(UserFnOptions(api_key='local-config', environment='production'))
client.set_flags([
    FlagConfig(key='billing-ready', enabled=True, default_value=False,
               variations=[], rules=[], environment_overrides={
                   'production': FlagEnvironmentOverride(default_value=True)}),
    FlagConfig(key='checkout', enabled=True, default_value='new', variations=[], rules=[],
               prerequisites=[FlagPrerequisite(key='billing-ready', expected_value=True)]),
])
assert client.get_flag('checkout', 'disabled') == 'new'
```

Prerequisites are ANDed and compare evaluated JSON values without boolean/string
coercion. Numbers compare using finite IEEE-754 representation for parity with
JavaScript; use strings for exact identifiers beyond JavaScript numeric precision.
Missing, disabled, unmet or cyclic dependencies return the requested flag's caller
fallback. A dependency fallback cannot satisfy a prerequisite. All dependencies
use the same user and exact, case-sensitive client environment.

`FlagEnvironmentOverride` may replace `enabled`, `default_value`,
`default_variation_id` and the complete `rules` list. Omitted fields inherit;
explicit `default_variation_id=None` clears the inherited default variation.
Base `enabled=False` remains a global kill switch. Prerequisites and variations
are shared across environments. `set_flags` validates and snapshots replacements
atomically, with malformed definitions raising `TypeError`; returned structured
values are copies.

Python rollout hashing now matches TypeScript UTF-16 semantics, including
non-BMP identifiers. Existing Python assignments for such identifiers can change:
read the [hash migration note](../.conduct/flag-hash-parity-readiness.md) before
upgrading mixed SDK deployments. See the [configuration contract and evidence](../.conduct/flag-context-readiness.md)
for remaining remote configuration, exposure and other original gates.

### Verified remote configuration

Install the optional transport/verification dependencies with `pip install
'userfn[config]'`. The core wheel remains dependency-free.

```python
from userfn import UserFnClient, UserFnOptions, SignedConfigOptions

client = UserFnClient(UserFnOptions(
    api_key=reader_key,
    endpoint="https://userfn.example",
    environment="production",
    bootstrap_flags={"checkout": False},
    config=SignedConfigOptions(
        tenant_id="tenant-a",
        trusted_keys={"key-1": public_key_spki_base64url},
        timeout_ms=10_000,
    ),
))
changed = await client.refresh_config()
value = client.get_flag("checkout", False)
client.close_config()
```

No configuration fetch starts at construction. Keys are host-pinned base64url
SPKI DER Ed25519 public keys. The SDK checks exact signed bytes, fixed
algorithm/version, tenant/environment/key identity, matching SHA-256 ETag and
all definitions before applying flags/segments without an await between them.
The camelCase service wire model maps to native dataclasses, including rules,
prerequisites and environment overrides. Concurrent refresh calls coalesce.

HTTPS is required; `allow_insecure_http=True` is an explicit local-test opt-in.
The request has a total deadline, 264 KiB decoded response limit, 4,096 bounded
read chunks and a 20-level JSON depth limit. Identity content encoding is required;
compressed configuration is rejected. Redirects, ambient proxy configuration and
cookies are not used. Transport clients/response streams close after each request.
A 304 can retain only an already verified snapshot. Successful manual
`set_flags/set_segments` calls invalidate it; in-flight results cannot overwrite
manual changes or apply after `close_config`. Errors raise `ConfigRefreshError`
and preserve bootstrap/last-good values. Closing config is permanent for that
client and prevents late application, including cancellation-resistant work.

Persistent caches,
monotonic anti-rollback/freshness policy, key distribution/rotation administration
and WatchFn exposures remain separate requirements.


### Background refresh lifecycle

Set `refresh_interval` in milliseconds (default30,000; allowed100–86,400,000).
Inside a running asyncio loop, call `client.start_config_refresh()`. Start is
idempotent and refreshes immediately, then waits the interval after each settled
request. Requests never overlap. Failures remain visible through
`get_config_refresh_status()` (`last_error`, `consecutive_failures`,
`last_success_at`, `next_refresh_at`, `running`) and back off exponentially to five
minutes or the configured interval when longer. A verified success/304 resets
backoff.

`await client.stop_config_refresh()` cancels and settles active config work before
restart, including an explicit refresh coalesced with it. It retains the verified
ETag and prevents late application. `client.close_config()` synchronously fences
and permanently closes config, cancelling its loop; await stop first when the
caller needs to await settlement. No loop starts at construction, and synchronous
start without a running asyncio loop rejects without leaving a scheduled task.

### Flag exposures to WatchFn

Install `userfn[exposures]` for the optional HTTP transport. Evaluation remains
synchronous and queues metadata; explicitly await delivery from an asyncio loop.

```python
from userfn import UserFnClient, UserFnOptions, ExposureOptions
client = UserFnClient(UserFnOptions(
    api_key="userfn-service-key",
    exposures=ExposureOptions("https://watch.example/ingest", "watch-key", "shop"),
))
client.get_flag("checkout", False)
await client.flush_exposures()
print(client.get_exposure_status())  # pending, dropped, lastError, closed
await client.close_exposures()
```

This is a direct Watch HTTP transport, not a separate Python Watch SDK. It sends
the selected variation/rule IDs, requested flag key, environment and reason
(`rule`, `default_variation`, `default_value`, `bootstrap`, `unavailable`), with
identified user ID when present. It sends no flag values, user traits or credential
properties; prerequisites do not create extra exposures. Every public evaluation
is recorded, including caller fallbacks and bootstrap values.

HTTPS is required unless `allow_insecure_http=True` explicitly enables local HTTP.
`max_queue_size` defaults to 1000 (1–100000), `timeout_ms` to 10000 (1–300000).
Flush coalesces concurrent callers, bounds requests, retains failed events and
raises a fixed error. Retry is explicit and preserves event IDs. Delivery is at
least once: Watch can store duplicate rows after a response is lost. A full queue
or oversized event increments `dropped`; next flush reports rejected captures
once after draining retained events. Close immediately prevents new captures,
then flushes; failed close/flush can be retried. Evaluation after close still
returns its value and records rejected captures. The queue is not durable and
must be flushed before shutdown; it does not run a background thread.

Watch credentials are not tenant-scoped or ingestion-only. Use a trusted proxy or
isolated Watch deployment for mutually untrusted tenants.

### Targeting operator compatibility

Segments and inline flag constraints now share the TS SDK's explicit JSON
contract: boolean/number/string values stay distinct; `equals`/`does_not_equal`
and `in`/`not_in` compare JSON structure. In particular, `True` does not match
`1` in membership. Text `contains`, `does_not_contain`, `startsWith` and `regex`
require strings. Numeric comparisons still accept decimal strings such as `"25"`,
but reject booleans, empty strings, nonfinite values and nondecimal forms.

Assignments relying on old coercion may change. Normalize traits/rules and upgrade
both SDKs together; see the [migration examples](../.conduct/targeting-semantics-readiness.md).
Shared numbers use finite JavaScript precision; exact large identifiers belong
in strings. Prefix/substring matching uses JS UTF-16 units, reusing the rollout
hash conversion. Native regex dialect differences and execution bounds, plus
range/geo/time-window contracts, remain unfinished.

## Consent and forwarded do-not-track

```python
from userfn import UserFnClient, UserFnOptions, ConsentOptions

client = UserFnClient(UserFnOptions(
    api_key="...",
    consent=ConsentOptions(analytics=False, messaging=False),
    do_not_track=False,  # Forward the applicable request preference explicitly.
))
client.set_consent(analytics=True)
client.set_consent(analytics=False)
print(client.get_consent(), client.get_exposure_status()["discarded"])
```

Omitted categories retain enabled behavior for compatibility; `False` denies.
A forwarded `do_not_track=True` vetoes analytics and messaging. Python has no
ambient browser DNT signal: pass it per client/request, and do not share clients
across unrelated identities. `set_consent` validates boolean keyword patches
atomically (`None` means omitted), including `do_not_track`. Resetting identity
does not reset policy.

Denied reads retain their flag value without queuing exposures. Revocation clears
queued entries, cancels owned asynchronous delivery, and fences late completions
from a new queue after regrant. An affected in-flight flush reports withdrawal;
a subsequent empty flush succeeds. `discarded` counts removed queue entries,
separately from overflow/serialization `dropped`; denied reads increment neither.
Regranting never replays old events. Network requests already handed off may still
be accepted remotely; no acknowledged data is retracted. Messaging denial makes
`trigger` return no campaigns before eligibility is evaluated. Config refresh and
explicit feedback remain available. There is no new Python survey renderer, and
consent persistence/collection remains application-owned.

### Durable campaign admission

Configure `UserFnOptions(..., messaging_state_path='/private/session/messages.json')`
with the UserFn service endpoint and a verified user bearer credential. `trigger`
reserves capacity before returning the highest-priority campaign; call
`confirm_message_shown(campaign.id)` after actual presentation. Reuse the private
state path after restart and inspect `get_message_delivery_status()` when a
request or display is uncertain. Capped campaigns require this configuration.
Service-owned `perUser`/`perSession` policy is authoritative; SDK metadata uses
`CampaignCaps(per_user=..., session_cap=...)`. See the
[delivery contract](../.conduct/durable-campaign-caps-readiness.md).


Messaging bearer requests require HTTPS by default. For an owned local HTTP test only, set `messaging_allow_insecure_http=True`; never enable this for production credentials.

Campaigns accept `CampaignSchedule(start_at=..., end_at=...)` from `userfn.types`
and `cooldown_ms`. Timestamps are UTC epoch milliseconds; start is inclusive and
end exclusive. Temporal campaigns require `messaging_state_path` and an
appropriately configured service policy. The service consumes cooldown at durable
reservation, not at `confirm_message_shown`; failed or unknown presentation does
not refund it. The SDK checks receipt expiry before handing a campaign to the
host, including after its journal fsync. Keep clocks synchronized and present the
returned campaign promptly: the SDK cannot cancel arbitrary delayed host UI.
Late confirmation reconciles an existing presentation without consuming cooldown
again. The service README documents the two required timing tables and the
conservative migration for older counters without timestamps.

## Survey response submission

Install `userfn[surveys]` for asynchronous HTTP submission. Configure `endpoint`
and `api_key`, then call:

```python
from userfn import SurveyResponseAnswer
receipt = await client.submit_survey_response(
    'nps', [SurveyResponseAnswer(question_id='score', value=8)],
    idempotency_key=saved_response_key,
)
```

Persist the key before the first attempt and reuse it with identical answers and
the same server identity when the outcome is unknown. The returned receipt
confirms server persistence; client `identify()` does not authorize another user.
`survey_max_attempts` defaults to3 (1–5); `survey_timeout_ms` defaults to10000
(1–60000) per attempt across request and streamed receipt. Redirects, ambient
proxy configuration and cookies are excluded by the fresh HTTP client. Requests
and receipts are bounded to64KiB. Permanent errors, including cap denial429, do
not retry automatically. Task cancellation cancels transport but cannot reverse
a committed response. Explicit submissions do not use passive messaging consent.
Local survey candidates are available through `set_surveys(...)` and
`get_eligible_surveys(trigger_type, context)`. They require an identified user and
messaging consent, match event/URL substrings and configured segments, and apply
per-identity local response counts. An omitted cap (`SurveyCaps(None)`) defaults
to one; zero or malformed caps deny. Successful explicit submissions count once
per receipt for the identity captured before the request, even if identity changes
while awaiting it. Failed/uncertain attempts do not count until acknowledged.
These counts survive configuration replacement within this client, but not process
restart. Local identity and caps do not replace server authorization or durable
caps; receipts must come from the configured service. Browser rendering, persistent
submission queues, complete survey scheduling/branching and automatic WatchFn
analytics remain unfinished.


Survey question metadata also supports `ces` and `scale`, and
`QuestionCondition(question_id='earlier', equals=False)` through `Question.when`.
These describe the same server/browser policy: primitive exact equality against an
earlier question. The Python SDK does not render forms or authorize hidden answers;
the configured service validates each submitted response.
