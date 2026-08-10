# PHASE_15: Controlled Product Patterns

## Phase Goal

Implement backend-agnostic product patterns in `@uifn/patterns`.

## In Scope

- AuthPanel
- ApiKeyTable
- SessionList
- UserProfileCard
- ProviderPicker
- OAuthConnectionsPanel
- WebhookEndpointTable
- FileDropzonePanel
- UploadProgressList
- FileListPanel
- QuotaUsagePanel
- BillingPlanCards
- SubscriptionStatusPanel
- InvoiceTable

## Out of Scope

- Direct Superfunction clients.

## Deliverables

- `uifn/patterns/src/*`
- pattern manifests
- pattern fixtures
- pattern stories
- pattern tests
- source-installable pattern registry items

## Requirements Covered

PAT-001, REG-001, STORY-001, STORY-002

## Implementation Tasks

1. Define shared pattern data contracts.
2. Implement controlled pattern components.
3. Add loading, empty, error, partial, permission denied, optimistic, and success fixtures.
4. Add stories across themes and viewports.
5. Add registry items.
6. Verify no Superfunction package imports.

## Verification Steps

```bash
npm --workspace @uifn/patterns run test
npm run verify:uifn-patterns
```

Expected outcome: patterns pass controlled-state, fixture, story, and no-backend-import checks.

## Stop Condition

Report pattern APIs and state coverage.

