// Runs the real CliFn LLM prebuild entry point on a disposable copy of the site with local fixtures.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(siteDir, "../..");
let workspace;
let site;
let scratch;

/** @param {string} path @param {string} body */
function write(path, body) {
  mkdirSync(dirname(join(site, path)), { recursive: true });
  writeFileSync(join(site, path), body);
}

function prebuild() {
  return spawnSync(process.execPath, [join(site, "scripts", "generate-llms.mjs")], {
    cwd: site,
    encoding: "utf8",
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
    env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch, CLOUDFLARE_DOCS_DEPLOY: "" },
  });
}

/** Resolve a package the way the copied entry point does, from its own directory. */
function resolveFrom(directory, specifier) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], {
    cwd: directory, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return realpathSync(fileURLToPath(result.stdout.trim()));
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "clifn-docs-prebuild-"));
  scratch = mkdtempSync(join(tmpdir(), "clifn-docs-prebuild-tmp-"));
  site = join(workspace, "clifn", "docs");
  for (const file of ["scripts/docs-site/llms.mjs", "scripts/docs-site/front-matter.mjs"]) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    copyFileSync(join(repoRoot, file), join(workspace, file));
  }
  for (const file of ["scripts/generate-llms.mjs", "docsfn.config.ts", "package.json"]) {
    mkdirSync(dirname(join(site, file)), { recursive: true });
    copyFileSync(join(siteDir, file), join(site, file));
  }
  // Reuse the installed packages so the entry point loads the actual DocsFn provider.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(join(siteDir, "node_modules"), join(site, "node_modules"), linkType);
  symlinkSync(join(repoRoot, "node_modules"), join(workspace, "node_modules"), linkType);
  for (const directory of ["content/pages", "content/blog", "content/api", "static"]) mkdirSync(join(site, directory), { recursive: true });
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("CliFn docs LLM prebuild front matter policy", () => {
  it("loads the installed DocsFn provider from the copied entry point", () => {
    const copied = join(site, "scripts");
    const installed = resolve(siteDir, "scripts");
    assert.equal(resolveFrom(copied, "@docsfn/provider-fs"), resolveFrom(installed, "@docsfn/provider-fs"));
    assert.equal(resolveFrom(copied, "@docsfn/core"), resolveFrom(installed, "@docsfn/core"));
  });

  it("publishes plain Markdown, default YAML and explicit YAML pages with source links", () => {
    write("content/docs/index.md", "# Plain fixture\n\nPlain fixture body.");
    write("content/docs/default.md", "---\ntitle: Default YAML fixture\ndescription: Default description\n---\nDefault fixture body.");
    write("content/docs/explicit.md", "--- yaml\r\ntitle: Explicit YAML fixture\r\n---\r\nExplicit fixture body.");
    const result = prebuild();
    assert.equal(result.status, 0, result.stderr);
    const index = readFileSync(join(site, "static", "llms.txt"), "utf8");
    const full = readFileSync(join(site, "static", "llms-full.txt"), "utf8");
    for (const title of ["Default YAML fixture", "Explicit YAML fixture"]) assert.match(index, new RegExp(title));
    for (const body of ["Plain fixture body.", "Default fixture body.", "Explicit fixture body."]) assert.match(full, new RegExp(body));
    assert.doesNotMatch(full, /title: /);
    assert.match(index, /\]\(https:\/\/github\.com\/21nCo\/super-functions\/blob\/dev\/clifn\/docs\/content\/docs\/default\.md\)/);
    assert.deepEqual(readdirSync(scratch), []);
  });

  for (const [label, block] of [
    ["js", `---js\n({ title: (require("node:fs").writeFileSync(MARKER, "executed"), "Executed") })\n---\n`],
    ["javascript", `---javascript\n({ title: (require("node:fs").writeFileSync(MARKER, "executed"), "Executed") })\n---\n`],
    ["json", '---json\n{"title":"JSON fixture"}\n---\n'],
    ["coffee", "---coffee\ntitle: 'Coffee fixture'\n---\n"],
  ]) {
    it(`fails on ${label} front matter before parsing and leaves published files unchanged`, () => {
      const marker = join(workspace, `${label}-executed`);
      const published = ["llms.txt", "llms-full.txt"].map((name) => readFileSync(join(site, "static", name), "utf8"));
      write("content/docs/unsafe.md", `${block.replace("MARKER", JSON.stringify(marker))}Unsafe body.`);
      try {
        const result = prebuild();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`Unsupported front matter engine "${label}" in .*unsafe\\.md`));
        assert.equal(existsSync(marker), false);
        assert.deepEqual(["llms.txt", "llms-full.txt"].map((name) => readFileSync(join(site, "static", name), "utf8")), published);
        assert.deepEqual(readdirSync(scratch), []);
      } finally {
        rmSync(join(site, "content/docs/unsafe.md"), { force: true });
        rmSync(marker, { force: true });
      }
    });
  }
});
