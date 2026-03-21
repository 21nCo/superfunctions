import {
  assertValidSourceEntries,
  createSourceEntryId,
  normalizeProviderPath,
} from "./provider";
import { buildCanonicalBlogRecords } from "./blog";
import { buildOpenApiReference } from "./openapi";
import { assertRouteAvailability } from "./routing";
import { buildSidebars } from "./navigation";
import { normalizeSourceEntries } from "./normalize";
import { assertSourceEntriesTrusted } from "./security";
import type {
  DocsCollection,
  DocsConfig,
  DocsContentProvider,
  DocsManifest,
  DocsSourceEntry,
  RawContentEntry,
  Version,
} from "./types";

interface LegacyManifestConfig {
  site: {
    title: string;
    description?: string;
    basePath?: `/${string}`;
  };
  versions?: Version[];
  navigation?: DocsConfig["navigation"];
  content?: Partial<DocsConfig["content"]>;
}

export type ManifestConfig = DocsConfig | LegacyManifestConfig;

export interface BuildManifestOptions {
  preview?: boolean;
  blogPageSize?: number;
}

const DEFAULT_COLLECTIONS: DocsCollection[] = [
  "docs",
  "pages",
  "blog",
  "api",
  "assets",
];

function isDocsConfig(config: ManifestConfig): config is DocsConfig {
  return (
    typeof (config as Partial<DocsConfig>).schemaVersion === "number" &&
    (config as Partial<DocsConfig>).schemaVersion === 1 &&
    typeof (config as Partial<DocsConfig>).content === "object" &&
    config !== null &&
    (config as Partial<DocsConfig>).content !== undefined
  );
}

function toCanonicalConfig(config: ManifestConfig): DocsConfig {
  if (isDocsConfig(config)) {
    return {
      ...config,
      compat: config.compat ?? { preset: "none" },
      site: {
        ...config.site,
        basePath: config.site.basePath ?? "/docs",
      },
      content: {
        root: config.content.root,
        docsDir: config.content.docsDir ?? "content/docs",
        pagesDir: config.content.pagesDir ?? "pages",
        blogDir: config.content.blogDir ?? "blog",
        apiDir: config.content.apiDir ?? "api",
        assetsDir: config.content.assetsDir ?? "public",
        metaFileName: config.content.metaFileName ?? "meta.json",
      },
    };
  }

  const defaultVersion =
    config.versions && config.versions.some((version) => version.isDefault)
      ? config.versions.find((version) => version.isDefault)
      : config.versions?.[0];

  return {
    schemaVersion: 1,
    site: {
      title: config.site.title,
      description: config.site.description,
      basePath: config.site.basePath ?? "/docs",
    },
    compat: {
      preset: "none",
    },
    versions:
      config.versions && config.versions.length > 0
        ? {
            mode: "path-prefix",
            versions: config.versions.map((version) => ({
              slug: version.slug,
              label: version.label,
              default: defaultVersion ? version.slug === defaultVersion.slug : false,
            })),
          }
        : undefined,
    content: {
      root: config.content?.root ?? process.cwd(),
      docsDir: config.content?.docsDir ?? "content/docs",
      pagesDir: config.content?.pagesDir ?? "pages",
      blogDir: config.content?.blogDir ?? "blog",
      apiDir: config.content?.apiDir ?? "api",
      assetsDir: config.content?.assetsDir ?? "public",
      metaFileName: config.content?.metaFileName ?? "meta.json",
    },
    navigation: config.navigation,
  };
}

function rawEntryToSourceEntry(entry: RawContentEntry): DocsSourceEntry {
  const collection: DocsCollection =
    entry.kind === "api"
      ? "api"
      : entry.kind === "post"
        ? "blog"
        : entry.kind === "asset"
          ? "assets"
          : "docs";
  const relativePath = normalizeProviderPath(entry.id);

  return {
    id: createSourceEntryId(collection, relativePath),
    collection,
    relativePath,
    absolutePath: entry.filepath,
    entryType: entry.kind === "asset" ? "asset" : "content",
    frontmatter: entry.frontmatter ?? {},
    body: entry.body ?? "",
    bytes: Buffer.byteLength(entry.body ?? "", "utf8"),
  };
}

function normalizeBasePath(basePath?: string): string {
  const value = typeof basePath === "string" && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : prefixed;
}

async function listCanonicalEntries(input: {
  provider: DocsContentProvider;
  config: DocsConfig;
}): Promise<DocsSourceEntry[]> {
  let entries: DocsSourceEntry[];
  if (typeof input.provider.listEntries === "function") {
    entries = await input.provider.listEntries({
      config: input.config,
      collections: DEFAULT_COLLECTIONS,
    });
  } else {
    const legacy = await input.provider.list();
    entries = legacy.map(rawEntryToSourceEntry);
  }

  const hydrated = await Promise.all(
    entries.map((entry) => input.provider.loadEntry({ config: input.config, entry }))
  );
  return assertValidSourceEntries(hydrated);
}

