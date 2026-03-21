# @uifn/files

Experimental file UX state helpers in the `uifn` package family.

## Status

Experimental

Phase 06 boundary decision: `@uifn/files` remains public inside the `uifn` package family as an Experimental package.

## Installation

```bash
npm install @uifn/files
```

## Public API

This package currently exports typed factory helpers (not framework UI components):

- `createFileDropzone`
- `createUploadProgressList`
- `createFileList`
- `createQuotaUsageBar`
- `createPricingPlans`
- `createUsageAnalytics`

The package boundary is intentionally narrow: it provides file UX state/helper factories and does not claim parity with the core primitives adapter catalog.

## Compatibility

- Node.js: `18.x`, `20.x`, `22.x`

## License

MIT
