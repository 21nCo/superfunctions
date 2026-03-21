import { InMemorySearchFn, type InMemorySearchFnSnapshot } from "searchfn";
import { createDiagnostic, createDocsError } from "./diagnostics";
import { redactSensitiveText, resolveDocsAuthMode } from "./security";
import type { DocsConfig, DocsDiagnostic, DocsManifest } from "./types";

export type DocsSearchScope = "docs" | "api" | "blog";
export type DocsSearchBodyIndexing = "full" | "summary" | "disabled";
export type DocsSearchDocumentKind = "page" | "api" | "post";

export interface DocsSearchDocument {
  id: string;
  scope: DocsSearchScope;
  kind: DocsSearchDocumentKind;
  path: string;
  title: string;
  summary: string;
  headings: string[];
  tags: string[];
}

export interface DocsSearchArtifact {
  schemaVersion: 1;
  engine: "searchfn";
  fields: Array<"title" | "summary" | "headings" | "tags" | "body">;
  scopes: DocsSearchScope[];
  bodyIndexing: DocsSearchBodyIndexing;
  documents: DocsSearchDocument[];
  snapshot: InMemorySearchFnSnapshot;
  diagnostics: DocsDiagnostic[];
  bytes: number;
}

export interface BuildSearchIndexOptions {
  search?: DocsConfig["search"];
  auth?: DocsConfig["auth"];
}

const DEFAULT_SCOPES: DocsSearchScope[] = ["docs", "api", "blog"];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~>-]/g, " ")
  );
}

function summarizeBody(value: string, maxLength = 220): string {
  const normalized = stripMarkdown(value);
  if (normalized.length <= maxLength) {
    return redactSensitiveText(normalized);
  }
  return redactSensitiveText(`${normalized.slice(0, maxLength - 1).trimEnd()}…`);
}

function normalizeScopes(searchConfig: DocsConfig["search"]): DocsSearchScope[] {
  const explicitScopes = searchConfig?.scopes;
  if (Array.isArray(explicitScopes) && explicitScopes.length === 0) {
    throw createDocsError({
      code: "DOCS_SEARCH_BUILD_FAILED",
      message: "search scopes cannot be empty",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_SEARCH_BUILD_FAILED",
          message: "search scopes cannot be empty",
        }),
      ],
    });
  }
  const scopes = (explicitScopes ?? DEFAULT_SCOPES) as DocsSearchScope[];
  return [...scopes].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );
}

function resolveBodyIndexing(searchConfig: DocsConfig["search"]): DocsSearchBodyIndexing {
  return searchConfig?.bodyIndexing ?? "summary";
}

function createEmptySnapshot(): InMemorySearchFnSnapshot {
  return {
    postings: [],
    stats: [],
    documents: [],
    vocabulary: [],
  };
}

function createSearchEngine(): InMemorySearchFn {
  return new InMemorySearchFn({
    fields: ["title", "summary", "headings", "tags", "body"],
    pipeline: {
      enableEdgeNGrams: true,
      edgeNGramMinLength: 2,
    },
  });
}

function resolveBodyField(input: {
  bodyIndexing: DocsSearchBodyIndexing;
  body: string;
  summary: string;
}): string {
  if (input.bodyIndexing === "disabled") {
    return "";
  }
  if (input.bodyIndexing === "summary") {
    return input.summary;
  }
  return stripMarkdown(input.body);
}

function collectSearchDocuments(input: {
  manifest: DocsManifest;
  scopes: DocsSearchScope[];
  auth: DocsConfig["auth"] | undefined;
}): DocsSearchDocument[] {
  const documents: DocsSearchDocument[] = [];
  const authMode = resolveDocsAuthMode({ auth: input.auth });
  const authEnabled = Boolean(input.auth?.enabled);

  function isProtected(frontmatter: Record<string, unknown> | undefined, route: string): boolean {
    if (!authEnabled) {
      return false;
    }
    if (authMode === "private") {
      return true;
    }
    if (authMode === "public") {
      return false;
    }

    const frontmatterPrivate =
      frontmatter?.private === true || frontmatter?.auth === "private";
    const routePrivate = /\/private(?:\/|$)/i.test(route);
    return frontmatterPrivate || routePrivate;
  }

  if (input.scopes.includes("docs")) {
    for (const page of Object.values(input.manifest.pages)) {
      if (isProtected(page.frontmatter, page.path)) {
        continue;
      }
      documents.push({
        id: page.id,
        scope: "docs",
        kind: "page",
        path: page.path,
        title: redactSensitiveText(page.title),
        summary: redactSensitiveText(
          normalizeWhitespace(page.description ?? summarizeBody(page.body))
        ),
        headings: page.headings.map((heading) => redactSensitiveText(heading.text)),
        tags: [],
      });
    }
  }

  if (input.scopes.includes("api")) {
    for (const api of Object.values(input.manifest.apis)) {
      if (isProtected(api.frontmatter, api.path)) {
        continue;
      }
      const summary =
        (typeof api.frontmatter.description === "string" &&
          normalizeWhitespace(api.frontmatter.description)) ||
        (api.spec &&
        typeof api.spec === "object" &&
        "info" in api.spec &&
        api.spec.info &&
        typeof (api.spec.info as { description?: unknown }).description === "string"
          ? normalizeWhitespace(
              (api.spec.info as { description: string }).description
            )
          : "");
      documents.push({
        id: api.id,
        scope: "api",
        kind: "api",
        path: api.path,
        title: redactSensitiveText(api.title),
        summary: redactSensitiveText(summary),
        headings: [],
        tags: [],
      });
    }
  }

  if (input.scopes.includes("blog")) {
    for (const post of Object.values(input.manifest.posts)) {
      if (isProtected(post.frontmatter, post.path)) {
        continue;
      }
      documents.push({
        id: post.id,
        scope: "blog",
        kind: "post",
        path: post.path,
        title: redactSensitiveText(post.title),
        summary: redactSensitiveText(
          normalizeWhitespace(post.excerpt ?? post.summary ?? summarizeBody(post.body))
        ),
        headings: [],
        tags: post.tags.map((tag) => redactSensitiveText(tag)),
      });
    }
  }

  return documents.sort((left, right) => {
    const leftKey = `${left.id}:${left.scope}:${left.path}`;
    const rightKey = `${right.id}:${right.scope}:${right.path}`;
    return leftKey.localeCompare(rightKey, "en", {
      sensitivity: "variant",
      numeric: true,
    });
  });
}

