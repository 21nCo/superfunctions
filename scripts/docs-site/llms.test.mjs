import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix, relative, resolve, sep, win32 } from "node:path";
import { buildManifest, loadDocsConfig } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import { assertEntriesFromSnapshot, assertProviderContentInsideSnapshot, createSnapshotPathMapper, loadLlmsSiteSource, withSourceLinks } from "./llms.mjs";

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
  const temporaryVariables = ["TMPDIR", "TEMP", "TMP"];
  const originalTemporary = temporaryVariables.map((name) => process.env[name]);
  /** os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows. @param {string} directory */
  function redirectTemporary(directory) {
    scratch = directory;
    for (const name of temporaryVariables) process.env[name] = directory;
  }
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
    redirectTemporary(mkdtempSync(join(systemTmpdir, "docs-llms-scratch-")));
    disposable = [cwd, scratch];
    for (const directory of ["guide", "pages", "blog", "api", "static"]) mkdirSync(join(cwd, directory));
    writeSite();
    delete globalThis[executed];
  });
  afterEach(() => {
    temporaryVariables.forEach((name, index) => {
      if (originalTemporary[index] === undefined) delete process.env[name];
      else process.env[name] = originalTemporary[index];
    });
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

  /** Fail through the snapshot and directly on the source tree with the same error and location. */
  async function expectProviderErrorParity() {
    const config = await loadDocsConfig({ cwd });
    const directConfig = { ...config, content: { ...config.content, root: join(cwd, config.content.root) } };
    const direct = await buildManifest(new FsContentProvider({ ...directConfig.content }), directConfig).then(() => undefined, (caught) => caught);
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(direct).toBeDefined();
    expect({ code: error?.code, message: error?.message, diagnostics: error?.diagnostics })
      .toEqual({ code: direct.code, message: direct.message, diagnostics: direct.diagnostics });
    expect(readdirSync(scratch)).toEqual([]);
    return error;
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
    // Staged under the canonical (real) temp dir.
    expect(relative(realpathSync.native(scratch), roots[0]).split(sep)[0]).toMatch(/^docs-llms-snapshot-/);
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
      // File symbolic links need a privilege Windows runners usually lack.
      if (process.platform !== "win32") symlinkSync(join(docs, "index.md"), join(docs, "nested", "linked.md"));
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

  it("snapshots collections that re-enter the content root through its parent like the provider", async () => {
    write("site/guide/index.md", "---\ntitle: Home\n---\nHome body.");
    write("site/guide/nested/meta.json", '{"title":"Nested"}');
    write("site/guide/nested/child.md", "# Child");
    write("site/extra/about.md", "# About");
    writeSite({ root: "site", docsDir: "../site/guide", pagesDir: "../site/extra" });
    const manifest = await expectProviderParity();
    expect(manifest.pages["docs:index.md"].body).toBe("Home body.");
    expect(manifest.pages["pages:about.md"].body).toBe("# About");
  });

  it.each([
    ["re-entering docs", { root: ".", docsDir: "../{site}/absent" }],
    ["re-entering pages", { root: ".", docsDir: "guide", pagesDir: "../{site}/absent" }],
    ["in-root docs", { root: ".", docsDir: "absent" }],
    ["escaping pages", { root: ".", docsDir: "guide", pagesDir: "../docs-llms-absent" }],
    ["absolute blog", { root: ".", docsDir: "guide", blogDir: "{cwd}/absent" }],
  ])("fails a missing %s directory strictly with the provider's message and source location", async (_name, content) => {
    write("guide/index.md", "# Guide");
    writeSite(JSON.parse(JSON.stringify(content).replaceAll("{site}", basename(cwd)).replaceAll("{cwd}", cwd.replaceAll("\\", "/"))));
    const error = await expectProviderErrorParity();
    expect(error.code).toBe("DOCS_ENTRY_INVALID");
    expect(error.message).not.toContain("docs-llms-snapshot-");
  });

  it.each(["docsDir", "pagesDir", "blogDir"])("hands the provider only snapshot paths for an absolute %s under a missing root", async (key) => {
    const live = external();
    writeFileSync(join(live, "index.md"), `---js\n({ title: (globalThis.${executed} = true, "Executed") })\n---\nBody`);
    writeSite({ root: "absent", docsDir: "guide", [key]: live.replaceAll("\\", "/") });
    const error = await expectProviderErrorParity();
    expect(error.code).toBe("DOCS_ENTRY_INVALID");
    expect(error.message).toContain(join(cwd, "absent"));
    expect(error.message).not.toContain("docs-llms-snapshot-");
    const received = [];
    class RecordingProvider extends FsContentProvider {
      async listEntries(input) {
        received.push(input.config.content);
        return super.listEntries(input);
      }
    }
    await expect(loadLlmsSiteSource(cwd, { buildManifest, loadDocsConfig, FsContentProvider: RecordingProvider })).rejects.toMatchObject({ code: "DOCS_ENTRY_INVALID" });
    expect(received).toHaveLength(1);
    const staging = relative(realpathSync.native(scratch), received[0].root).split(sep)[0];
    expect(staging).toMatch(/^docs-llms-snapshot-/);
    for (const name of ["docsDir", "pagesDir", "blogDir"]) {
      if (received[0][name] === undefined) continue;
      const resolved = relative(join(realpathSync.native(scratch), staging), resolve(received[0].root, received[0][name]));
      expect(resolved.startsWith("..")).toBe(false);
    }
    expect(globalThis[executed]).toBeUndefined();
  });

  it("stages in a temp dir inside the site when no collection contains it", async () => {
    write("guide/index.md", "# Guide");
    write("pages/about.md", "# About");
    mkdirSync(join(cwd, "tmp"));
    redirectTemporary(join(cwd, "tmp"));
    await expectProviderParity();
  });

  const defaultLayout = { root: ".", docsDir: "guide", pagesDir: "pages", blogDir: "blog", apiDir: "api", assetsDir: "static" };
  it.each([
    ["a root-level pages collection", { root: ".", docsDir: "guide", pagesDir: "." }, "tmp", "pagesDir"],
    ["a docs collection", defaultLayout, "guide/tmp", "docsDir"],
    ["the API directory", defaultLayout, "api/tmp", "apiDir"],
    ["the assets directory", defaultLayout, "static/tmp", "assetsDir"],
  ])("refuses to stage when the temp dir is inside %s, where another build's snapshot already lives", async (_name, content, temporary, key) => {
    write("guide/index.md", "# Guide");
    // A concurrent build's live snapshot in the same temp dir must never become content either.
    write(`${temporary}/docs-llms-snapshot-other/root/meta.json`, '{"title":"Staged"}');
    write(`${temporary}/docs-llms-snapshot-other/root/staged.md`, "# Staged");
    redirectTemporary(join(cwd, temporary));
    writeSite(content);
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error?.message).toContain(`is inside the docs ${key} `);
    expect(error?.message).toContain("TMPDIR");
    expect(readdirSync(scratch)).toEqual(["docs-llms-snapshot-other"]);
  });

  it("stages under a relative temp dir resolved once, like an absolute one", async () => {
    for (const directory of ["guide", "pages", "blog", "api", "static"]) rmSync(join(cwd, directory), { recursive: true });
    write("content/docs/index.md", "---\ntitle: Home\n---\nHome body.");
    mkdirSync(join(cwd, "tmp"));
    writeSite({ root: "." });
    const invocation = process.cwd();
    process.chdir(cwd);
    try {
      redirectTemporary("tmp");
      scratch = join(cwd, "tmp");
      const manifest = await expectProviderParity();
      expect(Object.keys(manifest.pages)).toEqual(["docs:index.md"]);
    } finally {
      process.chdir(invocation);
    }
  });

  it.each([
    ["the docs collection", "guide"],
    ["the assets directory", "static"],
  ])("stages where a temp dir reaching out of %s through a symbolic link and .. really points", async (_name, collection) => {
    write("guide/index.md", "# Guide");
    write("static/logo.svg", "<svg/>");
    const outside = external();
    mkdirSync(join(outside, "child"));
    symlinkSync(join(outside, "child"), join(cwd, collection, "link"), process.platform === "win32" ? "junction" : "dir");
    // Not path.join, which would drop "link/.." lexically.
    redirectTemporary(`${join(cwd, collection, "link")}${sep}..`);
    // Sorts before the staging tree name, so a snapshot staged inside the docs walk would copy itself.
    write("guide/a.md", "# A");
    const roots = [];
    class RecordingProvider extends FsContentProvider {
      constructor(options) {
        super(options);
        roots.push(options.root);
      }
    }
    const { config, manifest } = await loadLlmsSiteSource(cwd, { ...dependencies, FsContentProvider: RecordingProvider });
    expect(manifest).toEqual(await buildManifest(new FsContentProvider({ ...config.content }), config));
    expect(JSON.stringify(manifest)).not.toContain("docs-llms-snapshot-");
    // The snapshot was staged where the temp dir really is, outside the collection.
    expect(relative(realpathSync.native(outside), roots[0]).split(sep)[0]).toMatch(/^docs-llms-snapshot-/);
    expect(readdirSync(join(cwd, collection)).sort()).toEqual(collection === "guide" ? ["a.md", "index.md", "link"] : ["link", "logo.svg"]);
    expect(readdirSync(outside)).toEqual(["child"]);
  });

  it.each([
    ["a root-level pages collection", { root: ".", docsDir: "guide", pagesDir: "." }, "docs-llms-snapshot-old", "pagesDir"],
    ["a nested docs directory", defaultLayout, "guide/nested/docs-llms-snapshot-old", "docsDir"],
    ["the API directory", defaultLayout, "api/docs-llms-snapshot-old", "apiDir"],
    ["the assets directory", defaultLayout, "static/docs-llms-snapshot-old", "assetsDir"],
  ])("refuses a staging tree left in %s by an interrupted build", async (_name, content, stale, key) => {
    write("guide/index.md", "# Guide");
    write(`${stale}/collections/docs/meta.json`, '{"title":"Staged"}');
    write(`${stale}/collections/docs/x.md`, "# Staged");
    writeSite(content);
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error?.message).toContain(`The docs ${key} `);
    expect(error?.message).toContain(`staging tree ${join(cwd, ...stale.split("/"))} `);
    expect(readdirSync(scratch)).toEqual([]);
  });

  // POSIX only: on Windows a backslash is the separator the provider's fast-glob listing is meant to rewrite.
  it.skipIf(process.platform === "win32")("refuses a temp dir whose real path holds a backslash the provider's listing would rewrite", async () => {
    write("guide/index.md", "# Guide");
    // fast-glob would report <outer>/a/b/... for files under <outer>/a\b: this sibling must never be read.
    const outer = external();
    mkdirSync(join(outer, "a", "b"), { recursive: true });
    const temporary = join(outer, "a\\b");
    mkdirSync(temporary);
    redirectTemporary(temporary);
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error?.message).toContain(`The temporary directory ${temporary} `);
    expect(error?.message).toContain("backslash");
    expect(error?.message).toContain("TMPDIR");
    expect(readdirSync(temporary)).toEqual([]);
    expect(readdirSync(join(outer, "a", "b"))).toEqual([]);
  });

  // POSIX only: fast-glob turns each backslash in a listed name into a separator, so "a\\..\\..\\<path>"
  // in a collection would make the provider read <path> outside every checked collection.
  it.skipIf(process.platform === "win32").each([
    ["docs", "docsDir", "guide"],
    ["pages", "pagesDir", "pages"],
    ["blog", "blogDir", "blog"],
  ])("refuses a %s file name with backslashes that the provider's listing would resolve outside the snapshot", async (_collection, key, directory) => {
    // Blog posts need a publish date, so every file here builds without the backslash name.
    write("notes/evil.md", `---js\n{ title: (globalThis.${executed} = true, "Evil"), date: "2026-01-01" }\n---\n# evil`);
    write(`${directory}/index.md`, "---\ndate: \"2026-01-01\"\n---\n# Index");
    write(`${directory}/a/x.md`, "---\ndate: \"2026-01-01\"\n---\n# X");
    const decoy = `a${"\\..".repeat(24)}${join(cwd, "notes", "evil.md").replaceAll("/", "\\")}`;
    write(`${directory}/${decoy}`, "# Decoy");
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error?.message).toContain(`The docs ${key} ${join(cwd, directory)} contains ${join(cwd, directory, decoy)}, `);
    expect(error?.message).toContain("backslash");
    expect(error?.message).not.toContain("docs-llms-snapshot-");
    expect(globalThis[executed]).toBeUndefined();
    expect(readdirSync(scratch)).toEqual([]);
  });

  it.skipIf(process.platform === "win32").each([
    ["an api file", "apiDir", "api", "a\\b.json"],
    ["an assets file", "assetsDir", "static", "a\\b.png"],
    ["a docs directory", "docsDir", "guide", "sub\\dir/x.md"],
    ["an api directory", "apiDir", "api", "sub\\dir/x.json"],
  ])("refuses %s whose name holds a backslash", async (_name, key, directory, path) => {
    write("guide/index.md", "# Guide");
    write(`${directory}/${path}`, directory === "guide" ? "# X" : "{}");
    const named = join(cwd, directory, path.split("/")[0]);
    const error = await loadLlmsSiteSource(cwd, dependencies).then(() => undefined, (caught) => caught);
    expect(error?.message).toContain(`The docs ${key} ${join(cwd, directory)} contains ${named}, `);
    expect(error?.message).toContain("backslash");
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("snapshots each collection on its own when one contains another's case variant", async (context) => {
    rmSync(join(cwd, "guide"), { recursive: true });
    write("Guide/intro.md", "# Intro");
    // Only a case-insensitive volume resolves docsDir "guide" to the Guide directory.
    if (!existsSync(join(cwd, "guide", "intro.md"))) context.skip();
    writeSite({ root: ".", docsDir: "guide", pagesDir: "." });
    const manifest = await expectProviderParity();
    expect(Object.keys(manifest.pages).filter((id) => id.endsWith("intro.md"))).toEqual(["docs:intro.md", "pages:Guide/intro.md"]);
  });

  it("does not list a symlinked docs collection under a root-level pages collection", async () => {
    const outside = external();
    writeFileSync(join(outside, "intro.md"), "# Intro");
    symlinkSync(outside, join(cwd, "guide-link"), process.platform === "win32" ? "junction" : "dir");
    write("pages/about.md", "# About");
    writeSite({ root: ".", docsDir: "guide-link", pagesDir: "." });
    const manifest = await expectProviderParity();
    expect(Object.keys(manifest.pages).filter((id) => id.endsWith("intro.md"))).toEqual(["docs:intro.md"]);
  });

  it("applies path-based trust rules and diagnostics to the source files, not the snapshot", async () => {
    write("guide/index.md", "# Guide");
    write("guide/unsafe.md", "# Unsafe\n\n<script>alert(1)</script>");
    const error = await expectProviderErrorParity();
    expect(error).toMatchObject({ code: "DOCS_HTML_UNSAFE" });
    // The provider reports fast-glob paths, which use forward slashes on Windows as well.
    const reported = error.diagnostics[0].location.absolutePath;
    expect(reported).toBe(join(cwd, "guide", "unsafe.md").replaceAll(sep, "/"));
    process.env.DOCSFN_HTML_UNSAFE_ALLOWLIST = reported;
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

describe("snapshot path mapping", () => {
  it("maps native and slash-form Windows paths back to the source in the form they arrived", () => {
    const mapper = createSnapshotPathMapper([
      ["C:\\Temp\\docs-llms-snapshot-1\\root", "C:\\site"],
      ["C:\\Temp\\docs-llms-snapshot-1\\external\\docs", "D:\\reference"],
    ], win32, [["configured docsDir C:\\Temp\\docs-llms-snapshot-1\\external\\docs ", "configured docsDir ../reference "]]);
    expect(mapper.toSourcePath("C:/Temp/docs-llms-snapshot-1/root/guide/index.md")).toBe("C:/site/guide/index.md");
    expect(mapper.toSourcePath("C:\\Temp\\docs-llms-snapshot-1\\root\\guide\\index.md")).toBe("C:\\site\\guide\\index.md");
    expect(mapper.toSourcePath("C:\\Temp\\docs-llms-snapshot-1\\root")).toBe("C:\\site");
    expect(mapper.toSourcePath("C:/Temp/docs-llms-snapshot-1/external/docs/a/b.md")).toBe("D:/reference/a/b.md");
    expect(mapper.toSourcePath("C:/Temp/docs-llms-snapshot-1/rootless/a.md")).toBe("C:/Temp/docs-llms-snapshot-1/rootless/a.md");
    expect(mapper.toSourceText("bad C:/Temp/docs-llms-snapshot-1/root/a.md and C:\\Temp\\docs-llms-snapshot-1\\root\\b.md"))
      .toBe("bad C:/site/a.md and C:\\site\\b.md");
    expect(mapper.toSourceText("configured docsDir C:\\Temp\\docs-llms-snapshot-1\\external\\docs does not exist"))
      .toBe("configured docsDir ../reference does not exist");
  });

  it("keeps POSIX mapping literal, including backslashes inside file names", () => {
    const mapper = createSnapshotPathMapper([["/tmp/docs-llms-snapshot-1/root", "/site"]], posix);
    expect(mapper.toSourcePath("/tmp/docs-llms-snapshot-1/root/guide/a\\b.md")).toBe("/site/guide/a\\b.md");
    expect(mapper.toSourcePath("/tmp/docs-llms-snapshot-1/root")).toBe("/site");
    expect(mapper.toSourcePath("/tmp/docs-llms-snapshot-1/rootless/a.md")).toBe("/tmp/docs-llms-snapshot-1/rootless/a.md");
    expect(mapper.toSourceText("at /tmp/docs-llms-snapshot-1/root/a.md")).toBe("at /site/a.md");
    const special = createSnapshotPathMapper([["/tmp/docs-llms-snapshot-1/root", "/site/$&$'x"]], posix);
    expect(special.toSourceText("at /tmp/docs-llms-snapshot-1/root/a.md")).toBe("at /site/$&$'x/a.md");
  });
});

describe("provider content check", () => {
  const base = join(tmpdir(), "docs-llms-snapshot-unit");
  const root = join(base, "root");
  it("accepts a root and Markdown directories inside the snapshot", () => {
    expect(() => assertProviderContentInsideSnapshot({ root, docsDir: "content/docs", pagesDir: join(base, "collections", "pages"), blogDir: undefined, apiDir: "/live/api" }, base)).not.toThrow();
  });
  it.each([
    ["an absolute live docs directory", { root, docsDir: join(tmpdir(), "live-docs") }, "docsDir"],
    ["an escaping pages directory", { root, pagesDir: "../../live-pages" }, "pagesDir"],
    ["a non-string blog directory", { root, blogDir: 1 }, "blogDir"],
    ["a root outside the snapshot", { root: tmpdir() }, "root"],
    ["a relative root", { root: "root" }, "root"],
  ])("rejects %s", (_name, content, key) => {
    expect(() => assertProviderContentInsideSnapshot(content, base)).toThrow(`Docs snapshot ${key} `);
  });
  it.skipIf(sep !== "/").each([
    ["a root", { root: join(base, "a\\b") }, "root"],
    ["a docs directory", { root, docsDir: join(base, "collections", "a\\b") }, "docsDir"],
    ["a relative pages directory", { root, pagesDir: "a\\b" }, "pagesDir"],
  ])("rejects %s holding a backslash on POSIX", (_name, content, key) => {
    expect(() => assertProviderContentInsideSnapshot(content, base)).toThrow(`Docs snapshot ${key} `);
    expect(() => assertProviderContentInsideSnapshot(content, base)).toThrow("backslash");
  });
});

describe("provider entry check", () => {
  const base = resolve("/snapshot");
  const checked = join(base, "collections", "docs", "index.md");
  const snapshot = { files: new Set([checked]), toSourcePath: (path) => path.replace(join(base, "collections", "docs"), resolve("/site/guide")) };

  it("accepts Markdown entries from checked snapshot files and ignores API and asset entries", () => {
    expect(() => assertEntriesFromSnapshot([
      { collection: "docs", absolutePath: checked.replaceAll(sep, "/") },
      { collection: "api", absolutePath: resolve("/site/api/openapi.json") },
      { collection: "assets", absolutePath: resolve("/site/static/logo.png") },
    ], snapshot)).not.toThrow();
  });

  it.each([
    ["a path the provider resolved outside the snapshot", { collection: "pages", absolutePath: `${join(base, "collections", "docs", "a")}/../../../../site/notes/evil.md` }, resolve("/site/notes/evil.md")],
    ["an unchecked snapshot path", { collection: "blog", absolutePath: join(base, "collections", "docs", "other.md") }, resolve("/site/guide/other.md")],
    ["a missing path", { collection: "docs" }, "undefined"],
  ])("rejects %s", (_name, entry, reported) => {
    expect(() => assertEntriesFromSnapshot([entry], snapshot)).toThrow(`entry ${reported}, which is not a checked snapshot file`);
  });
});
