import type {
  DocsManifest,
  DocPage,
  BlogPost,
  ApiReference,
} from "@docsfn/core";
import { error } from "@sveltejs/kit";
import type { LoadEvent } from "@sveltejs/kit";

/**
 * Get all static paths for prerendering
 */
export function getStaticPaths(manifest: DocsManifest) {
  return Object.values(manifest.pages).map((page) => ({
    params: {
      slug: page.slug,
    },
  }));
}

/**
 * Get versioned static paths
 */
export function getVersionedStaticPaths(manifest: DocsManifest) {
  if (!manifest.versions || manifest.versions.length === 0) {
    return getStaticPaths(manifest);
  }

  const paths: Array<{ params: { version: string; slug: string } }> = [];

  for (const version of manifest.versions) {
    const versionPages = Object.values(manifest.pages).filter(
      (p) => p.version === version.slug
    );

    for (const page of versionPages) {
      const slug = page.slug.replace(new RegExp(`^${version.slug}/`), "");
      paths.push({
        params: {
          version: version.slug,
          slug,
        },
      });
    }
  }

  return paths;
}

/**
 * Load page data from slug
 */
export function loadPageData(slug: string, manifest: DocsManifest): DocPage {
  const path = slug.startsWith("/") ? slug : `/${slug}`;
  const id = manifest.routes[path];
  const page = id ? manifest.pages[id] : null;

  if (!page) {
    throw error(404, `Page not found: ${slug}`);
  }

  return page;
}

/**
 * Load versioned page data
 */
export function loadVersionedPageData(
  version: string,
  slug: string,
  manifest: DocsManifest
): DocPage {
  const path = `/${version}/${slug}`;
  const id = manifest.routes[path];
  const page = id ? manifest.pages[id] : null;

  if (!page) {
    throw error(404, `Page not found: ${path}`);
  }

  return page;
}

/**
 * Load blog post data
 */
export function loadPostData(slug: string, manifest: DocsManifest): BlogPost {
  const path = `/blog/${slug}`;
  const id = manifest.routes[path];
  const post = id ? manifest.posts[id] : null;

  if (!post) {
    throw error(404, `Post not found: ${slug}`);
  }

  return post;
}

/**
 * Load API reference data
 */
export function loadApiData(
  slug: string,
  manifest: DocsManifest
): ApiReference {
  const path = `/api/${slug}`;
  const id = manifest.routes[path];
  const api = id ? manifest.apis[id] : null;

  if (!api) {
    throw error(404, `API reference not found: ${slug}`);
  }

  return api;
}

/**
 * Create a load function for pages
 */
export function createPageLoad(manifest: DocsManifest) {
  return ({ params }: LoadEvent<{ slug: string }>) => {
    const page = loadPageData(params.slug, manifest);
    return {
      page,
      manifest,
    };
  };
}

/**
 * Create a load function for versioned pages
 */
export function createVersionedPageLoad(manifest: DocsManifest) {
  return ({ params }: LoadEvent<{ version: string; slug: string }>) => {
    const page = loadVersionedPageData(params.version, params.slug, manifest);
    return {
      page,
      manifest,
      version: params.version,
    };
  };
}

/**
 * Create a load function for blog posts
 */
export function createPostLoad(manifest: DocsManifest) {
  return ({ params }: LoadEvent<{ slug: string }>) => {
    const post = loadPostData(params.slug, manifest);
    return {
      post,
      manifest,
    };
  };
}

/**
 * Create a load function for API references
 */
export function createApiLoad(manifest: DocsManifest) {
  return ({ params }: LoadEvent<{ slug: string }>) => {
    const api = loadApiData(params.slug, manifest);
    return {
      api,
      manifest,
    };
  };
}

/**
 * Get all blog post paths
 */
export function getBlogPaths(manifest: DocsManifest) {
  return Object.values(manifest.posts).map((post) => ({
    params: {
      slug: post.slug,
    },
  }));
}

/**
 * Get all API reference paths
 */
export function getApiPaths(manifest: DocsManifest) {
  return Object.values(manifest.apis).map((api) => ({
    params: {
      slug: api.slug,
    },
  }));
}
