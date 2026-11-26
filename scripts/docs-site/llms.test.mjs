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
  /** @type {string[]} */
  let disposable;
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

  /** A disposable directory outside the site, under the system temp directory. */
  function external() {
    const directory = mkdtempSync(join(systemTmpdir, "docs-llms-external-"));
    disposable.push(directory);
    return directory;
  }
  let systemTmpdir = tmpdir();

  beforeEach(() => {
    systemTmpdir = tmpdir();
    cwd = mkdtempSync(join(systemTmpdir, "docs-llms-policy-"));
    // Snapshots are created under os.tmpdir(); point it at a disposable directory we can inspect.
    scratch = mkdtempSync(join(systemTmpdir, "docs-llms-scratch-"));
    disposable = [cwd, scratch];
    process.env.TMPDIR = scratch;
    for (const directory of ["guide", "pages", "blog", "api", "static"]) mkdirSync(join(cwd, directory));
    writeSite();
    delete globalThis[executed];
  });
  afterEach(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    delete process.env.DOCSFN_HTML_UNSAFE_ALLOWLIST;
    for (const directory of disposable) rmSync(directory, { recursive: true, force: true });
  });

  /** Build through the snapshot and directly on the source tree with the installed provider. */
  async function expectProviderParity() {
    const { config, manifest } = await loadLlmsSiteSource(cwd, dependencies);
    const direct = new FsContentProvider({ ...config.content });
    expect(manifest).toEqual(await buildManifest(direct, config));
    expect(readdirSync(scratch)).toEqual([]);
    return manifest;
  }

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
      const outside = external();
      writeFileSync(join(outside, "outside.md"), "---\ntitle: Outside\n---\nOutside body.");
      content = { root: ".", docsDir: outside, pagesDir: join(cwd, "pages"), blogDir: "blog", apiDir: join(cwd, "api"), assetsDir: "static" };
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
    const manifest = await expectProviderParity();
    expect(Object.keys(manifest.pages).length).toBeGreaterThan(1);
  });

  it("builds a docs-only site with DocsFn defaults like the provider", async () => {
    for (const directory of ["guide", "pages", "blog", "api", "static"]) rmSync(join(cwd, directory), { recursive: true });
    write("content/docs/index.md", "---\ntitle: Home\n---\nHome body.");
    writeSite({ root: "." });
    const manifest = await expectProviderParity();
    expect(Object.keys(manifest.pages)).toEqual(["docs:index.md"]);
  });

  it("keeps an external collection apart from an in-root directory named like its snapshot", async () => {
    const outside = external();
    writeFileSync(join(outside, "index.md"), "# Outside docs");
    write("external-docs/index.md", "# In-root pages");
    write("external/docs/post.md", "---\ntitle: Post\ndate: \"2026-01-01\"\n---\nNested in-root post.");
    writeSite({ root: ".", docsDir: outside, pagesDir: "external-docs", blogDir: "external/docs" });
    const manifest = await expectProviderParity();
    expect(manifest.pages["docs:index.md"].body).toBe("# Outside docs");
    expect(manifest.pages["pages:index.md"].body).toBe("# In-root pages");
    expect(Object.values(manifest.posts).map((post) => post.body)).toEqual(["Nested in-root post."]);
  });

  it.each([
    ["an unconfigured assets directory without public", { root: ".", docsDir: "guide" }],
    ["a missing optional pages directory", { root: ".", docsDir: "guide", pagesDir: "pages" }],
  ])("resolves %s like the provider", async (_name, content) => {
    rmSync(join(cwd, "pages"), { recursive: true });
    rmSync(join(cwd, "static"), { recursive: true });
    write("guide/index.md", "# Guide");
    write("assets/logo.svg", "<svg/>");
    writeSite(content);
    await expectProviderParity();
  });

  it.each([
    ["a missing docs directory", { root: ".", docsDir: "missing" }, "configured docsDir missing does not exist", "missing"],
    ["a missing external pages directory", { root: ".", docsDir: "guide", pagesDir: "../docs-llms-absent" }, "configured pagesDir ", "../docs-llms-absent"],
  ])("reports %s at its source path", async (_name, content, message, path) => {
    write("guide/index.md", "# Guide");
    writeSite(content);
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error).toMatchObject({ code: "DOCS_ENTRY_INVALID" });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("docs-llms-snapshot-");
    expect(error.diagnostics[0].location.absolutePath).toBe(join(cwd, path));
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("applies path-based trust rules and diagnostics to the source files, not the snapshot", async () => {
    write("guide/index.md", "# Guide");
    write("guide/unsafe.md", "# Unsafe\n\n<script>alert(1)</script>");
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error).toMatchObject({ code: "DOCS_HTML_UNSAFE" });
    expect(error.diagnostics[0].location.absolutePath).toBe(join(cwd, "guide", "unsafe.md"));
    process.env.DOCSFN_HTML_UNSAFE_ALLOWLIST = join(cwd, "guide", "unsafe.md");
    const { manifest } = await loadLlmsSiteSource(cwd, dependencies);
    expect(manifest.pages["docs:unsafe.md"].body).toContain("<script>");
    expect(readdirSync(scratch)).toEqual([]);
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
