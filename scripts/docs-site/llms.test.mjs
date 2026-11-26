import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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

describe("LLM loader front matter policy", () => {
  const executed = "__docsLlmsFrontMatterExecuted";
  const originalTmpdir = process.env.TMPDIR;
  let cwd;
  let scratch;
  const dependencies = { buildManifest, loadDocsConfig, FsContentProvider };

  /** @param {Record<string, unknown>} [content] */
  function writeSite(content = { root: ".", docsDir: "guide", pagesDir: "pages", blogDir: "blog", apiDir: "api", assetsDir: "static" }) {
    writeFileSync(join(cwd, "docsfn.config.ts"), `export default ${JSON.stringify({
      schemaVersion: 1,
      site: { title: "Fixture", basePath: "/docs" },
      content,
      navigation: { sidebars: { docs: { root: true, include: ["docs/**"] } } },
      search: { enabled: false, scopes: [] },
    })};`);
  }
  /** @param {string} path @param {string} body */
  function write(path, body) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "docs-llms-policy-"));
    // Snapshots are created under os.tmpdir(); point it at a disposable directory we can inspect.
    scratch = mkdtempSync(join(tmpdir(), "docs-llms-scratch-"));
    process.env.TMPDIR = scratch;
    for (const directory of ["guide", "pages", "blog", "api", "static"]) mkdirSync(join(cwd, directory));
    writeSite();
    delete globalThis[executed];
  });
  afterEach(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps plain Markdown, default YAML and explicit YAML metadata", async () => {
    write("guide/plain.md", "# Plain\n\nPlain body.");
    write("guide/default.md", "---\ntitle: Default YAML\norder: 2\n---\nDefault body.");
    write("guide/explicit.md", "--- yaml\ntitle: Explicit YAML\n---\nExplicit body.");
    write("pages/about.mdx", "---YML\r\ntitle: About\r\n---\r\nAbout body.");
    const { manifest } = await loadLlmsSiteSource(cwd, dependencies);
    expect(manifest.pages["docs:plain.md"]).toMatchObject({ title: "Plain", body: "# Plain\n\nPlain body." });
    expect(manifest.pages["docs:default.md"]).toMatchObject({ title: "Default YAML", body: "Default body.", frontmatter: { order: 2 } });
    expect(manifest.pages["docs:explicit.md"]).toMatchObject({ title: "Explicit YAML", body: "Explicit body." });
    expect(manifest.pages["pages:about.mdx"]).toMatchObject({ title: "About", body: "About body." });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it.each([
    ["js", `---js\n({ title: (globalThis.${executed} = true, "Executed") })\n---\nBody`],
    ["javascript", `---javascript\n({ title: (globalThis.${executed} = true, "Executed") })\n---\nBody`],
    ["json", '---json\n{"title":"JSON"}\n---\nBody'],
    ["coffee", "---coffee\ntitle: 'Coffee'\n---\nBody"],
    ["an unregistered engine", "---toml\ntitle = 'TOML'\n---\nBody"],
  ])("rejects %s front matter before the provider parses it and removes the snapshot", async (_name, markdown) => {
    write("guide/index.md", "# Guide");
    write("blog/post.md", markdown);
    await expect(loadLlmsSiteSource(cwd, dependencies)).rejects.toMatchObject({
      code: "DOCS_FRONTMATTER_UNSUPPORTED", sourcePath: join(cwd, "blog", "post.md"),
    });
    expect(globalThis[executed]).toBeUndefined();
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("parses the checked snapshot even when the source changes before the installed provider reads it", async () => {
    write("guide/index.md", "---\ntitle: Original\n---\nOriginal body.");
    const roots = [];
    class EditingProvider extends FsContentProvider {
      constructor(options) {
        writeFileSync(join(cwd, "guide", "index.md"), `---js\n({ title: (globalThis.${executed} = true, "Swapped") })\n---\nSwapped body.`);
        write("guide/late.md", `---js\n({ title: (globalThis.${executed} = true, "Late") })\n---\nLate body.`);
        super(options);
        roots.push(options.root);
      }
    }
    const { manifest } = await loadLlmsSiteSource(cwd, { buildManifest, loadDocsConfig, FsContentProvider: EditingProvider });
    expect(manifest.pages["docs:index.md"]).toMatchObject({ title: "Original", body: "Original body." });
    expect(manifest.pages["docs:late.md"]).toBeUndefined();
    expect(globalThis[executed]).toBeUndefined();
    expect(relative(scratch, roots[0]).split(sep)[0]).toMatch(/^docs-llms-snapshot-/);
    expect(existsSync(roots[0])).toBe(false);
  });

  it.each([
    ["configured directories", undefined],
    ["DocsFn default directories", { root: "." }],
    ["a nested content root", { root: "site", docsDir: "content/docs", pagesDir: "pages" }],
    ["absolute and external directories", "external"],
  ])("builds the same manifest as the provider on the source tree for %s", async (_name, layout) => {
    let content = layout;
    if (layout === "external") {
      const external = join(cwd, "..", `${relative(tmpdir(), cwd)}-external`);
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "outside.md"), "---\ntitle: Outside\n---\nOutside body.");
      content = { root: ".", docsDir: external, pagesDir: join(cwd, "pages"), blogDir: "blog", apiDir: join(cwd, "api"), assetsDir: "static" };
    }
    const root = content?.root === "site" ? join(cwd, "site") : cwd;
    const docs = layout === "external" ? undefined : join(root, content?.docsDir ?? (content ? "content/docs" : "guide"));
    const pages = join(root, "pages");
    for (const directory of [docs, pages, join(root, "blog"), join(root, "api")]) if (directory) mkdirSync(directory, { recursive: true });
    if (docs) {
      mkdirSync(join(docs, "nested", ".hidden"), { recursive: true });
      writeFileSync(join(docs, "index.md"), "---\ntitle: Home\n---\nHome body.");
      writeFileSync(join(docs, "nested", "child.MD"), "# Child");
      writeFileSync(join(docs, "nested", "meta.json"), '{"title":"Nested"}');
      writeFileSync(join(docs, "nested", ".hidden", "secret.md"), "# Hidden");
      writeFileSync(join(docs, "nested", "notes.txt"), "ignored");
      symlinkSync(join(docs, "index.md"), join(docs, "nested", "linked.md"));
    }
    writeFileSync(join(pages, "about.md"), "# About");
    writeFileSync(join(root, "api", "openapi.json"), '{"openapi":"3.0.0","info":{"title":"Example","version":"1"},"paths":{}}');
    writeSite(content);
    const { config, manifest } = await loadLlmsSiteSource(cwd, dependencies);
    const direct = new FsContentProvider({ ...config.content });
    expect(manifest).toEqual(await buildManifest(direct, config));
    expect(Object.keys(manifest.pages).length).toBeGreaterThan(1);
    expect(readdirSync(scratch)).toEqual([]);
    if (layout === "external") rmSync(join(cwd, "..", `${relative(tmpdir(), cwd)}-external`), { recursive: true, force: true });
  });
});

describe("source links for unhosted sites", () => {
  const manifest = { pages: {
    a: { id: "docs:guide/index.md", path: "/docs/guide" },
    b: { id: "pages:about.md", path: "/docs/about" },
  } };

  it("rewrites known docs pages to their GitHub sources and keeps anchors", () => {
    expect(withSourceLinks("[Guide](/docs/guide#setup) [About](/docs/about)", manifest, "clifn", undefined))
      .toBe("[Guide](https://github.com/21nCo/super-functions/blob/dev/clifn/docs/content/docs/guide/index.md#setup) [About](/docs/about)");
  });

  it("keeps query strings on rewritten source links", () => {
    expect(withSourceLinks("[Guide](/docs/guide?tab=ts#setup)", manifest, "clifn", undefined))
      .toBe("[Guide](https://github.com/21nCo/super-functions/blob/dev/clifn/docs/content/docs/guide/index.md?tab=ts#setup)");
  });

  it("leaves text unchanged when a public origin is configured", () => {
    expect(withSourceLinks("[Guide](/docs/guide)", manifest, "clifn", "https://clifn.com")).toBe("[Guide](/docs/guide)");
  });
});
