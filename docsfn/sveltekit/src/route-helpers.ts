import {
  buildDocsStaticParams,
  createDiagnostic,
  createDocsError,
  generateBreadcrumbs,
  getPaginationFromSidebarWithTitles,
  getTopNavigation,
  resolveSidebarForRoute,
  type ApiReference,
  type BlogPost,
  type DocPage,
  type DocsManifest,
  type DocsSearchArtifact,
  type DocsTopNavItem,
  type Version,
} from "@docsfn/core";
import { error as svelteKitError } from "@sveltejs/kit";
import type { LoadEvent } from "@sveltejs/kit";

type SlugParam = string | string[] | readonly string[] | undefined;
type VersionMode = "path-prefix" | "path-segment";

export type DocsRouteEntry =
  | { kind: "page"; id: string; route: string; page: DocPage }
  | { kind: "api"; id: string; route: string; api: ApiReference }
  | { kind: "post"; id: string; route: string; post: BlogPost };

export interface DocsPageLink {
  title: string;
  path: string;
}

export interface DocsPageBreadcrumbItem {
  label: string;
  href: string;
}

export interface DocsPagePagination {
  prev?: DocsPageLink;
  next?: DocsPageLink;
}

export interface SvelteDocsPageSurface {
  route: string;
  title?: string;
  description?: string;
  canonicalPath: string;
  canonicalUrl: string;
  sidebarId?: string;
  headings?: DocPage["headings"];
  breadcrumbs?: DocsPageBreadcrumbItem[];
  pagination?: DocsPagePagination;
  topNav?: DocsTopNavItem[];
  versions?: Version[];
  currentVersion?: string;
  versionLinks?: Record<string, string>;
  editLink?: string;
  pageActions?: Array<Record<string, unknown>>;
}

export interface GenerateStaticParamsOptions {
  basePath?: string;
  includeApiRoutes?: boolean;
}

export interface GenerateVersionedStaticParamsOptions {
  basePath?: string;
  mode?: VersionMode;
}

export interface ResolvePageOptions {
  basePath?: string;
}

export interface ResolveVersionedPageOptions {
  basePath?: string;
  mode?: VersionMode;
}

export interface ResolvePageSurfaceOptions {
  basePath?: string;
  sidebarId?: string;
  homeLabel?: string;
  homeHref?: string;
  canonicalUrl?: string;
  pageActions?: Array<Record<string, unknown>>;
  editLink?: string;
  versionMode?: VersionMode;
}

export interface SearchArtifactResponseInput {
  artifact?: DocsSearchArtifact;
  loadArtifact?: () => Promise<DocsSearchArtifact>;
  cacheControl?: string;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function normalizeBasePath(basePath?: string): string {
  const value = typeof basePath === "string" && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : prefixed;
}

function normalizeSlugSegments(slug: SlugParam): string[] {
  if (Array.isArray(slug)) {
    return slug.map((segment) => String(segment)).filter((segment) => segment.length > 0);
  }
  if (typeof slug === "string") {
    return slug.split("/").filter((segment) => segment.length > 0);
  }
  return [];
}

function buildDocsPath(slug: SlugParam, basePath?: string): string {
  const resolvedBasePath = normalizeBasePath(basePath);
  const segments = normalizeSlugSegments(slug);
  if (segments.length === 0) {
    return resolvedBasePath;
  }
  return `${resolvedBasePath}/${segments.join("/")}`.replace(/\/{2,}/g, "/");
}

function resolveRouteEntry(routePath: string, manifest: DocsManifest): DocsRouteEntry | null {
  const id = manifest.routes[routePath];
  if (!id) {
    return null;
  }

  const page = manifest.pages[id];
  if (page) {
    return {
      kind: "page",
      id,
      route: routePath,
      page,
    };
  }

  const api = manifest.apis[id];
  if (api) {
    return {
      kind: "api",
      id,
      route: routePath,
      api,
    };
  }

  const post = manifest.posts[id];
  if (post) {
    return {
      kind: "post",
      id,
      route: routePath,
      post,
    };
  }

  return null;
}

function createRouteNotFoundError(message: string, route: string) {
  return createDocsError({
    code: "DOCS_ROUTE_NOT_FOUND",
    message,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_ROUTE_NOT_FOUND",
        message,
        details: {
          route,
        },
      }),
    ],
  });
}

