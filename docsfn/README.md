# Docsfn

Documentation toolkit for Superfunctions.

## Packages

- **@docsfn/core**: Framework-agnostic core logic (manifest generation, types).
- **@docsfn/provider-fs**: Filesystem content provider.
- **@docsfn/react**: React UI adapters.

## Usage

```typescript
import { FsContentProvider } from '@docsfn/provider-fs';
import { buildManifest } from '@docsfn/core';

const provider = new FsContentProvider({
  root: process.cwd(),
  docsDir: 'docs'
});

const manifest = await buildManifest(provider, {
  site: { title: 'My Docs' }
});

console.log(manifest);
```