# Docsfn

Documentation toolkit for Superfunctions.

## Packages

- **@docsfn/core**: Framework-agnostic core logic (manifest generation, types, search).
- **@docsfn/provider-fs**: Filesystem content provider (docs, blog, api).
- **@docsfn/react**: React UI adapters (Layout, Sidebar, TOC).

## Usage

```typescript
import { FsContentProvider } from '@docsfn/provider-fs';
import { buildManifest, buildSearchIndex } from '@docsfn/core';

const provider = new FsContentProvider({
  root: process.cwd(),
  docsDir: 'docs',
  blogDir: 'blog',
  apiDir: 'api'
});

const manifest = await buildManifest(provider, {
  site: { title: 'My Docs' }
});

// Generate search index
const searchSnapshot = await buildSearchIndex(manifest);
```

## UI Usage (React)

```tsx
import { DocsLayout } from '@docsfn/react';

export default function Page({ page, sidebar }) {
  return (
    <DocsLayout 
      sidebar={sidebar} 
      headings={page.headings}
    >
      <div dangerouslySetInnerHTML={{ __html: page.body }} />
    </DocsLayout>
  );
}
```