function toVersionedPath(input: {
  version: string;
  slug: SlugParam;
  basePath?: string;
  mode?: VersionMode;
}): string {
  const resolvedBasePath = normalizeBasePath(input.basePath);
  const mode = input.mode ?? "path-prefix";
  const slugSegments = normalizeSlugSegments(input.slug);
  const routeSegments =
    mode === "path-segment"
      ? [...slugSegments, input.version]
      : [input.version, ...slugSegments];

  if (routeSegments.length === 0) {
    return resolvedBasePath;
  }

  return `${resolvedBasePath}/${routeSegments.join("/")}`.replace(/\/{2,}/g, "/");
}

function collectDocsRoutes(input: {
  manifest: DocsManifest;
  basePath: string;
  includeApiRoutes: boolean;
}): string[] {
  const { manifest, basePath, includeApiRoutes } = input;
  const baseWithSlash = `${basePath}/`;

  return Object.entries(manifest.routes)
    .filter(([routePath]) => routePath === basePath || routePath.startsWith(baseWithSlash))
    .filter(([, id]) => {
      if (manifest.pages[id]) {
        return true;
      }
      if (includeApiRoutes && manifest.apis[id]) {
        return true;
      }
      return false;
    })
    .map(([routePath]) => routePath)
    .sort(compareStrings);
}

function removeBasePathPrefix(routePath: string, basePath: string): string[] {
  const withoutBase =
    routePath === basePath
      ? ""
      : routePath.startsWith(`${basePath}/`)
        ? routePath.slice(basePath.length + 1)
        : routePath.replace(/^\/+/, "");
  return withoutBase.split("/").filter((segment) => segment.length > 0);
}

