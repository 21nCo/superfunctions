# Fourteen Superfunction-Backed Variants

- timestamp: 2026-06-28T05:26:42Z
- requirements: SF-002, SF-001 partial, STORY-001, TEST-001
- scope: `@uifn/sf`, `uifn/registry/catalog/sf`, `scripts/verify-uifn-sf.mjs`

## Previous State

The high-level SF verifier enforced seven backed variants. That matched the narrow SF-002 acceptance list but missed the broader detailed patterns subspec, which listed 14 backed variants across authfn, plugfn, filefn, and billfn.

Missing variants:

- `AuthFnSessionList`
- `AuthFnUserProfileCard`
- `PlugFnWebhookEndpointTable`
- `FileFnUploadProgressList`
- `FileFnFileListPanel`
- `FileFnQuotaUsagePanel`
- `BillFnInvoiceTable`

## Final State

The broader 14-variant set is implemented and verified:

- authfn: `AuthFnAuthPanel`, `AuthFnApiKeyTable`, `AuthFnSessionList`, `AuthFnUserProfileCard`
- plugfn: `PlugFnProviderPicker`, `PlugFnOAuthConnectionsPanel`, `PlugFnWebhookEndpointTable`
- filefn: `FileFnFileDropzonePanel`, `FileFnUploadProgressList`, `FileFnFileListPanel`, `FileFnQuotaUsagePanel`
- billfn: `BillFnBillingPlanCards`, `BillFnSubscriptionStatusPanel`, `BillFnInvoiceTable`

The implementation adds typed injected client methods, fake-only mock data, registry manifests, fixtures, story metadata, package tests, README docs, and verifier enforcement for all 14 variants.

## Verification

Passed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/sf run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/sf run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/sf run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-sf.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-registry.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-catalog.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-stories.mjs`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/storybook run test`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

Full release summary:

```json
{
  "ok": true,
  "summary": {
    "total": 81,
    "passed": 81,
    "failed": 0,
    "planned": 0,
    "blockingFailures": 0
  },
  "sfCheck": {
    "panelCount": 14
  }
}
```

## Remaining Work

SF-002 is complete. SF-001 remains open for deeper state coverage because the detailed pattern subspec also calls out empty, permission-denied, degraded network, and unsupported capability states beyond the current backed verifier matrix.
