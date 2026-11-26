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

/** @param {string} root @param {string} path */
function isInside(root, path) {
  const relativePath = relative(root, path);
  return !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

/**
 * Snapshot the Markdown collections the provider will read into a private directory, so it parses
 * exactly the bytes that passed the YAML-only check, never a file it reopens later.
 *
 * The layout is derived from the configuration the provider itself receives (buildManifest's
 * canonical config) and keeps its resolution rules. Relative directories inside the content root keep
 * their configured value and are mirrored under `<snapshot>/root`, so default candidates and
 * missing-directory strictness are unchanged. Absolute or escaping directories, which the provider
 * always treats as strict, get a private absolute path under `<snapshot>/external` (present) or
 * `<snapshot>/missing` (absent). API and asset collections are not parsed as front matter and keep
 * their resolved source directories.
 * @param {string} root
 * @param {Record<string, unknown>} content
 */
function createCheckedContentSnapshot(root, content) {
  const snapshotBase = mkdtempSync(join(tmpdir(), "docs-llms-snapshot-"));
  const snapshotRoot = join(snapshotBase, "root");
  /** Snapshot path prefixes and the source paths they stand for, longest first when mapping. */
  const prefixes = [[snapshotRoot, root]];
  const dispose = () => rmSync(snapshotBase, { recursive: true, force: true });
  try {
    // A missing root stays missing, so the provider reports it as before.
    if (isDirectory(root)) mkdirSync(snapshotRoot, { mode: 0o700 });
    /** @type {Record<string, string>} */
    const overrides = { root: snapshotRoot };
    const written = new Set();
    for (const [collection, key, defaults] of COLLECTION_DIRECTORIES) {
      const configured = typeof content[key] === "string" && content[key] ? /** @type {string} */ (content[key]) : undefined;
      const sourceDirectory = configured !== undefined
        ? resolve(root, configured)
        : defaults.map((candidate) => resolve(root, candidate)).find(isDirectory);
      const exists = sourceDirectory !== undefined && isDirectory(sourceDirectory);
      const mirrored = sourceDirectory !== undefined && isInside(root, sourceDirectory);
      if (!MARKDOWN_COLLECTIONS.has(collection) && exists) {
        overrides[key] = /** @type {string} */ (sourceDirectory);
        continue;
      }
      /** @type {string | undefined} */
      let snapshotDirectory;
      if (configured === undefined || (mirrored && !isAbsolute(configured))) {
        // Unchanged value against the mirrored root: same candidates, same strictness.
        if (sourceDirectory !== undefined) snapshotDirectory = resolve(snapshotRoot, relative(root, sourceDirectory));
      } else if (mirrored) {
        snapshotDirectory = resolve(snapshotRoot, relative(root, sourceDirectory));
        overrides[key] = snapshotDirectory;
      } else {
        snapshotDirectory = join(snapshotBase, exists ? "external" : "missing", collection);
        overrides[key] = snapshotDirectory;
        prefixes.push([snapshotDirectory, /** @type {string} */ (sourceDirectory)]);
      }
      if (!exists || !MARKDOWN_COLLECTIONS.has(collection) || snapshotDirectory === undefined) continue;
      mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
      for (const relativePath of listProviderFiles(/** @type {string} */ (sourceDirectory))) {
        const name = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
        const markdown = MARKDOWN_EXTENSIONS.has(extname(name));
        if (name !== CONTROL_FILE_NAME && !markdown) continue;
        const target = join(snapshotDirectory, relativePath);
        if (written.has(target)) continue;
        written.add(target);
        snapshotFile(join(/** @type {string} */ (sourceDirectory), relativePath), target, markdown);
      }
    }
    prefixes.sort((left, right) => right[0].length - left[0].length);
    /** @param {string} path */
    const toSourcePath = (path) => {
      for (const [snapshotPath, sourcePath] of prefixes) {
        if (path === snapshotPath) return sourcePath;
        if (path.startsWith(`${snapshotPath}${sep}`)) return join(sourcePath, path.slice(snapshotPath.length + 1));
      }
      return path;
    };
    /** @param {string} text */
    const toSourceText = (text) => prefixes.reduce((result, [snapshotPath, sourcePath]) => result.replaceAll(snapshotPath, sourcePath), text);
    return { content: overrides, dispose, toSourcePath, toSourceText };
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * Present provider results and errors with the source paths the snapshot stands for, so path-based
 * trust rules (DOCSFN_HTML_UNSAFE_ALLOWLIST) and diagnostics keep pointing at the real files.
 * @param {unknown} error
 * @param {{ toSourcePath: (path: string) => string, toSourceText: (text: string) => string }} snapshot
 */
function mapSnapshotError(error, snapshot) {
  if (!error || typeof error !== "object") return error;
  const value = /** @type {{ message?: unknown, diagnostics?: unknown }} */ (error);
  if (typeof value.message === "string") value.message = snapshot.toSourceText(value.message);
  if (Array.isArray(value.diagnostics)) {
    for (const diagnostic of value.diagnostics) {
      if (typeof diagnostic?.message === "string") diagnostic.message = snapshot.toSourceText(diagnostic.message);
      const location = diagnostic?.location;
      if (location && typeof location.absolutePath === "string") location.absolutePath = snapshot.toSourcePath(location.absolutePath);
    }
  }
  return error;
}

/**
 * Wrap the installed filesystem provider. Each listing snapshots and checks the Markdown it is about
 * to read, lets the provider parse only that snapshot, and removes the snapshot before returning.
 * @param {new (options: object) => { listEntries: Function }} FsContentProvider
 * @param {Record<string, unknown> & { root: string }} options
 */
function createCheckedProvider(FsContentProvider, options) {
  return {
    providerId: "fs",
    /** @param {{ config: { content: Record<string, unknown> & { root?: string } } } & Record<string, unknown>} input */
    async listEntries(input) {
      // The provider prefers config values and falls back to its constructor options.
      /** @type {Record<string, unknown>} */
      const content = { ...options, ...Object.fromEntries(Object.entries(input.config.content).filter(([, value]) => value !== undefined)) };
      const root = resolve(String(input.config.content.root || options.root));
      const snapshot = createCheckedContentSnapshot(root, content);
      try {
        const provider = new FsContentProvider({ root: snapshot.content.root });
        const entries = await provider.listEntries({
          ...input,
          config: { ...input.config, content: { ...content, ...snapshot.content } },
        });
        return entries.map((/** @type {{ absolutePath?: unknown }} */ entry) => typeof entry.absolutePath === "string"
          ? { ...entry, absolutePath: snapshot.toSourcePath(entry.absolutePath) }
          : entry);
      } catch (error) {
        throw mapSnapshotError(error, snapshot);
      } finally {
        snapshot.dispose();
      }
    },
    /** @param {{ entry: unknown }} input */
    async loadEntry(input) {
      return input.entry;
    },
  };
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
  const provider = createCheckedProvider(/** @type {any} */ (FsContentProvider), {
    root: config.content.root,
    docsDir: config.content.docsDir,
    pagesDir: config.content.pagesDir,
    blogDir: config.content.blogDir,
    apiDir: config.content.apiDir,
    assetsDir: config.content.assetsDir,
  });
  const manifest = await buildManifest(provider, config);
  return { config, manifest };
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
