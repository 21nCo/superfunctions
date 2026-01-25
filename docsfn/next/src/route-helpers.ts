import type {
  DocsManifest,
  DocPage,
  BlogPost,
  ApiReference,
} from "@docsfn/core";

/**
 * Generate static params for Next.js App Router [...slug] routes
 */
export function generateStaticParams(manifest: DocsManifest) {
  return Object.values(manifest.pages).map((page) => ({
    slug: page.slug.split("/").filter(Boolean),
  }));
}

/**
 * Generate static params for versioned routes
 */
export function generateVersionedStaticParams(manifest: DocsManifest) {
  if (!manifest.versions || manifest.versions.length === 0) {
    return generateStaticParams(manifest);
  }

  const params: Array<{ version: string; slug: string[] }> = [];

  for (const version of manifest.versions) {
    const versionPages = Object.values(manifest.pages).filter(
      (p) => p.version === version.slug
    );

    for (const page of versionPages) {
      // Remove version prefix from slug
      const slug = page.slug.replace(new RegExp(`^${version.slug}/`), "");
      params.push({
        version: version.slug,
        slug: slug.split("/").filter(Boolean),
      });
    }
  }

  return params;
}

/**
 * Get page data from slug array
 */
export function getPageData(
  slug: string[],
  manifest: DocsManifest
): DocPage | null {
  const path = "/" + slug.join("/");
  const id = manifest.routes[path];
  return id ? manifest.pages[id] : null;
}

/**
 * Get page data for versioned route
 */
export function getVersionedPageData(
  version: string,
  slug: string[],
  manifest: DocsManifest
): DocPage | null {
  const path = `/${version}/${slug.join("/")}`;
  const id = manifest.routes[path];
  return id ? manifest.pages[id] : null;
}

/**
 * Get blog post data
 */
export function getPostData(
  slug: string,
  manifest: DocsManifest
): BlogPost | null {
  const path = `/blog/${slug}`;
  const id = manifest.routes[path];
  return id ? manifest.posts[id] : null;
}

/**
 * Get API reference data
 */
export function getApiData(
  slug: string,
  manifest: DocsManifest
): ApiReference | null {
  const path = `/api/${slug}`;
  const id = manifest.routes[path];
  return id ? manifest.apis[id] : null;
}

/**
 * Generate metadata for a page (for Next.js metadata API)
 */
export function generatePageMetadata(page: DocPage, siteTitle: string) {
  return {
    title: `${page.title} | ${siteTitle}`,
    description: page.description || `Documentation for ${page.title}`,
  };
}

/**
 * Generate all blog post params
 */
export function generateBlogParams(manifest: DocsManifest) {
  return Object.values(manifest.posts).map((post) => ({
    slug: post.slug,
  }));
}

/**
 * Generate all API reference params
 */
export function generateApiParams(manifest: DocsManifest) {
  return Object.values(manifest.apis).map((api) => ({
    slug: api.slug,
  }));
}