export async function buildManifest(
  provider: DocsContentProvider,
  config: ManifestConfig,
  options: BuildManifestOptions = {}
): Promise<DocsManifest> {
  const canonicalConfig = toCanonicalConfig(config);
  const basePath = normalizeBasePath(canonicalConfig.site.basePath);
  const entries = await listCanonicalEntries({
    provider,
    config: canonicalConfig,
  });
  assertSourceEntriesTrusted({
    entries,
  });
  const normalized = normalizeSourceEntries({
    config: canonicalConfig,
    entries,
  });
  const sourceEntriesById = new Map(entries.map((entry) => [entry.id, entry]));

  const pages: DocsManifest["pages"] = {};
  const posts: DocsManifest["posts"] = {};
  const apis: DocsManifest["apis"] = {};
  const routes = new Map<string, string>();

  for (const page of normalized.pages) {
    assertRouteAvailability({
      routes,
      path: page.path,
      sourceId: page.id,
    });
    routes.set(page.path, page.id);
    pages[page.id] = {
      kind: "page",
      id: page.id,
      slug: page.slug,
      path: page.path,
      title: page.title,
      description: page.description,
      body: page.body,
      headings: page.headings,
      frontmatter: page.frontmatter,
      version: page.version,
    };
  }

  const canonicalBlog = buildCanonicalBlogRecords({
    posts: normalized.posts,
    basePath: canonicalConfig.site.basePath,
    preview: options.preview,
    pageSize: options.blogPageSize,
  });
  for (const post of canonicalBlog.posts) {
    assertRouteAvailability({
      routes,
      path: post.path,
      sourceId: post.id,
    });
    routes.set(post.path, post.id);
    posts[post.id] = {
      kind: "post",
      id: post.id,
      slug: post.slug,
      path: post.path,
      title: post.title,
      date: post.date,
      publishedAt: post.publishedAt,
      author: post.author,
      excerpt: post.excerpt,
      summary: post.summary,
      draft: post.draft,
      tags: post.tags,
      body: post.body,
      frontmatter: post.frontmatter,
    };
  }

  for (const api of normalized.apis) {
    const sourceEntry = sourceEntriesById.get(api.id);
    const normalizedReference = buildOpenApiReference({
      sourceId: api.id,
      sourcePath: sourceEntry?.relativePath ?? api.slug,
      body: api.body,
      fallbackTitle: api.title,
      basePath: canonicalConfig.site.basePath,
      absolutePath: sourceEntry?.absolutePath,
      sourceMeta: {
        etag: sourceEntry?.etag,
        sha256: sourceEntry?.sha256,
        updatedAt: sourceEntry?.updatedAt,
        remoteUrl:
          typeof sourceEntry?.meta?.remoteUrl === "string"
            ? sourceEntry.meta.remoteUrl
            : undefined,
      },
    });

    for (const routePath of [...normalizedReference.routes.all].sort((left, right) =>
      left.localeCompare(right, "en", {
        sensitivity: "variant",
        numeric: true,
      })
    )) {
      assertRouteAvailability({
        routes,
        path: routePath,
        sourceId: api.id,
      });
      routes.set(routePath, api.id);
    }

    apis[api.id] = {
      kind: "api",
      id: api.id,
      slug: api.slug,
      path: normalizedReference.routes.overview,
      title: api.title,
      spec: normalizedReference,
      frontmatter: api.frontmatter,
    };
  }

  const sidebars = buildSidebars({
    pages: normalized.pages,
    metaByDirectory: normalized.metaByDirectory,
    config: canonicalConfig,
  });

  const embeddedPageRoutePrefix = `${basePath}/embedded/page`;
  const embeddedSurfaceRoutePrefix = `${basePath}/embedded/surface`;
  const embeddedPages: NonNullable<DocsManifest["embedded"]>["pages"] = Object.fromEntries(
    normalized.pages
      .filter((page) => page.collection === "docs")
      .map((page) => {
        const slug = page.slug.length > 0 ? page.slug : "index";
        const routeSuffix = slug.replace(/^\/+/, "");
        return [
          page.id,
          {
            pageId: page.id,
            sourcePath: page.path,
            pageRoute: `${embeddedPageRoutePrefix}/${routeSuffix}`.replace(/\/{2,}/g, "/"),
            surfaceRoute: `${embeddedSurfaceRoutePrefix}/${routeSuffix}`.replace(/\/{2,}/g, "/"),
            title: page.title,
            tocCount: page.headings.filter((heading) => heading.level > 1).length,
          },
        ] as const;
      })
      .sort(([left], [right]) =>
        left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
      )
  );

  return {
    site: {
      title: canonicalConfig.site.title,
      description: canonicalConfig.site.description,
    },
    versions: canonicalConfig.versions?.versions.map((version) => ({
      slug: version.slug,
      label: version.label,
      isDefault: Boolean(version.default),
    })),
    topNav: canonicalConfig.navigation?.topNav ?? [],
    pages,
    posts,
    apis,
    sidebars,
    blog: {
      listRoute: canonicalBlog.listRoute,
      feedPath: canonicalBlog.feedPath,
      postOrder: canonicalBlog.postOrder,
      tags: canonicalBlog.tags,
      archives: canonicalBlog.archives,
    },
    embedded: {
      pageRoutePrefix: embeddedPageRoutePrefix,
      surfaceRoutePrefix: embeddedSurfaceRoutePrefix,
      hasSidebar: Object.keys(sidebars).length > 0,
      hasSearchTrigger: true,
      hasTopNavSlot: true,
      pages: embeddedPages,
    },
    routes: Object.fromEntries(
      [...routes.entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
      )
    ),
  };
}
