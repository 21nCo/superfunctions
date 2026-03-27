import { createMemorySearchClient, type SearchClient } from "@searchfn/client";
import { createDiagnostic, createDocsError } from "./diagnostics";
import type { DocsSearchArtifact, DocsSearchDocument, DocsSearchScope } from "./search";

export type DocsSearchScopeFilter = DocsSearchScope | "all";

export interface DocsSearchRuntimeResultItem {
  id: string;
  scope: DocsSearchScope;
  kind: "page" | "api" | "post";
  path: string;
  title: string;
  summary: string;
  score: number;
}

export interface DocsSearchRuntimeQueryInput {
  query: string;
  scope?: DocsSearchScopeFilter;
  limit?: number;
}

export interface DocsSearchRuntime {
  ensureReady(): Promise<void>;
  query(input: DocsSearchRuntimeQueryInput): Promise<DocsSearchRuntimeResultItem[]>;
  getScopes(): Promise<DocsSearchScope[]>;
}

export interface CreateDocsSearchRuntimeInput {
  artifact?: DocsSearchArtifact;
  loadArtifact?: () => Promise<DocsSearchArtifact>;
}

interface ValidatedArtifact {
  artifact: DocsSearchArtifact;
  client: SearchClient;
  documents: Map<string, DocsSearchDocument>;
}

function assertValidArtifact(artifact: DocsSearchArtifact): void {
  if (artifact.schemaVersion !== 1 || artifact.engine !== "searchfn") {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: "search artifact schema is invalid",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: "search artifact schema is invalid",
        }),
      ],
    });
  }

  if (!Array.isArray(artifact.documents) || !artifact.snapshot) {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: "search artifact is malformed",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: "search artifact is malformed",
        }),
      ],
    });
  }
}

function createSearchClientForArtifact(artifact: DocsSearchArtifact): SearchClient {
  return createMemorySearchClient({
    adapterConfig: {
      pipeline: {
        enableEdgeNGrams: true,
        edgeNGramMinLength: 2,
      },
    },
    defaults: {
      prefix: true,
      limit: 20,
      limitPerResource: 20,
    },
  });
}

function sortResults(
  results: DocsSearchRuntimeResultItem[],
  limit: number
): DocsSearchRuntimeResultItem[] {
  return [...results]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const titleCompare = left.title.localeCompare(right.title, "en", {
        sensitivity: "variant",
        numeric: true,
      });
      if (titleCompare !== 0) {
        return titleCompare;
      }
      const pathCompare = left.path.localeCompare(right.path, "en", {
        sensitivity: "variant",
        numeric: true,
      });
      if (pathCompare !== 0) {
        return pathCompare;
      }
      return left.id.localeCompare(right.id, "en", {
        sensitivity: "variant",
        numeric: true,
      });
    })
    .slice(0, Math.max(1, limit));
}

export function createDocsSearchRuntime(
  input: CreateDocsSearchRuntimeInput
): DocsSearchRuntime {
  let validated: ValidatedArtifact | null = null;
  let loadingPromise: Promise<ValidatedArtifact> | null = null;

  async function loadValidated(): Promise<ValidatedArtifact> {
    if (validated) {
      return validated;
    }
    if (loadingPromise) {
      return loadingPromise;
    }

    loadingPromise = (async () => {
      const artifact = input.artifact ?? (input.loadArtifact ? await input.loadArtifact() : null);
      if (!artifact) {
        throw createDocsError({
          code: "DOCS_ARTIFACT_INVALID",
          message: "search runtime was created without an artifact or loader",
          diagnostics: [
            createDiagnostic({
              code: "DOCS_ARTIFACT_INVALID",
              message: "search runtime was created without an artifact or loader",
            }),
          ],
        });
      }

      assertValidArtifact(artifact);
      const client = createSearchClientForArtifact(artifact);
      await client.initialize?.({
        resources: artifact.scopes.map((scope) => ({
          name: scope,
          searchFields: artifact.fields,
        })),
      });
      const documents = new Map<string, DocsSearchDocument>();

      for (const scope of artifact.scopes) {
        const scopedDocuments = artifact.documents.filter((document) => document.scope === scope);
        if (scopedDocuments.length === 0) {
          continue;
        }
        for (const document of scopedDocuments) {
          documents.set(document.id, document);
        }
        await client.index({
          resource: scope,
          documents: scopedDocuments.map((document) => ({
            id: document.id,
            fields: {
              title: document.title,
              summary: document.summary,
              headings: document.headings.join(" "),
              tags: document.tags.join(" "),
              body: document.body,
            },
          })),
        });
      }

      validated = { artifact, client, documents };
      return validated;
    })();

    try {
      return await loadingPromise;
    } finally {
      loadingPromise = null;
    }
  }

  return {
    async ensureReady(): Promise<void> {
      await loadValidated();
    },
    async getScopes(): Promise<DocsSearchScope[]> {
      const loaded = await loadValidated();
      return [...loaded.artifact.scopes];
    },
    async query(queryInput: DocsSearchRuntimeQueryInput): Promise<DocsSearchRuntimeResultItem[]> {
      const loaded = await loadValidated();
      const normalizedQuery = queryInput.query.trim();
      if (!normalizedQuery) {
        return [];
      }

      const scope = queryInput.scope ?? "all";
      if (scope !== "all" && !loaded.artifact.scopes.includes(scope)) {
        throw createDocsError({
          code: "DOCS_CONFIG_INVALID",
          message: `unknown search scope ${scope}`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_CONFIG_INVALID",
              message: `unknown search scope ${scope}`,
            }),
          ],
        });
      }

      const resources = scope === "all" ? loaded.artifact.scopes : [scope];
      const hits = await loaded.client.searchAll({
        query: normalizedQuery,
        resources,
        limit: Math.max(queryInput.limit ?? 20, 20),
        limitPerResource: Math.max(queryInput.limit ?? 20, 20),
        prefix: true,
      });
      const mapped = hits
        .map((hit) => {
          const document = loaded.documents.get(String(hit.id));
          if (!document) {
            return null;
          }
          return {
            id: document.id,
            score: hit.score,
            scope: document.scope,
            kind: document.kind,
            path: document.path,
            title: document.title,
            summary: document.summary,
          };
        })
        .filter((item): item is DocsSearchRuntimeResultItem => item !== null)
        .filter((item) => item.path.length > 0 && item.title.length > 0)
        .filter((item) => scope === "all" || item.scope === scope);

      return sortResults(mapped, queryInput.limit ?? 20);
    },
  };
}