function resolveCanonicalUrl(canonicalUrl: string | undefined, path: string): string {
  if (!canonicalUrl) {
    return path;
  }

  const normalizedOrigin = canonicalUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedOrigin}${normalizedPath}`;
}

function resolveVersionLinks(input: {
  route: string;
  currentVersion?: string;
  versions?: Version[];
  manifest: DocsManifest;
  basePath: string;
  mode: VersionMode;
}): Record<string, string> | undefined {
  const versions = input.versions ?? [];
  if (!input.currentVersion || versions.length <= 1) {
    return undefined;
  }

  const routeSegments = removeBasePathPrefix(input.route, input.basePath);
  let logicalSegments = [...routeSegments];

  if (input.mode === "path-segment") {
    if (logicalSegments[logicalSegments.length - 1] === input.currentVersion) {
      logicalSegments = logicalSegments.slice(0, -1);
    }
  } else if (logicalSegments[0] === input.currentVersion) {
    logicalSegments = logicalSegments.slice(1);
  }

  const links: Record<string, string> = {};
  for (const version of versions) {
    const candidateRoute = toVersionedPath({
      version: version.slug,
      slug: logicalSegments,
      basePath: input.basePath,
      mode: input.mode,
    });
    if (input.manifest.routes[candidateRoute]) {
      links[version.slug] = candidateRoute;
    }
  }

  return Object.keys(links).length > 0 ? links : undefined;
}

function isDocsRouteNotFound(error: unknown): error is { code: "DOCS_ROUTE_NOT_FOUND"; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code) === "DOCS_ROUTE_NOT_FOUND" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

export function generateStaticParams(
  manifest: DocsManifest,
  options: GenerateStaticParamsOptions = {}
): Array<{ slug?: string }> {
  const basePath = normalizeBasePath(options.basePath);
  const routes = collectDocsRoutes({
    manifest,
    basePath,
    includeApiRoutes: options.includeApiRoutes ?? true,
  });

  return buildDocsStaticParams({ routes, basePath }).map((param) => {
    if (param.slug && param.slug.length > 0) {
      return { slug: param.slug.join("/") };
    }
    return {};
  });
}

export function generateVersionedStaticParams(
  manifest: DocsManifest,
  options: GenerateVersionedStaticParamsOptions = {}
): Array<{ version: string; slug?: string }> {
  const basePath = normalizeBasePath(options.basePath);
  const mode = options.mode ?? "path-prefix";

  const params = Object.values(manifest.pages)
    .filter((page) => typeof page.version === "string" && page.version.length > 0)
    .map((page) => {
      const routeSegments = removeBasePathPrefix(page.path, basePath);
      let slug = [...routeSegments];
      if (mode === "path-segment") {
        slug = slug[slug.length - 1] === page.version ? slug.slice(0, -1) : slug;
      } else {
        slug = slug[0] === page.version ? slug.slice(1) : slug;
      }

      return {
        version: page.version as string,
        slug,
      };
    })
    .sort((left, right) => {
      const versionCompare = compareStrings(left.version, right.version);
      if (versionCompare !== 0) {
        return versionCompare;
      }
      return compareStrings(left.slug.join("/"), right.slug.join("/"));
    });

  return params.map((param) =>
    param.slug.length > 0
      ? { version: param.version, slug: param.slug.join("/") }
      : { version: param.version }
  );
}

export function getStaticPaths(
  manifest: DocsManifest,
  options: GenerateStaticParamsOptions = {}
) {
  return generateStaticParams(manifest, options).map((entry) => ({
    params: entry.slug ? { slug: entry.slug } : {},
  }));
}

export function getVersionedStaticPaths(
  manifest: DocsManifest,
  options: GenerateVersionedStaticParamsOptions = {}
) {
  return generateVersionedStaticParams(manifest, options).map((entry) => ({
    params: entry.slug ? { version: entry.version, slug: entry.slug } : { version: entry.version },
  }));
}

export function resolveDocsRouteData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocsRouteEntry | null {
  const routePath = buildDocsPath(slug, options.basePath);
  return resolveRouteEntry(routePath, manifest);
}

export function resolveDocsRouteDataOrThrow(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocsRouteEntry {
  const routePath = buildDocsPath(slug, options.basePath);
  const entry = resolveRouteEntry(routePath, manifest);
  if (entry) {
    return entry;
  }

  const segments = normalizeSlugSegments(slug);
  if (segments.length === 0) {
    throw createRouteNotFoundError(
      "root docs page must resolve when params.slug is undefined",
      routePath
    );
  }

  throw createRouteNotFoundError(`docs route ${routePath} was not generated`, routePath);
}

export function getPageData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocPage | null {
  const route = resolveDocsRouteData(slug, manifest, options);
  if (!route || route.kind !== "page") {
    return null;
  }
  return route.page;
}

export function getPageDataOrThrow(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocPage {
  const entry = resolveDocsRouteDataOrThrow(slug, manifest, options);
  if (entry.kind === "page") {
    return entry.page;
  }

  throw createRouteNotFoundError(`docs page route ${entry.route} was not generated`, entry.route);
}

export function getVersionedPageData(
  version: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolveVersionedPageOptions = {}
): DocPage | null {
  const routePath = toVersionedPath({
    version,
    slug,
    basePath: options.basePath,
    mode: options.mode,
  });
  const entry = resolveRouteEntry(routePath, manifest);
  return entry?.kind === "page" ? entry.page : null;
}

export function getVersionedPageDataOrThrow(
  version: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolveVersionedPageOptions = {}
): DocPage {
  const routePath = toVersionedPath({
    version,
    slug,
    basePath: options.basePath,
    mode: options.mode,
  });
  const entry = resolveRouteEntry(routePath, manifest);
  if (entry?.kind === "page") {
    return entry.page;
  }

  throw createRouteNotFoundError(`docs route ${routePath} was not generated`, routePath);
}

export function getPostData(slug: string, manifest: DocsManifest): BlogPost | null {
  const normalizedSlug = slug.replace(/^\/+/, "");
  return (
    Object.values(manifest.posts).find((post) => post.slug === normalizedSlug) ?? null
  );
}

export function getPostDataOrThrow(slug: string, manifest: DocsManifest): BlogPost {
  const post = getPostData(slug, manifest);
  if (post) {
    return post;
  }
  throw createRouteNotFoundError(`blog route /blog/${slug} was not generated`, `/blog/${slug}`);
}

export function getApiData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): ApiReference | null {
  const basePath = normalizeBasePath(options.basePath);
  const segments = normalizeSlugSegments(slug);
  const logicalSegments = segments[0] === "api" ? segments.slice(1) : segments;
  const suffix = logicalSegments.length > 0 ? `/${logicalSegments.join("/")}` : "";
  const routePath = `${basePath}/api${suffix}`.replace(/\/{2,}/g, "/");
  const entry = resolveRouteEntry(routePath, manifest);
  return entry?.kind === "api" ? entry.api : null;
}

export function getApiDataOrThrow(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): ApiReference {
  const api = getApiData(slug, manifest, options);
  if (api) {
    return api;
  }
  const routePath = buildDocsPath(slug, options.basePath);
  throw createRouteNotFoundError(`api route ${routePath} was not generated`, routePath);
}

export function loadPageData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocPage {
  return getPageDataOrThrow(slug, manifest, options);
}

export function loadVersionedPageData(
  version: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolveVersionedPageOptions = {}
): DocPage {
  return getVersionedPageDataOrThrow(version, slug, manifest, options);
}

export function loadPostData(slug: string, manifest: DocsManifest): BlogPost {
  return getPostDataOrThrow(slug, manifest);
}

export function loadApiData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): ApiReference {
  return getApiDataOrThrow(slug, manifest, options);
}

export function generateBlogParams(manifest: DocsManifest) {
  return Object.values(manifest.posts)
    .sort((left, right) => compareStrings(left.slug, right.slug))
    .map((post) => ({
      slug: post.slug,
    }));
}

export function generateApiParams(manifest: DocsManifest) {
  return Object.values(manifest.apis)
    .sort((left, right) => compareStrings(left.slug, right.slug))
    .map((api) => ({
      slug: api.slug,
    }));
}

export function getBlogPaths(manifest: DocsManifest) {
  return generateBlogParams(manifest).map((entry) => ({
    params: {
      slug: entry.slug,
    },
  }));
}

export function getApiPaths(manifest: DocsManifest) {
  return generateApiParams(manifest).map((entry) => ({
    params: {
      slug: entry.slug,
    },
  }));
}

export function resolveDocsPageSurface(input: {
  manifest: DocsManifest;
  route: string;
  page?: DocPage;
  options?: ResolvePageSurfaceOptions;
}): SvelteDocsPageSurface {
  const options = input.options ?? {};
  const basePath = normalizeBasePath(options.basePath);
  const page =
    input.page ??
    (() => {
      const entry = resolveRouteEntry(input.route, input.manifest);
      return entry?.kind === "page" ? entry.page : undefined;
    })();

  const sidebarId =
    options.sidebarId ??
    resolveSidebarForRoute({
      sidebars: input.manifest.sidebars,
      route: input.route,
    }) ??
    "default";
  const sidebar = input.manifest.sidebars[sidebarId];

  const breadcrumbs = sidebar
    ? generateBreadcrumbs(input.route, input.manifest, {
        homeLabel: options.homeLabel ?? input.manifest.site.title,
        homeHref: options.homeHref ?? basePath,
        sidebarId,
      })
    : [];

  const pagination = sidebar
    ? getPaginationFromSidebarWithTitles(input.route, sidebar, input.manifest.pages)
    : {};

  const canonicalPath = input.route;
  const canonicalUrl = resolveCanonicalUrl(options.canonicalUrl, canonicalPath);

  return {
    route: input.route,
    title: page?.title,
    description: page?.description,
    canonicalPath,
    canonicalUrl,
    sidebarId,
    headings: page?.headings,
    breadcrumbs,
    pagination,
    topNav: getTopNavigation(input.manifest),
    versions: input.manifest.versions,
    currentVersion: page?.version,
    versionLinks: resolveVersionLinks({
      route: input.route,
      currentVersion: page?.version,
      versions: input.manifest.versions,
      manifest: input.manifest,
      basePath,
      mode: options.versionMode ?? "path-prefix",
    }),
    editLink: options.editLink,
    pageActions: options.pageActions,
  };
}

export function createPageLoad(
  manifest: DocsManifest,
  options: ResolvePageSurfaceOptions = {}
) {
  return ({ params }: LoadEvent<{ slug?: string }>) => {
    try {
      const routeEntry = resolveDocsRouteDataOrThrow(params.slug, manifest, {
        basePath: options.basePath,
      });

      if (routeEntry.kind !== "page") {
        throw createRouteNotFoundError(
          `docs page route ${routeEntry.route} was not generated`,
          routeEntry.route
        );
      }

      const surface = resolveDocsPageSurface({
        manifest,
        route: routeEntry.route,
        page: routeEntry.page,
        options,
      });

      return {
        page: routeEntry.page,
        route: routeEntry.route,
        surface,
        manifest,
      };
    } catch (error) {
      if (isDocsRouteNotFound(error)) {
        throw svelteKitError(404, error.message);
      }
      throw error;
    }
  };
}

export function createVersionedPageLoad(
  manifest: DocsManifest,
  options: ResolvePageSurfaceOptions & ResolveVersionedPageOptions = {}
) {
  return ({ params }: LoadEvent<{ version: string; slug?: string }>) => {
    const routePath = toVersionedPath({
      version: params.version,
      slug: params.slug,
      basePath: options.basePath,
      mode: options.mode,
    });

    try {
      const routeEntry = resolveRouteEntry(routePath, manifest);
      if (!routeEntry || routeEntry.kind !== "page") {
        throw createRouteNotFoundError(`docs route ${routePath} was not generated`, routePath);
      }

      const surface = resolveDocsPageSurface({
        manifest,
        route: routeEntry.route,
        page: routeEntry.page,
        options,
      });

      return {
        page: routeEntry.page,
        route: routeEntry.route,
        surface,
        version: params.version,
        manifest,
      };
    } catch (error) {
      if (isDocsRouteNotFound(error)) {
        throw svelteKitError(404, error.message);
      }
      throw error;
    }
  };
}

export function createPostLoad(manifest: DocsManifest) {
  return ({ params }: LoadEvent<{ slug: string }>) => {
    try {
      const post = getPostDataOrThrow(params.slug, manifest);
      return {
        post,
        manifest,
      };
    } catch (error) {
      if (isDocsRouteNotFound(error)) {
        throw svelteKitError(404, error.message);
      }
      throw error;
    }
  };
}

export function createApiLoad(
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
) {
  return ({ params }: LoadEvent<{ slug?: string }>) => {
    try {
      const api = getApiDataOrThrow(params.slug, manifest, options);
      return {
        api,
        manifest,
      };
    } catch (error) {
      if (isDocsRouteNotFound(error)) {
        throw svelteKitError(404, error.message);
      }
      throw error;
    }
  };
}

export async function createSearchArtifactResponse(
  input: SearchArtifactResponseInput
): Promise<Response> {
  try {
    const artifact = input.artifact ?? (input.loadArtifact ? await input.loadArtifact() : undefined);
    if (!artifact) {
      throw createDocsError({
        code: "DOCS_ARTIFACT_INVALID",
        message: "search artifact is not available",
        diagnostics: [
          createDiagnostic({
            code: "DOCS_ARTIFACT_INVALID",
            message: "search artifact is not available",
          }),
        ],
      });
    }

    return new Response(JSON.stringify(artifact), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": input.cacheControl ?? "public, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "DOCS_ARTIFACT_INVALID";
    const message = error instanceof Error ? error.message : "failed to load search artifact";

    return new Response(
      JSON.stringify({
        code,
        message,
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  }
}
