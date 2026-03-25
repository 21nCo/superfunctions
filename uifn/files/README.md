# @uifn/files

Experimental file UX helper/state factories in the `uifn` package family.

## Status

Experimental. This package is public but not part of the GA adapter bar.

The canonical package matrix and compatibility matrix live in the root `uifn/README.md`.

## Installation

```bash
npm install @uifn/files
```

## Usage

```ts
import { createFileDropzone, createUploadProgressList } from "@uifn/files";
```

## Public API

Canonical helper factories (preferred imports):

- `createFileDropzone`
- `createUploadProgressList`
- `createFileList`
- `createQuotaUsageBar`
- `createPricingPlans`
- `createUsageAnalytics`

Compatibility aliases (still shipped, but secondary to the `create*` helpers above):

- `FileDropzone`
- `UploadProgressList`
- `FileList`
- `QuotaUsageBar`
- `PricingPlans`
- `UsageAnalytics`

`@uifn/files` does not claim framework component exports, primitive-family parity, or GA adapter status.

## Release Policy

See the root `uifn/README.md` for the compatibility matrix and the `verify:uifn-release` contract. This package remains Experimental and is only expected to satisfy truthful package-boundary, export-map, and pack-hygiene checks.

## License

MIT
