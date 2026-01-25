# @docsfn/sveltekit

SvelteKit adapter for docsfn - seamlessly integrate documentation into your SvelteKit applications.

## Installation

```bash
npm install @docsfn/sveltekit @docsfn/core
```

## Usage

### Basic Setup

```typescript
// routes/docs/[slug]/+page.server.ts
import { createPageLoad } from "@docsfn/sveltekit";
import { buildManifest } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

const provider = new FsContentProvider({ root: "./docs" });
const manifest = await buildManifest(provider, {
  site: { title: "My Docs" },
});

export const load = createPageLoad(manifest);
export const prerender = true;
```

```svelte
<!-- routes/docs/[slug]/+page.svelte -->
<script lang="ts">
  import { DocsLayout, DocsContent } from '@docsfn/svelte';
  export let data;
</script>

<DocsLayout sidebar={data.manifest.sidebars.default}>
  <DocsContent page={data.page} />
</DocsLayout>
```

### Versioned Routes

```typescript
// routes/[version]/docs/[slug]/+page.server.ts
import { createVersionedPageLoad } from "@docsfn/sveltekit";

export const load = createVersionedPageLoad(manifest);
export const prerender = true;
```

### Manual Load Function

```typescript
// routes/docs/[slug]/+page.server.ts
import { loadPageData } from "@docsfn/sveltekit";

export async function load({ params }) {
  const page = loadPageData(params.slug, manifest);

  return {
    page,
    manifest,
  };
}
```

### Blog Posts

```typescript
// routes/blog/[slug]/+page.server.ts
import { createPostLoad } from "@docsfn/sveltekit";

export const load = createPostLoad(manifest);
export const prerender = true;
```

### API References

```typescript
// routes/api/[slug]/+page.server.ts
import { createApiLoad } from "@docsfn/sveltekit";

export const load = createApiLoad(manifest);
export const prerender = true;
```

## API

### `createPageLoad(manifest)`

Create a load function for pages.

### `createVersionedPageLoad(manifest)`

Create a load function for versioned pages.

### `createPostLoad(manifest)`

Create a load function for blog posts.

### `createApiLoad(manifest)`

Create a load function for API references.

### `loadPageData(slug, manifest)`

Manually load page data (throws 404 if not found).

### `loadVersionedPageData(version, slug, manifest)`

Manually load versioned page data.

### `loadPostData(slug, manifest)`

Manually load blog post data.

### `loadApiData(slug, manifest)`

Manually load API reference data.

### `getStaticPaths(manifest)`

Get all static paths for prerendering.

### `getVersionedStaticPaths(manifest)`

Get all versioned static paths.

### `getBlogPaths(manifest)`

Get all blog post paths.

### `getApiPaths(manifest)`

Get all API reference paths.

## License

MIT
