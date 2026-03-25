export type ContentKind = "page" | "post" | "api" | "asset";

export interface Version {
  slug: string; // e.g., 'v2', 'latest'
  label: string; // e.g., 'Version 2.0', 'Latest'
  isDefault?: boolean;
}

export interface DocPage {
  kind: "page";
  id: string; // unique stable ID
  slug: string; // url path segment
  path: string; // full path for routing
  title: string;
  description?: string;
  body: string; // raw markdown
  headings: DocHeading[];
  frontmatter: Record<string, any>;
  lastUpdated?: number;
  version?: string; // Optional version slug
}

export interface BlogPost {
  kind: "post";
  id: string;
  slug: string;
  path: string;
  title: string;
  date: string; // ISO date
  publishedAt?: string; // ISO datetime
  author?: string;
  excerpt?: string;
  summary?: string;
  draft?: boolean;
  tags: string[];
  body: string;
  frontmatter: Record<string, any>;
  version?: string; // Optional version slug
}

export interface BlogTagIndex {
  tag: string;
  slug: string;
  path: string;
  postIds: string[];
}

export interface BlogArchivePage {
  page: number;
  path: string;
  postIds: string[];
  totalPages: number;
  totalPosts: number;
  pageSize: number;
}

export interface BlogManifestSurface {
  listRoute: string;
  feedPath: string;
  postOrder: string[];
  tags: Record<string, BlogTagIndex>;
  archives: BlogArchivePage[];
}

export interface EmbeddedPageRoute {
  pageId: string;
  sourcePath: string;
  pageRoute: string;
  surfaceRoute: string;
  title: string;
  tocCount: number;
}

export interface EmbeddedManifestSurface {
  pageRoutePrefix: string;
  surfaceRoutePrefix: string;
  hasSidebar: boolean;
  hasSearchTrigger: boolean;
  hasTopNavSlot: boolean;
  pages: Record<string, EmbeddedPageRoute>;
}

export interface DocHeading {
  level: number;
  text: string;
  slug: string; // anchor id
}

export interface SidebarItem {
  type: "link" | "group" | "separator";
  text: string;
  link?: string; // for links
  items?: SidebarItem[]; // for groups
  expanded?: boolean; // if true, group is always open regardless of active page
}

export interface Sidebar {
  id: string;
  items: SidebarItem[];
}

export interface ApiReference {
  kind: "api";
  id: string;
  slug: string;
  path: string;
  title: string;
  spec: any; // Raw OpenAPI spec object
  frontmatter: Record<string, any>;
  version?: string; // Optional version slug
}

export interface DocsManifest {
  site: {
    title: string;
    description?: string;
  };
  versions?: Version[]; // Optional list of versions
  topNav?: DocsTopNavItem[];
  pages: Record<string, DocPage>; // keyed by ID
  posts: Record<string, BlogPost>;
  apis: Record<string, ApiReference>;
  sidebars: Record<string, Sidebar>; // Can be keyed by version, e.g., 'v2:default'
  routes: Record<string, string>; // path -> ID map for routing
  blog?: BlogManifestSurface;
  embedded?: EmbeddedManifestSurface;
}

export interface RawContentEntry {
  id: string;
  kind: ContentKind;
  body: string;
  frontmatter: Record<string, any>;
  filepath?: string;
}

export type DocsFramework = "next" | "sveltekit" | "embedded";
export type DocsCollection = "docs" | "pages" | "blog" | "api" | "assets";
export type DocsVersionMode = "none" | "path-prefix" | "path-segment";
export type DocsCompatPreset = "none" | "fumadocs-v15";

export interface DocsSiteConfig {
  title: string;
  description?: string;
  basePath?: `/${string}`;
  canonicalUrl?: string;
  defaultLocale?: string;
  theme?: Record<string, unknown>;
  editLink?: Record<string, unknown>;
  pageActions?: Array<Record<string, unknown>>;
}

export interface DocsVersionConfig {
  slug: string;
  label: string;
  default?: boolean;
}

export interface DocsTopNavItem {
  label: string;
  href: string;
  external?: boolean;
  children?: DocsTopNavItem[];
}

export interface DocsSidebarDefinition {
  title?: string;
  root?: boolean;
  include?: string[];
}

export interface DocsConfig {
  schemaVersion: 1;
  site: DocsSiteConfig;
  compat?: {
    preset: DocsCompatPreset;
    allowRawHtml?: false;
  };
  versions?: {
    mode: DocsVersionMode;
    versions: DocsVersionConfig[];
  };
  content: {
    root: string;
    docsDir?: string;
    pagesDir?: string;
    blogDir?: string;
    apiDir?: string;
    assetsDir?: string;
    metaFileName?: string;
  };
  navigation?: {
    topNav?: DocsTopNavItem[];
    sidebars?: Record<string, DocsSidebarDefinition>;
  };
  search?: {
    enabled: boolean;
    scopes: Array<"docs" | "api" | "blog">;
    bodyIndexing?: "full" | "summary" | "disabled";
    maxArtifactBytes?: number;
  };
  auth?: {
    enabled: boolean;
    mode: "public" | "private" | "mixed";
  };
  analytics?: {
    enabled: boolean;
    provider: "watchfn";
    respectDnt: boolean;
  };
}

export type DocsErrorCode =
  | "DOCS_CONFIG_INVALID"
  | "DOCS_CONFIG_UNSUPPORTED"
  | "DOCS_PROVIDER_ERROR"
  | "DOCS_ENTRY_INVALID"
  | "DOCS_META_INVALID"
  | "DOCS_ROUTE_CONFLICT"
  | "DOCS_ROUTE_NOT_FOUND"
  | "DOCS_VERSION_INVALID"
  | "DOCS_COMPAT_UNSUPPORTED"
  | "DOCS_MDX_COMPILE_FAILED"
  | "DOCS_HTML_UNSAFE"
  | "DOCS_SEARCH_BUILD_FAILED"
  | "DOCS_OPENAPI_PARSE_FAILED"
  | "DOCS_REMOTE_FETCH_FAILED"
  | "DOCS_AUTH_REQUIRED"
  | "DOCS_AUTH_FORBIDDEN"
  | "DOCS_ARTIFACT_INVALID";

export interface DocsDiagnostic {
  code: DocsErrorCode;
  severity: "error" | "warning" | "info";
  message: string;
  location?: {
    sourceId?: string;
    absolutePath?: string;
    line?: number;
    column?: number;
  };
  details?: Record<string, unknown>;
  suggestion?: string;
}

export type {
  DocsContentProvider,
  DocsProviderListEntriesInput,
  DocsProviderLoadEntryInput,
  DocsProviderLoadAssetResult,
  DocsProviderWatchInput,
  DocsProviderWatchMetadata,
  DocsProviderWatchSubscription,
  DocsSourceEntry,
  DocsSourceEntryType,
} from "./provider";
