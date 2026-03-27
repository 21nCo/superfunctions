export type DocsCategoryId =
  | "start-here"
  | "authentication"
  | "http"
  | "middleware-runtime"
  | "data-storage"
  | "python"
  | "tooling";

export type PackageCategoryId = Exclude<DocsCategoryId, "start-here">;

export interface DocsCategoryDefinition {
  id: DocsCategoryId;
  title: string;
  route: string;
  summary: string;
}

export interface PackageDocEntry {
  slug: string;
  packageName: string;
  title: string;
  category: PackageCategoryId;
  language: "typescript" | "python";
  order: number;
  summary: string;
  sourcePaths: readonly string[];
  requiredSections: readonly string[];
  relatedPackages: readonly string[];
}

export interface EcosystemEntry {
  slug: string;
  title: string;
  summary: string;
  href: string;
  hrefKind: "root-docs" | "workspace-docs" | "repo-path" | "external";
}

export type DocsCheckErrorCode =
  | "DOCS_BRANDING_INVALID"
  | "DOCS_NAV_INVALID"
  | "DOCS_ECOSYSTEM_INCOMPLETE"
  | "DOCS_CATEGORY_OVERVIEW_INCOMPLETE"
  | "DOCS_PACKAGE_PAGE_INCOMPLETE"
  | "DOCS_EXAMPLE_INVALID"
  | "DOCS_SCOPE_VIOLATION"
  | "DOCS_CATALOG_INVALID"
  | "DOCS_CONTENT_INVALID"
  | "DOCS_LINK_INVALID"
  | "DOCS_SNIPPET_INVALID";

export interface DocsCheckResult {
  ok: boolean;
  error?: { code: DocsCheckErrorCode };
}

export interface DocsContentCheckResult extends DocsCheckResult {
  missingPages: string[];
  missingSections: Array<{ path: string; headings: string[] }>;
  wrongCategory: Array<{ slug: string; expected: string; actual: string }>;
  thinPages: Array<{ path: string; proseWords: number; minWords: number }>;
  placeholderHits: Array<{ path: string; phrase: string }>;
  invalidExamples: Array<{ path: string; reason: string }>;
}

export interface RequiredPageContract {
  path: string;
  title: string;
  requiredSections: readonly string[];
  minWords: number;
}

export const docsCategories: readonly DocsCategoryDefinition[] = [
  {
    id: "start-here",
    title: "Start Here",
    route: "/docs",
    summary: "Begin with the Superfunctions mission, package chooser, and ecosystem map.",
  },
  {
    id: "authentication",
    title: "Authentication & OAuth",
    route: "/docs/authentication",
    summary: "Authentication primitives, OAuth layers, providers, and testing utilities.",
  },
  {
    id: "http",
    title: "HTTP & Framework Adapters",
    route: "/docs/http",
    summary: "Framework-agnostic HTTP contracts plus adapters for popular runtimes.",
  },
  {
    id: "middleware-runtime",
    title: "Middleware & Runtime",
    route: "/docs/middleware-runtime",
    summary: "Runtime concerns such as middleware, queues, envelopes, errors, and metrics.",
  },
  {
    id: "data-storage",
    title: "Data & Storage",
    route: "/docs/data-storage",
    summary: "Database abstractions, file primitives, and storage adapters for cloud and local use.",
  },
  {
    id: "python",
    title: "Python Integrations",
    route: "/docs/python",
    summary: "Python packages that map shared Superfunctions concepts into backend frameworks.",
  },
  {
    id: "tooling",
    title: "Tooling",
    route: "/docs/tooling",
    summary: "CLI and documentation tooling that support authoring and operations around packages.",
  },
];

export const topLevelDocsLabels = docsCategories.map((category) => category.title);

export const forbiddenTopLevelBuckets: readonly string[] = [
  "Shared Docs",
  "Superfunctions Shared",
  "Shared Packages",
  "migration",
  "migrations",
  "operations",
  "release-notes-and-deprecations",
];

export const categoryOverviewRequiredSections: readonly string[] = [
  "## What This Category Covers",
  "## Package Map",
  "## How To Choose",
  "## Common Compositions",
  "## Related Categories",
];

export const packagePageRequiredSections: readonly string[] = [
  "## What It Is",
  "## When To Use It",
  "## Install",
  "## Quick Start",
  "## Core Concepts",
  "## Real-World Example",
  "## Related Packages",
  "## Troubleshooting",
];

export const bannedPlaceholderPhrases: readonly string[] = [
  "Reference and usage guidance",
  "Production wiring example",
  "Verify package versions are aligned with your lockfile",
  "Configure this package with explicit environment and observability settings",
];

