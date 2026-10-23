# Phase 15

## Phase goal
Implement `@uifn/files` UI components for pricing/plans, uploading, progress, file listing, and quota usage/analytics.

## In scope
- `PricingPlans`
- `UsageAnalytics`
- `FileDropzone`
- `UploadProgressList`
- `FileList`
- `QuotaUsageBar`

## Out of scope
- Full billing flows (payments, invoices) beyond plan selection UI.

## Deliverables
- `uifn/files/src/index.ts`
- `uifn/files/src/PricingPlans.(tsx|svelte)`
- `uifn/files/src/UsageAnalytics.(tsx|svelte)`
- `uifn/files/src/FileDropzone.(tsx|svelte)`
- `uifn/files/src/UploadProgressList.(tsx|svelte)`
- `uifn/files/src/FileList.(tsx|svelte)`
- `uifn/files/src/QuotaUsageBar.(tsx|svelte)`
- `uifn/files/tests/ui.test.ts`

## Requirements covered
- PKG-004
- UI-001

## Implementation tasks
1. Define component props/events in a framework-agnostic way.
2. Implement the components in the chosen framework(s).
3. Wire components to `@filefn/client` primitives.
4. Add tests that validate:
   - dropzone calls callbacks with files
   - error code display

## Verification steps
1. `npm run build -- --filter=@uifn/files`
2. `npm test -- --filter=@uifn/files`
Expected: exit code 0.

## Stop condition
Report:
- Which framework implementation(s) were shipped.
- Component API reference (props/events) for each component.
