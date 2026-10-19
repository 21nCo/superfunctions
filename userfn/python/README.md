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

## Feedback delivery boundary

Use `await client.submit_feedback(FeedbackSubmission(...))`. Configure `UserFnOptions(feedback_service=service)` with an async `submit(submission, context)` method returning `FeedbackReceipt(id='stored-id', accepted=True)` after the backing service accepts the submission. The context contains `source='in_app'` and the current identity, or `None` after reset.

Missing configuration, invalid input, or a missing/negative/empty receipt raises an error; service exceptions propagate. `endpoint` and `api_key` alone do not configure this operation. The Python SDK previously had no feedback submission method.

This is a temporary injected service contract, not the specified HTTP/DB backend or proof of persistence. Authentication, durable storage, retries, feedback board/voting, and source integrations remain implementation requirements. Callers must not synthesize acceptance before their backing service accepts the submission.