export const startHerePageContracts: readonly RequiredPageContract[] = [
  {
    path: "docs/content/docs/index.mdx",
    title: "Superfunctions",
    requiredSections: [
      "## What Superfunctions Is",
      "## Who These Docs Are For",
      "## How the Ecosystem Fits Together",
      "## Start With These Packages",
    ],
    minWords: 400,
  },
  {
    path: "docs/content/docs/getting-started.mdx",
    title: "Getting Started",
    requiredSections: [
      "## Choose Your Starting Point",
      "## Install Your First Package",
      "## Build a Small Example",
      "## Where To Go Next",
    ],
    minWords: 400,
  },
  {
    path: "docs/content/docs/choosing-packages.mdx",
    title: "Choosing Packages",
    requiredSections: [
      "## If You Need Authentication",
      "## If You Need HTTP Routing",
      "## If You Need Storage or Persistence",
      "## If You Are Building a Library",
    ],
    minWords: 400,
  },
  {
    path: "docs/content/docs/ecosystem.mdx",
    title: "Ecosystem",
    requiredSections: [
      "## Core Superfunctions",
      "## What The Root Docs Cover",
      "## Where To Find Function-Specific Docs",
    ],
    minWords: 400,
  },
];

export const categoryOverviewContracts: readonly RequiredPageContract[] = [
  {
    path: "docs/content/docs/authentication/index.mdx",
    title: "Authentication & OAuth",
    requiredSections: categoryOverviewRequiredSections,
    minWords: 250,
  },
  {
    path: "docs/content/docs/http/index.mdx",
    title: "HTTP & Framework Adapters",
    requiredSections: categoryOverviewRequiredSections,
    minWords: 250,
  },
  {
    path: "docs/content/docs/middleware-runtime/index.mdx",
    title: "Middleware & Runtime",
    requiredSections: categoryOverviewRequiredSections,
    minWords: 250,
  },
  {
    path: "docs/content/docs/data-storage/index.mdx",
    title: "Data & Storage",
    requiredSections: categoryOverviewRequiredSections,
    minWords: 250,
  },
  {
    path: "docs/content/docs/python/index.mdx",
    title: "Python Integrations",
    requiredSections: categoryOverviewRequiredSections,
    minWords: 250,
  },
  {
    path: "docs/content/docs/tooling/index.mdx",
    title: "Tooling",
    requiredSections: categoryOverviewRequiredSections,
    minWords: 250,
  },
];

function createTypeScriptPackageEntry(input: {
  slug: string;
  title: string;
  category: PackageCategoryId;
  order: number;
  summary: string;
  relatedPackages: readonly string[];
}): PackageDocEntry {
  return {
    slug: input.slug,
    packageName: `@superfunctions/${input.slug}`,
    title: input.title,
    category: input.category,
    language: "typescript",
    order: input.order,
    summary: input.summary,
    sourcePaths: [`packages/${input.slug}/README.md`, `packages/${input.slug}/package.json`],
    requiredSections: packagePageRequiredSections,
    relatedPackages: input.relatedPackages,
  };
}

function createPythonPackageEntry(input: {
  slug: string;
  packageName: string;
  title: string;
  order: number;
  summary: string;
  relatedPackages: readonly string[];
}): PackageDocEntry {
  return {
    slug: input.slug,
    packageName: input.packageName,
    title: input.title,
    category: "python",
    language: "python",
    order: input.order,
    summary: input.summary,
    sourcePaths: [`packages/${input.slug}/README.md`, `packages/${input.slug}/pyproject.toml`],
    requiredSections: packagePageRequiredSections,
    relatedPackages: input.relatedPackages,
  };
}

