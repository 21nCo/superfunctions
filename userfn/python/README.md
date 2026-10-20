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
