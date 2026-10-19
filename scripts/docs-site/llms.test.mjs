import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, loadDocsConfig } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import { loadLlmsSiteSource, withSourceLinks } from "./llms.mjs";

describe("LLM consumer content roots", () => {
  it.each(["default", "relative", "absolute"])("reads %s roots independently of the invocation directory", async (layout) => {
    const cwd = mkdtempSync(join(tmpdir(), "docs-llms-root-"));
    try {
      const contentRoot = layout === "default" ? cwd : join(cwd, "content");
      for (const directory of ["guide", "pages", "blog", "api", "static"]) {
        mkdirSync(join(contentRoot, directory), { recursive: true });
      }
      writeFileSync(join(contentRoot, "guide", "index.md"), "# Isolated fixture\n\nCorrect consumer body.");
      const config = {
        schemaVersion: 1,
        site: { title: "Fixture", basePath: "/docs" },
        content: {
          root: layout === "default" ? "." : layout === "absolute" ? contentRoot : "content",
          docsDir: "guide", pagesDir: "pages", blogDir: "blog", apiDir: "api", assetsDir: "static",
        },
        navigation: { sidebars: { docs: { root: true, include: ["docs/**"] } } },
        search: { enabled: false, scopes: [] },
      };
      writeFileSync(join(cwd, "docsfn.config.ts"), `export default ${JSON.stringify(config)};`);
      const source = await loadLlmsSiteSource(cwd, { buildManifest, loadDocsConfig, FsContentProvider });
      expect(source.manifest.pages["docs:index.md"].body).toContain("Correct consumer body.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("source links for unhosted sites", () => {
  const manifest = { pages: {
    a: { id: "docs:guide/index.md", path: "/docs/guide" },
    b: { id: "pages:about.md", path: "/docs/about" },
  } };
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const site = (docsDir) => ({ content: { root: join(repositoryRoot, "clifn/docs"), docsDir } });

  it("rewrites known docs pages to their GitHub sources and keeps queries and anchors", () => {
    expect(withSourceLinks("[Guide](/docs/guide?tab=ts#setup) [About](/docs/about)", manifest, site("content/docs"), undefined))
      .toBe("[Guide](https://github.com/21nCo/super-functions/blob/dev/clifn/docs/content/docs/guide/index.md?tab=ts#setup) [About](/docs/about)");
  });

  it("derives the source directory from the configured docs directory", () => {
    expect(withSourceLinks("[Guide](/docs/guide)", manifest, site("guides"), undefined))
      .toBe("[Guide](https://github.com/21nCo/super-functions/blob/dev/clifn/docs/guides/guide/index.md)");
  });

  it("rejects a docs directory outside the repository", () => {
    expect(() => withSourceLinks("[Guide](/docs/guide)", manifest, { content: { root: tmpdir(), docsDir: "docs" } }, undefined))
      .toThrow(/outside the repository/);
  });

  it("leaves text unchanged when a public origin is configured", () => {
    expect(withSourceLinks("[Guide](/docs/guide)", manifest, site("content/docs"), "https://clifn.com")).toBe("[Guide](/docs/guide)");
  });
});
