# Docsfn

Documentation toolkit for Superfunctions.

## Packages

- **@docsfn/core**: Framework-agnostic core logic.
- **@docsfn/provider-fs**: Filesystem content provider.
- **@docsfn/react**: React UI components (Search, Layout, Sidebar).
- **@docsfn/svelte**: Svelte UI components.
- **@docsfn/cli**: Build and Dev CLI.

## Quick Start (CLI)

1. Create a `docsfn.config.js` (optional).
2. Run `npx docsfn dev`.

```bash
npx docsfn build
```

## Programmatic Usage

```typescript
import { buildManifest } from '@docsfn/core';
import { FsContentProvider } from '@docsfn/provider-fs';

// ... see packages for details
```