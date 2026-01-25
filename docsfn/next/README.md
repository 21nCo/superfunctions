# @docsfn/next

Next.js adapter for docsfn - seamlessly integrate documentation into your Next.js App Router applications.

## Installation

```bash
npm install @docsfn/next @docsfn/core
```

## Usage

### Basic Setup

```tsx
// app/docs/[...slug]/page.tsx
import {
  generateStaticParams,
  getPageData,
  generatePageMetadata,
} from "@docsfn/next";
import { buildManifest } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import { DocsLayout, DocsContent } from "@docsfn/react";

const provider = new FsContentProvider({ root: "./docs" });
const manifest = await buildManifest(provider, {
  site: { title: "My Docs", description: "Documentation site" },
});

export async function generateStaticParams() {
  return generateStaticParams(manifest);
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string[] };
}) {
  const page = getPageData(params.slug, manifest);
  if (!page) return {};
  return generatePageMetadata(page, manifest.site.title);
}

export default async function Page({ params }: { params: { slug: string[] } }) {
  const page = getPageData(params.slug, manifest);

  if (!page) {
    notFound();
  }

  return (
    <DocsLayout sidebar={manifest.sidebars.default}>
      <DocsContent page={page} />
    </DocsLayout>
  );
}
```

### Versioned Routes

```tsx
// app/[version]/docs/[...slug]/page.tsx
import {
  generateVersionedStaticParams,
  getVersionedPageData,
} from "@docsfn/next";

export async function generateStaticParams() {
  return generateVersionedStaticParams(manifest);
}

export default async function Page({
  params,
}: {
  params: { version: string; slug: string[] };
}) {
  const page = getVersionedPageData(params.version, params.slug, manifest);
  // ... render page
}
```

### Blog Posts

```tsx
// app/blog/[slug]/page.tsx
import { generateBlogParams, getPostData } from "@docsfn/next";

export async function generateStaticParams() {
  return generateBlogParams(manifest);
}

export default async function Page({ params }: { params: { slug: string } }) {
  const post = getPostData(params.slug, manifest);
  // ... render post
}
```

## API

### `generateStaticParams(manifest)`

Generate static params for `[...slug]` routes.

### `generateVersionedStaticParams(manifest)`

Generate static params for versioned `[version]/[...slug]` routes.

### `getPageData(slug, manifest)`

Get page data from slug array.

### `getVersionedPageData(version, slug, manifest)`

Get versioned page data.

### `generatePageMetadata(page, siteTitle)`

Generate Next.js metadata for a page.

### `generateBlogParams(manifest)`

Generate static params for blog posts.

### `getPostData(slug, manifest)`

Get blog post data.

### `generateApiParams(manifest)`

Generate static params for API references.

### `getApiData(slug, manifest)`

Get API reference data.

## License

MIT