function assertUniqueSearchDocumentIds(documents: DocsSearchDocument[]): void {
  const seen = new Map<string, DocsSearchDocument>();
  for (const document of documents) {
    const existing = seen.get(document.id);
    if (existing) {
      throw createDocsError({
        code: "DOCS_SEARCH_BUILD_FAILED",
        message: `search document id ${document.id} is duplicated across scopes`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_SEARCH_BUILD_FAILED",
            message: `search document id ${document.id} is duplicated across scopes`,
            details: {
              duplicateId: document.id,
              firstScope: existing.scope,
              secondScope: document.scope,
            },
          }),
        ],
      });
    }
    seen.set(document.id, document);
  }
}

function withStableDiagnosticOrder(diagnostics: DocsDiagnostic[]): DocsDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`, "en", {
      sensitivity: "variant",
      numeric: true,
    })
  );
}

export async function buildSearchIndex(
  manifest: DocsManifest,
  options: BuildSearchIndexOptions = {}
): Promise<DocsSearchArtifact> {
  const searchConfig = options.search;
  const enabled = searchConfig?.enabled ?? true;
  const scopes = normalizeScopes(searchConfig);
  const bodyIndexing = resolveBodyIndexing(searchConfig);
  const diagnostics: DocsDiagnostic[] = [];

  if (!enabled) {
    const emptyArtifact: DocsSearchArtifact = {
      schemaVersion: 1,
      engine: "searchfn",
      fields: ["title", "summary", "headings", "tags", "body"],
      scopes,
      bodyIndexing,
      documents: [],
      snapshot: createEmptySnapshot(),
      diagnostics: [],
      bytes: 0,
    };
    const serialized = JSON.stringify(emptyArtifact);
    return {
      ...emptyArtifact,
      bytes: Buffer.byteLength(serialized, "utf8"),
    };
  }

  const documents = collectSearchDocuments({
    manifest,
    scopes,
    auth: options.auth,
  });
  assertUniqueSearchDocumentIds(documents);

  const engine = createSearchEngine();
  for (const document of documents) {
    engine.add({
      id: document.id,
      fields: {
        title: document.title,
        summary: document.summary,
        headings: document.headings.join(" "),
        tags: document.tags.join(" "),
        body: resolveBodyField({
          bodyIndexing,
          body:
            document.kind === "page"
              ? manifest.pages[document.id]?.body ?? ""
              : document.kind === "post"
                ? manifest.posts[document.id]?.body ?? ""
                : JSON.stringify(manifest.apis[document.id]?.spec ?? {}),
          summary: document.summary,
        }),
      },
      store: {
        id: document.id,
        scope: document.scope,
        kind: document.kind,
        path: document.path,
        title: document.title,
        summary: document.summary,
      },
    });
  }

  const snapshot = engine.exportSnapshot();
  const artifactBase: Omit<DocsSearchArtifact, "bytes"> = {
    schemaVersion: 1,
    engine: "searchfn",
    fields: ["title", "summary", "headings", "tags", "body"],
    scopes,
    bodyIndexing,
    documents,
    snapshot,
    diagnostics: [],
  };

  let bytes = Buffer.byteLength(JSON.stringify(artifactBase), "utf8");
  if (
    typeof searchConfig?.maxArtifactBytes === "number" &&
    bytes > searchConfig.maxArtifactBytes
  ) {
    diagnostics.push(
      createDiagnostic({
        code: "DOCS_ARTIFACT_INVALID",
        severity: "warning",
        message: `search artifact size ${bytes} exceeds configured maxArtifactBytes ${searchConfig.maxArtifactBytes}`,
        details: {
          bytes,
          maxArtifactBytes: searchConfig.maxArtifactBytes,
        },
      })
    );
  }

  const artifact: DocsSearchArtifact = {
    ...artifactBase,
    diagnostics: withStableDiagnosticOrder(diagnostics),
    bytes: 0,
  };
  bytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
  artifact.bytes = bytes;

  return artifact;
}