export const packageCatalog: readonly PackageDocEntry[] = [
  createTypeScriptPackageEntry({
    slug: "auth",
    title: "Auth",
    category: "authentication",
    order: 10,
    summary: "Share one authentication abstraction across apps, adapters, and reusable libraries.",
    relatedPackages: ["oauth-core", "oauth-flow", "middleware"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-core",
    title: "OAuth Core",
    category: "authentication",
    order: 20,
    summary: "Define provider-neutral OAuth types, sessions, and service contracts.",
    relatedPackages: ["auth", "oauth-http", "oauth-storage"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-http",
    title: "OAuth HTTP",
    category: "authentication",
    order: 30,
    summary: "Bridge OAuth flows into HTTP request and response handling.",
    relatedPackages: ["oauth-core", "http", "oauth-flow"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-router",
    title: "OAuth Router",
    category: "authentication",
    order: 35,
    summary: "Compose install, callback, and account routes for OAuth-powered applications.",
    relatedPackages: ["oauth-core", "oauth-http", "auth"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-storage",
    title: "OAuth Storage",
    category: "authentication",
    order: 40,
    summary: "Persist OAuth state, tokens, and installation records behind a shared contract.",
    relatedPackages: ["oauth-core", "db", "oauth-flow"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-flow",
    title: "OAuth Flow",
    category: "authentication",
    order: 50,
    summary: "Compose the lower-level OAuth pieces into end-to-end installation flows.",
    relatedPackages: ["oauth-core", "oauth-http", "oauth-storage"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-providers",
    title: "OAuth Providers",
    category: "authentication",
    order: 60,
    summary: "Use curated provider descriptors when you do not want to model providers yourself.",
    relatedPackages: ["oauth-core", "oauth-flow", "oauth-testing"],
  }),
  createTypeScriptPackageEntry({
    slug: "oauth-testing",
    title: "OAuth Testing",
    category: "authentication",
    order: 70,
    summary: "Test OAuth integrations with reusable fixtures, fakes, and assertions.",
    relatedPackages: ["oauth-core", "oauth-flow", "auth"],
  }),
  createTypeScriptPackageEntry({
    slug: "http",
    title: "HTTP",
    category: "http",
    order: 10,
    summary: "Model routes, handlers, and request lifecycles without locking into one framework.",
    relatedPackages: ["http-express", "http-fastify", "middleware"],
  }),
  createTypeScriptPackageEntry({
    slug: "http-express",
    title: "HTTP Express",
    category: "http",
    order: 20,
    summary: "Run `@superfunctions/http` handlers inside an Express application.",
    relatedPackages: ["http", "middleware", "auth"],
  }),
  createTypeScriptPackageEntry({
    slug: "http-fastify",
    title: "HTTP Fastify",
    category: "http",
    order: 30,
    summary: "Connect the shared HTTP layer to Fastify routing and hooks.",
    relatedPackages: ["http", "middleware", "auth"],
  }),
  createTypeScriptPackageEntry({
    slug: "http-hono",
    title: "HTTP Hono",
    category: "http",
    order: 40,
    summary: "Use the shared HTTP contract in Hono-powered apps and edge runtimes.",
    relatedPackages: ["http", "middleware", "webhooks"],
  }),
  createTypeScriptPackageEntry({
    slug: "http-next",
    title: "HTTP Next",
    category: "http",
    order: 50,
    summary: "Adapt the shared HTTP primitives to Next.js App Router handlers.",
    relatedPackages: ["http", "middleware", "oauth-http"],
  }),
  createTypeScriptPackageEntry({
    slug: "http-openapi",
    title: "HTTP OpenAPI",
    category: "http",
    order: 55,
    summary: "Generate OpenAPI documents from the shared HTTP contract and route metadata.",
    relatedPackages: ["http", "auth", "http-next"],
  }),
  createTypeScriptPackageEntry({
    slug: "http-sveltekit",
    title: "HTTP SvelteKit",
    category: "http",
    order: 60,
    summary: "Use `@superfunctions/http` in SvelteKit endpoints without custom glue code.",
    relatedPackages: ["http", "middleware", "webhooks"],
  }),
  createTypeScriptPackageEntry({
    slug: "middleware",
    title: "Middleware",
    category: "middleware-runtime",
    order: 10,
    summary: "Compose cross-cutting request and workflow concerns with reusable middleware.",
    relatedPackages: ["http", "errors", "metrics"],
  }),
  createTypeScriptPackageEntry({
    slug: "webhooks",
    title: "Webhooks",
    category: "middleware-runtime",
    order: 20,
    summary: "Verify, sign, and deliver webhooks with consistent runtime contracts.",
    relatedPackages: ["http", "middleware", "queue"],
  }),
  createTypeScriptPackageEntry({
    slug: "queue",
    title: "Queue",
    category: "middleware-runtime",
    order: 30,
    summary: "Abstract background delivery and job execution behind queue adapter interfaces.",
    relatedPackages: ["webhooks", "metrics", "config"],
  }),
  createTypeScriptPackageEntry({
    slug: "envelope",
    title: "Envelope",
    category: "middleware-runtime",
    order: 40,
    summary: "Standardize success and error payload shapes returned by your APIs.",
    relatedPackages: ["errors", "http", "middleware"],
  }),
  createTypeScriptPackageEntry({
    slug: "errors",
    title: "Errors",
    category: "middleware-runtime",
    order: 50,
    summary: "Define typed error registries and map failures consistently across packages.",
    relatedPackages: ["envelope", "http", "middleware"],
  }),
  createTypeScriptPackageEntry({
    slug: "metrics",
    title: "Metrics",
    category: "middleware-runtime",
    order: 60,
    summary: "Emit shared metrics from middleware, queues, and storage workflows.",
    relatedPackages: ["middleware", "queue", "config"],
  }),
  createTypeScriptPackageEntry({
    slug: "config",
    title: "Config",
    category: "middleware-runtime",
    order: 70,
    summary: "Load typed environment and runtime configuration before wiring shared packages together.",
    relatedPackages: ["middleware", "metrics", "queue"],
  }),
  createTypeScriptPackageEntry({
    slug: "db",
    title: "DB",
    category: "data-storage",
    order: 10,
    summary: "Use one database abstraction across ORMs and query builders.",
    relatedPackages: ["storage", "files", "python-sqlalchemy"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage",
    title: "Storage",
    category: "data-storage",
    order: 20,
    summary: "Define portable object storage operations that work across cloud providers and local disks.",
    relatedPackages: ["storage-s3", "storage-r2", "files"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage-s3",
    title: "Storage S3",
    category: "data-storage",
    order: 30,
    summary: "Use Amazon S3 as an adapter for the shared storage contract.",
    relatedPackages: ["storage", "storage-r2", "files"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage-r2",
    title: "Storage R2",
    category: "data-storage",
    order: 40,
    summary: "Back the shared storage contract with Cloudflare R2.",
    relatedPackages: ["storage", "storage-s3", "files"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage-minio",
    title: "Storage MinIO",
    category: "data-storage",
    order: 50,
    summary: "Run the storage contract against MinIO for self-hosted or local S3-compatible setups.",
    relatedPackages: ["storage", "storage-s3", "storage-local"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage-gcs",
    title: "Storage GCS",
    category: "data-storage",
    order: 60,
    summary: "Use Google Cloud Storage with the shared storage API.",
    relatedPackages: ["storage", "storage-azure", "files"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage-azure",
    title: "Storage Azure",
    category: "data-storage",
    order: 70,
    summary: "Use Azure Blob Storage through the shared storage contract.",
    relatedPackages: ["storage", "storage-gcs", "files"],
  }),
  createTypeScriptPackageEntry({
    slug: "storage-local",
    title: "Storage Local",
    category: "data-storage",
    order: 80,
    summary: "Store files on the local filesystem while keeping the same storage abstraction.",
    relatedPackages: ["storage", "storage-minio", "files"],
  }),
  createTypeScriptPackageEntry({
    slug: "files",
    title: "Files",
    category: "data-storage",
    order: 90,
    summary: "Work with portable file metadata and file-facing utilities alongside storage adapters.",
    relatedPackages: ["storage", "db", "storage-local"],
  }),
  createPythonPackageEntry({
    slug: "python-core",
    packageName: "sfns",
    title: "Python Core",
    order: 10,
    summary: "Bring the shared database and HTTP abstractions into Python projects.",
    relatedPackages: ["python-fastapi", "python-flask", "python-sqlalchemy"],
  }),
  createPythonPackageEntry({
    slug: "python-fastapi",
    packageName: "superfunctions-fastapi",
    title: "Python FastAPI",
    order: 20,
    summary: "Use Superfunctions HTTP concepts inside FastAPI applications.",
    relatedPackages: ["python-core", "http", "auth"],
  }),
  createPythonPackageEntry({
    slug: "python-flask",
    packageName: "superfunctions-flask",
    title: "Python Flask",
    order: 30,
    summary: "Adapt shared HTTP patterns to Flask apps and extensions.",
    relatedPackages: ["python-core", "http", "auth"],
  }),
  createPythonPackageEntry({
    slug: "python-sqlalchemy",
    packageName: "superfunctions-sqlalchemy",
    title: "Python SQLAlchemy",
    order: 40,
    summary: "Connect the shared DB abstractions to SQLAlchemy models and sessions.",
    relatedPackages: ["python-core", "db", "storage"],
  }),
  createTypeScriptPackageEntry({
    slug: "cli",
    title: "CLI",
    category: "tooling",
    order: 10,
    summary: "Run schema and integration management tasks from the command line.",
    relatedPackages: ["config", "db", "docs-theme"],
  }),
  createTypeScriptPackageEntry({
    slug: "docs-theme",
    title: "Docs Theme",
    category: "tooling",
    order: 20,
    summary: "Reuse the shared Fumadocs theme primitives used across Superfunctions docs apps.",
    relatedPackages: ["cli", "http", "auth"],
  }),
];

export function getExpectedPackageDocPath(entry: PackageDocEntry): string {
  return `docs/content/docs/${entry.category}/${entry.slug}.mdx`;
}

export function getExpectedCategoryOverviewPath(categoryId: PackageCategoryId): string {
  return `docs/content/docs/${categoryId}/index.mdx`;
}
