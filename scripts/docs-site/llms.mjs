import {
  closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertYamlFrontMatter } from "./front-matter.mjs";

/** Collection directories the filesystem provider resolves, with its defaults when a site sets none. */
const COLLECTION_DIRECTORIES = /** @type {const} */ ([
  ["docs", "docsDir", ["content/docs", "docs"]],
  ["pages", "pagesDir", ["pages"]],
  ["blog", "blogDir", ["blog"]],
  ["api", "apiDir", ["api"]],
  ["assets", "assetsDir", ["public", "assets"]],
]);
const MARKDOWN_COLLECTIONS = new Set(["docs", "pages", "blog"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
/** The published provider hardcodes this control file name in Markdown collections. */
const CONTROL_FILE_NAME = "meta.json";

/** @param {string} path */
function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Relative paths of regular files the provider would list: no dot segments, no symbolic links
 * (fast-glob `dot: false`, `followSymbolicLinks: false`, `onlyFiles: true`).
 * @param {string} directory
 * @param {string} [prefix]
 * @returns {Generator<string>}
 */
function* listProviderFiles(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* listProviderFiles(join(directory, entry.name), relativePath);
    else if (entry.isFile()) yield relativePath;
  }
}

/**
 * Copy one source file's exact bytes into the snapshot, checking Markdown front matter on those bytes.
 * @param {string} source
 * @param {string} target
 * @param {boolean} markdown
 */
function snapshotFile(source, target, markdown) {
  const descriptor = openSync(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`Docs source is no longer a regular file: ${source}`);
    const bytes = readFileSync(descriptor);
    // The provider decodes the same bytes as UTF-8 before handing them to gray-matter.
    if (markdown) assertYamlFrontMatter(bytes.toString("utf8"), source);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    utimesSync(target, stats.atime, stats.mtime);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Keep the configured layout inside the snapshot. A relative directory inside the content root keeps
 * its configured value, so the provider applies the same default-candidate and missing-directory
 * rules. Absolute or escaping directories get a private absolute path, which the provider also treats
 * as explicitly configured.
 * @param {string} root
 * @param {string} snapshotRoot
 * @param {string} collection
 * @param {string | undefined} configured
 * @param {string | undefined} sourceDirectory
 */
function mapSnapshotDirectory(root, snapshotRoot, collection, configured, sourceDirectory) {
  const relativeDirectory = sourceDirectory === undefined ? undefined : relative(root, sourceDirectory);
  const inside = relativeDirectory !== undefined && !isAbsolute(relativeDirectory) &&
    relativeDirectory !== ".." && !relativeDirectory.startsWith(`..${sep}`);
  if (!inside) return { snapshotDirectory: join(snapshotRoot, `external-${collection}`), override: true };
  return { snapshotDirectory: resolve(snapshotRoot, relativeDirectory), override: Boolean(configured && isAbsolute(configured)) };
}

/**
 * Snapshot the Markdown collections into a private directory so the published provider parses
 * exactly the bytes that passed the YAML-only check, never a file it reopens later. API and asset
 * collections are not parsed as front matter and keep their resolved source directories.
 * @param {{ root: string } & Record<string, unknown>} content
 * @returns {{ content: Record<string, string>, dispose: () => void }}
 */
function createCheckedContentSnapshot(content) {
  const root = content.root;
  const snapshotRoot = mkdtempSync(join(tmpdir(), "docs-llms-snapshot-"));
  const dispose = () => rmSync(snapshotRoot, { recursive: true, force: true });
  try {
    /** @type {Record<string, string>} */
    const overrides = { root: snapshotRoot };
    const written = new Set();
    for (const [collection, key, defaults] of COLLECTION_DIRECTORIES) {
      const configured = typeof content[key] === "string" && content[key] ? /** @type {string} */ (content[key]) : undefined;
      const sourceDirectory = configured
        ? resolve(root, configured)
        : defaults.map((candidate) => resolve(root, candidate)).find(isDirectory);
      if (!MARKDOWN_COLLECTIONS.has(collection)) {
        if (sourceDirectory && isDirectory(sourceDirectory)) overrides[key] = sourceDirectory;
        continue;
      }
      const { snapshotDirectory, override } = mapSnapshotDirectory(root, snapshotRoot, collection, configured, sourceDirectory);
      if (override) overrides[key] = snapshotDirectory;
      // A missing directory stays missing in the snapshot, so the provider reports it as before.
      if (!sourceDirectory || !isDirectory(sourceDirectory)) continue;
      mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
      for (const relativePath of listProviderFiles(sourceDirectory)) {
        const name = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
        const markdown = MARKDOWN_EXTENSIONS.has(extname(name));
        if (name !== CONTROL_FILE_NAME && !markdown) continue;
        const target = join(snapshotDirectory, relativePath);
        if (written.has(target)) continue;
        written.add(target);
        snapshotFile(join(sourceDirectory, relativePath), target, markdown);
      }
    }
    return { content: overrides, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * Resolve DocsFn from the consumer site so each site's published package pin is honored.
 * Markdown is read once into a private snapshot, checked YAML-only, and only then parsed.
 * @param {string} cwd
 * @param {{buildManifest: Function, loadDocsConfig: Function, FsContentProvider: new (options: object) => object}} dependencies
 */
export async function loadLlmsSiteSource(cwd, dependencies) {
  const { buildManifest, loadDocsConfig, FsContentProvider } = dependencies;
  const loadedConfig = await loadDocsConfig({ cwd });
  const config = {
    ...loadedConfig,
    content: {
      ...loadedConfig.content,
      root: resolve(cwd, loadedConfig.content.root || "."),
    },
  };
  const snapshot = createCheckedContentSnapshot(config.content);
  try {
    const providerConfig = { ...config, content: { ...config.content, ...snapshot.content } };
    const provider = new FsContentProvider({
      root: providerConfig.content.root,
      docsDir: providerConfig.content.docsDir,
      pagesDir: providerConfig.content.pagesDir,
      blogDir: providerConfig.content.blogDir,
      apiDir: providerConfig.content.apiDir,
      assetsDir: providerConfig.content.assetsDir,
    });
    const manifest = await buildManifest(provider, providerConfig);
    return { config, manifest };
  } finally {
    snapshot.dispose();
  }
}

/** @param {string} cwd
 * @param {Parameters<typeof loadLlmsSiteSource>[1] & { buildLlmsTxtArtifacts: Function }} dependencies
 */
export async function buildLlmsSiteArtifacts(cwd, dependencies, options = {}) {
  const { config, manifest } = await loadLlmsSiteSource(cwd, dependencies);
  const { buildLlmsTxtArtifacts } = dependencies;
  const canonicalUrl = options.canonicalUrl ?? config.site?.canonicalUrl;
  const artifacts = buildLlmsTxtArtifacts(manifest, {
    canonicalUrl,
    includeBlog: false,
  });
  return { artifacts, config, manifest, canonicalUrl };
}

/**
 * Replace one regular artifact in a trusted output directory atomically.
 * This promises per-path visibility, not a two-file transaction or power-loss durability.
 * @param {string} target
 * @param {string} body
 */
function replaceArtifact(target, body) {
  let previous;
  try { previous = lstatSync(target); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (previous && !previous.isFile()) throw new Error(`Artifact target must be a regular file: ${target}`);
  const mode = previous ? previous.mode & 0o777 : undefined;
  const temporary = `${target}.${randomUUID()}.tmp`;
  let descriptor;
  let owned = false;
  try {
    descriptor = openSync(temporary, "wx", mode ?? 0o666);
    owned = true;
    writeFileSync(descriptor, body, "utf8");
    if (mode !== undefined) fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    const failures = [error];
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (closeError) { failures.push(closeError); }
    }
    if (owned) {
      try { unlinkSync(temporary); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, `Artifact replacement failed: ${target}`, { cause: error });
    throw error;
  }
}

/**
 * Keep LLM indexes navigable before a public documentation host is assigned: without a public
 * origin, point generated `/docs/...` page links at their GitHub sources. Sites use the default
 * `<product>/docs/content/docs` layout.
 * @param {string} text
 * @param {import("@docsfn/core").DocsManifest} manifest
 * @param {string} product
 * @param {string | undefined} canonicalUrl
 */
export function withSourceLinks(text, manifest, product, canonicalUrl) {
  if (canonicalUrl) return text;
  const sources = new Map(Object.values(manifest.pages)
    .filter((page) => page.id.startsWith("docs:"))
    .map((page) => [new URL(page.path, "https://docs.invalid").pathname, page.id.slice("docs:".length)]));
  return text.replace(/\]\((\/docs[^\s)]*)\)/g, (match, href) => {
    const url = new URL(href, "https://docs.invalid");
    const source = sources.get(url.pathname);
    if (!source) return match;
    const path = source.split("/").map(encodeURIComponent).join("/");
    return `](https://github.com/21nCo/super-functions/blob/dev/${product}/docs/content/docs/${path}${url.search}${url.hash})`;
  });
}

/**
 * --check compares without modifying tracked artifacts.
 * @param {string} directory
 * @param {{llmsTxt: string, llmsFullTxt: string}} artifacts
 * @param {boolean} check
 */
export function writeLlmsArtifacts(directory, artifacts, check = process.argv.includes("--check")) {
  const files = { "llms.txt": artifacts.llmsTxt, "llms-full.txt": artifacts.llmsFullTxt };
  if (!check) mkdirSync(directory, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const target = resolve(directory, name);
    if (check) {
      let actual;
      try { actual = readFileSync(target, "utf8"); } catch { /* Report missing files as stale. */ }
      if (actual !== body) throw new Error(`${name} is stale; run npm run generate:llms`);
    } else replaceArtifact(target, body);
  }
  console.log(check ? "LLM artifacts are current" : "Updated LLM artifacts");
}
