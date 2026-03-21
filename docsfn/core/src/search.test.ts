import { describe, expect, it } from "vitest";
import { buildSearchIndex } from "./search";
import type { DocsManifest } from "./types";

function createManifest(): DocsManifest {
  return {
    site: {
      title: "Search Docs",
      description: "Search fixture",
    },
    pages: {
      "docs:index": {
        kind: "page",
        id: "docs:index",
        slug: "",
        path: "/docs",
        title: "Home",
        description: "Welcome to docs",
        body: "# Home\n\nWelcome to docs",
        headings: [{ level: 1, text: "Home", slug: "home" }],
        frontmatter: {},
      },
      "docs:adapter": {
        kind: "page",
        id: "docs:adapter",
        slug: "reference/adapters/indexeddb",
        path: "/docs/reference/adapters/indexeddb",
        title: "IndexedDB Adapter",
        description: "Adapter guide",
        body: "# IndexedDB Adapter\n\nAdapter details and setup.",
        headings: [
          { level: 1, text: "IndexedDB Adapter", slug: "indexeddb-adapter" },
          { level: 2, text: "Setup", slug: "setup" },
        ],
        frontmatter: {},
      },
    },
    posts: {
      "blog:release": {
        kind: "post",
        id: "blog:release",
        slug: "release-1",
        path: "/docs/blog/release-1",
        title: "Release Notes",
        date: "2026-03-01",
        excerpt: "Release highlights",
        tags: ["release", "platform"],
        body: "Big release with platform improvements.",
        frontmatter: {},
      },
    },
    apis: {
      "api:search": {
        kind: "api",
        id: "api:search",
        slug: "search",
        path: "/docs/api/search",
        title: "Search API",
        spec: {
          info: {
            title: "Search API",
            description: "Search endpoints",
          },
        },
        frontmatter: {},
      },
    },
    sidebars: {},
    routes: {},
  };
}

describe("buildSearchIndex", () => {
  it("indexes docs/api/blog scopes with deterministic output (TV-SEARCH-001)", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
        bodyIndexing: "summary",
      },
    });

    expect(artifact.engine).toBe("searchfn");
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.scopes).toEqual(["api", "blog", "docs"]);
    expect(artifact.documents.map((doc) => doc.id)).toEqual([
      "api:search",
      "blog:release",
      "docs:adapter",
      "docs:index",
    ]);
    expect(artifact.documents.find((doc) => doc.id === "docs:adapter")?.headings).toEqual([
      "IndexedDB Adapter",
      "Setup",
    ]);
  });

  it("is deterministic even when manifest object insertion order changes (DET-001)", async () => {
    const manifestA = createManifest();
    const manifestB = createManifest();
    manifestB.pages = Object.fromEntries(Object.entries(manifestB.pages).reverse());
    manifestB.posts = Object.fromEntries(Object.entries(manifestB.posts).reverse());
    manifestB.apis = Object.fromEntries(Object.entries(manifestB.apis).reverse());

    const artifactA = await buildSearchIndex(manifestA, {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });
    const artifactB = await buildSearchIndex(manifestB, {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });

    expect(JSON.stringify(artifactA)).toBe(JSON.stringify(artifactB));
  });

  it("throws DOCS_SEARCH_BUILD_FAILED for empty search scopes", async () => {
    await expect(
      buildSearchIndex(createManifest(), {
        search: {
          enabled: true,
          scopes: [],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_BUILD_FAILED|scopes cannot be empty/);
  });

  it("throws DOCS_SEARCH_BUILD_FAILED for duplicate source ids across scopes", async () => {
    const manifest = createManifest();
    manifest.posts = {
      "docs:adapter": {
        kind: "post",
        id: "docs:adapter",
        slug: "duplicate",
        path: "/docs/blog/duplicate",
        title: "Duplicate",
        date: "2026-03-01",
        tags: [],
        body: "duplicate id",
        frontmatter: {},
      },
    };

    await expect(
      buildSearchIndex(manifest, {
        search: {
          enabled: true,
          scopes: ["docs", "blog"],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_BUILD_FAILED|duplicated/);
  });

  it("emits warning diagnostics when artifact exceeds configured max bytes", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
        maxArtifactBytes: 100,
      },
    });

    expect(artifact.diagnostics.some((diagnostic) => diagnostic.severity === "warning")).toBe(
      true
    );
    expect(artifact.bytes).toBeGreaterThan(100);
  });

  it("supports disabled body indexing", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs"],
        bodyIndexing: "disabled",
      },
    });

    expect(artifact.bodyIndexing).toBe("disabled");
    expect(artifact.documents.length).toBe(2);
  });
});
