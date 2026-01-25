import {
  DocsContentProvider,
  DocsManifest,
  DocPage,
  BlogPost,
  RawContentEntry,
  ApiReference,
  Version,
  Sidebar,
} from "./types";
import { extractHeadings } from "./markdown";
import { buildAutoSidebar } from "./sidebar";

export interface DocsConfig {
  site: {
    title: string;
    description?: string;
  };
  versions?: Version[];
  // sidebar config could go here
}

export async function buildManifest(
  provider: DocsContentProvider,
  config: DocsConfig
): Promise<DocsManifest> {
  const entries = await provider.list();

  const pages: Record<string, DocPage> = {};
  const posts: Record<string, BlogPost> = {};
  const apis: Record<string, ApiReference> = {};
  const routes: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.kind === "page") {
      const headings = extractHeadings(entry.body);
      const slug = entry.frontmatter.slug || entry.id.replace(/\.mdx?$/, "");

      // Extract version from frontmatter or filepath
      const version = extractVersionFromEntry(entry, config.versions);

      // Build path with optional version prefix
      let path = slug.startsWith("/") ? slug : `/${slug}`;
      if (version) {
        path = `/${version}${path}`;
      }

      const page: DocPage = {
        kind: "page",
        id: entry.id,
        slug,
        path,
        title: entry.frontmatter.title || "Untitled",
        description: entry.frontmatter.description,
        body: entry.body,
        headings,
        frontmatter: entry.frontmatter,
        version,
      };

      pages[entry.id] = page;
      routes[path] = entry.id;
    } else if (entry.kind === "post") {
      const slug = entry.frontmatter.slug || entry.id.replace(/\.mdx?$/, "");
      const version = extractVersionFromEntry(entry, config.versions);

      let path = `/blog/${slug}`;
      if (version) {
        path = `/${version}${path}`;
      }

      const post: BlogPost = {
        kind: "post",
        id: entry.id,
        slug,
        path,
        title: entry.frontmatter.title || "Untitled",
        date: entry.frontmatter.date || new Date().toISOString(),
        tags: entry.frontmatter.tags || [],
        body: entry.body,
        frontmatter: entry.frontmatter,
        version,
      };

      posts[entry.id] = post;
      routes[path] = entry.id;
    } else if (entry.kind === "api") {
      const slug =
        entry.frontmatter.slug || entry.id.replace(/\.(json|yaml|yml)$/, "");
      const version = extractVersionFromEntry(entry, config.versions);

      let path = `/api/${slug}`;
      if (version) {
        path = `/${version}${path}`;
      }

      let spec = {};
      try {
        spec = JSON.parse(entry.body);
      } catch (e) {
        // if yaml, we need a parser. Core might not have yaml parser.
        // For now, assume JSON or keep raw string in a real implementation.
      }

      const api: ApiReference = {
        kind: "api",
        id: entry.id,
        slug,
        path,
        title: entry.frontmatter.title || "API Reference",
        spec,
        frontmatter: entry.frontmatter,
        version,
      };

      apis[entry.id] = api;
      routes[path] = entry.id;
    }
  }

  // Build sidebars - one default and optionally per-version
  const sidebars: Record<string, Sidebar> = {};

  if (config.versions && config.versions.length > 0) {
    // Build per-version sidebars
    for (const version of config.versions) {
      const versionPages = Object.values(pages).filter(
        (p) => p.version === version.slug
      );
      if (versionPages.length > 0) {
        sidebars[`${version.slug}:default`] = buildAutoSidebar(versionPages);
      }
    }
    // Also build sidebar for unversioned content
    const unversionedPages = Object.values(pages).filter((p) => !p.version);
    if (unversionedPages.length > 0) {
      sidebars["default"] = buildAutoSidebar(unversionedPages);
    }
  } else {
    // No versions - single default sidebar
    sidebars["default"] = buildAutoSidebar(Object.values(pages));
  }

  return {
    site: config.site,
    versions: config.versions,
    pages,
    posts,
    apis,
    sidebars,
    routes,
  };
}

/**
 * Extract version from entry based on frontmatter or filepath
 */
function extractVersionFromEntry(
  entry: RawContentEntry,
  versions?: Version[]
): string | undefined {
  // First check frontmatter
  if (entry.frontmatter.version) {
    return entry.frontmatter.version;
  }

  // Then check filepath for version directory (e.g., docs/v2/intro.md)
  if (entry.filepath && versions) {
    for (const version of versions) {
      // Check if filepath contains /{version}/ pattern
      const versionPattern = new RegExp(`[/\\\\]${version.slug}[/\\\\]`);
      if (versionPattern.test(entry.filepath)) {
        return version.slug;
      }
    }
  }

  return undefined;
}
