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
- **Network**: (Coming Soon) Syncs events and config with the UserFn service.

## License
MIT

## Feedback delivery boundary

`submitFeedback()` now rejects with `FeedbackDeliveryError` when no `feedbackService` is configured. Setting `endpoint` or `apiKey` alone does not configure feedback delivery. The previous console-only success behavior has been removed. The feedback widget awaits the same operation and keeps its existing failure state on rejection.

Provide an application service implementing `FeedbackService.submit(submission, context)`. It receives the original submission and `{ source: 'in_app', user }`, using the current identity or `null` after reset. It must resolve with `{ id: '<stored-feedback-id>', accepted: true }` only after its backing service accepts the submission. Void, missing/empty IDs, and negative acknowledgments are rejected; exceptions propagate to the caller. Submission content is no longer logged by the feedback engine.

This injected interface is a temporary compatibility boundary. It does not implement the specified dedicated UserFn HTTP/DB service, authentication, persistence, offline retries, board/voting, or external-source ingestion. Applications must provide those guarantees behind the service; the SDK cannot independently verify a receipt. The internal feedback board placeholder now rejects instead of returning a misleading empty list.
