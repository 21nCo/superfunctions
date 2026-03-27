import { describe, expect, it } from "vitest";
import {
  createDocsSiteSearchRuntime,
  getDocsSiteCompiledCacheSummary,
  loadDocsSiteSource,
} from "./docs-site-source";
import { load as loadBlogPage } from "../../routes/blog/[slug]/+page.server";
import { load as loadDocsPage } from "../../routes/docs/[...slug]/+page.server";

describe("docsfn dogfood site source", () => {
  it("classifies API content truthfully and queries through the canonical search runtime", async () => {
    const source = await loadDocsSiteSource();

    const apiMarkdownPage = source.searchArtifact.documents.find(
      (document) => document.path === "/docs/api/core"
    );
    expect(apiMarkdownPage?.kind).toBe("page");
    expect(apiMarkdownPage?.scope).toBe("api");

    const generatedApiDocument = source.searchArtifact.documents.find(
      (document) => document.kind === "api"
    );
    expect(generatedApiDocument).toBeDefined();
    expect(generatedApiDocument?.scope).toBe("api");

    const runtime = await createDocsSiteSearchRuntime();
    const results = await runtime.query({
      query: "manifest",
      scope: "api",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.scope === "api")).toBe(true);
    expect(results.some((item) => item.path === "/docs/api/core")).toBe(true);
    expect(results.some((item) => item.path.startsWith("/docs/core-concepts/"))).toBe(false);
  });

  it("reuses deterministic compiled artifacts across repeated docs and blog loads", async () => {
    const source = await loadDocsSiteSource();

    const cacheSummaryA = await getDocsSiteCompiledCacheSummary();
    const cacheSummaryB = await getDocsSiteCompiledCacheSummary();

    expect(cacheSummaryA).toEqual(cacheSummaryB);
    expect(cacheSummaryA.framework).toBe("svelte");
    expect(cacheSummaryA.pageKeys.length).toBeGreaterThan(0);
    expect(cacheSummaryA.postKeys.length).toBeGreaterThan(0);
    expect(cacheSummaryA.pageKeys.every((key) => key.endsWith("|svelte|none"))).toBe(true);
    expect(cacheSummaryA.postKeys.every((key) => key.endsWith("|svelte|none"))).toBe(true);

    const firstDocsLoad = await loadDocsPage({
      params: {
        slug: ["api", "core"],
      },
      parent: async () => ({ source }),
    } as never);
    const secondDocsLoad = await loadDocsPage({
      params: {
        slug: ["api", "core"],
      },
      parent: async () => ({ source }),
    } as never);

    expect(firstDocsLoad.compiled).toBe(secondDocsLoad.compiled);
    expect(firstDocsLoad.compiled?.renderModelVersion).toBe(2);

    const firstBlogLoad = await loadBlogPage({
      params: {
        slug: "introducing-docsfn",
      },
      parent: async () => ({ source }),
    } as never);
    const secondBlogLoad = await loadBlogPage({
      params: {
        slug: "introducing-docsfn",
      },
      parent: async () => ({ source }),
    } as never);

    expect(firstBlogLoad.compiled).toBe(secondBlogLoad.compiled);
    expect(firstBlogLoad.compiled?.renderModelVersion).toBe(2);
  });
});
