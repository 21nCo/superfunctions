import {
  closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import nodePath, { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
/** Provider configuration keys that always point into the snapshot: the root and the Markdown collections. */
const SNAPSHOT_KEYS = new Set(["root", ...COLLECTION_DIRECTORIES.filter(([collection]) => MARKDOWN_COLLECTIONS.has(collection)).map(([, key]) => key)]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
/** The published provider hardcodes this control file name in Markdown collections. */
const CONTROL_FILE_NAME = "meta.json";
/** Every staging tree this prebuild creates is a temp directory with this name prefix. */
const STAGING_PREFIX = "docs-llms-snapshot-";

/**
 * The provider lists Markdown with fast-glob, which returns every absolute path in forward-slash form.
 * On POSIX a backslash is an ordinary file name character, so a directory whose path contains one would
 * be listed as a different (sibling) path. Windows separators are expected to be rewritten.
 * @param {string} path
 */
function hasGlobRewrittenCharacter(path) {
  return sep === "/" && path.includes("\\");
}

/** @param {string} path */
function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Relative paths of regular files the provider would list: no dot segments, no symbolic links
 * (fast-glob `dot: false`, `followSymbolicLinks: false`, `onlyFiles: true`). A staging tree of this
 * prebuild (left by an interrupted build or staged by another one) fails closed instead of being
 * listed as content. So does any entry name the provider's fast-glob listing would rewrite (on POSIX,
 * one containing a backslash, which it turns into a separator and can resolve outside the directory).
 * @param {string} directory real path of the directory to list
 * @param {{ key: string, sourceDirectory: string }} owner collection being listed, for the error
 * @param {string} [prefix]
 * @returns {Generator<string>}
 */
function* listProviderFiles(directory, owner, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (hasGlobRewrittenCharacter(entry.name)) {
      throw new Error(`The docs ${owner.key} ${owner.sourceDirectory} contains ${join(owner.sourceDirectory, relativePath)}, whose name has a backslash the docs provider's file listing rewrites to a path separator; rename it`);
    }
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(STAGING_PREFIX)) {
        throw new Error(`The docs ${owner.key} ${owner.sourceDirectory} contains the LLM prebuild staging tree ${join(owner.sourceDirectory, relativePath)} from an interrupted or concurrent build; remove it and keep TMPDIR (TEMP or TMP on Windows) outside the docs content`);
      }
      yield* listProviderFiles(join(directory, entry.name), owner, relativePath);
    } else if (entry.isFile()) yield relativePath;
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
 * Map snapshot paths back to the source paths they stand for. The provider reports paths in two
 * forms: native ones (path.resolve) and fast-glob ones, which use forward slashes on Windows too.
 * Each mapped path keeps the form it arrived in, so it matches what the provider would have reported
 * without the snapshot.
 * @param {Array<[string, string]>} prefixes snapshot directory and source directory pairs
 * @param {Pick<typeof nodePath, "join" | "sep">} [pathApi]
 * @param {Array<[string, string]>} [aliases] exact message fragments restored before path mapping
 */
export function createSnapshotPathMapper(prefixes, pathApi = nodePath, aliases = []) {
  const windows = pathApi.sep === "\\";
  /** @param {string} path */
  const toSlash = (path) => (windows ? path.replaceAll("\\", "/") : path);
  /** Literal replacement: `$&`-style patterns in paths must not expand. @param {string} text @param {string} from @param {string} to */
  const replaceLiteral = (text, from, to) => text.replaceAll(from, () => to);
  const sorted = prefixes
    .map(([snapshotPath, sourcePath]) => /** @type {const} */ ([toSlash(snapshotPath), sourcePath]))
    .sort((left, right) => right[0].length - left[0].length);
  /** @param {string} path */
  const toSourcePath = (path) => {
    const candidate = toSlash(path);
    for (const [snapshotPath, sourcePath] of sorted) {
      if (candidate !== snapshotPath && !candidate.startsWith(`${snapshotPath}/`)) continue;
      const rest = candidate.slice(snapshotPath.length + 1);
      if (windows && !path.includes("\\")) return rest ? `${toSlash(sourcePath)}/${rest}` : toSlash(sourcePath);
      return rest ? pathApi.join(sourcePath, rest) : sourcePath;
    }
    return path;
  };
  /** @param {string} text */
  const toSourceText = (text) => sorted.reduce((result, [snapshotPath, sourcePath]) => {
    const native = windows ? snapshotPath.replaceAll("/", "\\") : snapshotPath;
    const replaced = replaceLiteral(result, native, sourcePath);
    return windows ? replaceLiteral(replaced, snapshotPath, toSlash(sourcePath)) : replaced;
  }, aliases.reduce((result, [snapshotText, sourceText]) => replaceLiteral(result, snapshotText, sourceText), text));
  return { toSourcePath, toSourceText };
}

/**
 * Resolve each collection directory the way the provider does from the configuration it receives:
 * a configured value against the content root, otherwise the first existing default candidate.
 * @param {string} root
 * @param {Record<string, unknown>} content
 */
function resolveCollections(root, content) {
  return COLLECTION_DIRECTORIES.flatMap(([collection, key, defaults]) => {
    const configured = typeof content[key] === "string" && content[key] ? /** @type {string} */ (content[key]) : undefined;
    const sourceDirectory = configured !== undefined
      ? resolve(root, configured)
      : defaults.map((candidate) => resolve(root, candidate)).find(isDirectory);
    // Unconfigured with no default present: the provider skips it (or reports a missing docs dir).
    if (sourceDirectory === undefined) return [];
    return [{ collection, key, configured, defaults: /** @type {readonly string[]} */ (defaults), sourceDirectory, exists: isDirectory(sourceDirectory) }];
  });
}

/**
 * Fail closed when the staging parent lies inside a directory the provider enumerates: a staging tree
 * there (this run's or a concurrent build's) would be listed as content.
 * @param {ReturnType<typeof resolveCollections>} collections
 * @param {string} stagingParent canonical absolute directory the snapshot is created in
 */
function assertStagingOutsideCollections(collections, stagingParent) {
  for (const { key, sourceDirectory, exists } of collections) {
    if (exists && isInside(realpathSync.native(sourceDirectory), stagingParent)) {
      throw new Error(`The temporary directory ${tmpdir()} is inside the docs ${key} ${sourceDirectory}; set TMPDIR (TEMP or TMP on Windows) to a directory outside the docs content`);
    }
  }
}

/**
 * Snapshot the Markdown collections the provider will read into a private directory, so it parses
 * exactly the bytes that passed the YAML-only check, never a file it reopens later.
 *
 * The layout follows the configuration the provider itself receives (buildManifest's canonical
 * config). Each present Markdown collection is copied from its own source directory alone into its
 * own tree `<snapshot>/collections/<collection>`, handed to the provider as an absolute directory, so
 * what one collection lists never depends on a sibling. The snapshot content root `<snapshot>/root`
 * stays empty: unconfigured or default-candidate collections that are missing in the source are
 * missing there too, with the same optional or required behaviour. Any other missing configured
 * directory becomes the absolute `<snapshot>/missing/<collection>`, which the provider rejects as
 * strictly as the original value. API and asset collections are not parsed as front matter and keep
 * their source directories.
 * @param {string} root
 * @param {Record<string, unknown>} content
 */
function createCheckedContentSnapshot(root, content) {
  const collections = isDirectory(root) ? resolveCollections(root, content) : [];
  // One canonical absolute staging parent for both the containment check and the allocation: a
  // relative TMPDIR, or one that reaches outside through a symbolic link and "..", cannot make the
  // snapshot land somewhere the check did not look, or be resolved by the provider against its root.
  const stagingParent = realpathSync.native(tmpdir());
  if (hasGlobRewrittenCharacter(stagingParent)) {
    throw new Error(`The temporary directory ${tmpdir()} resolves to ${stagingParent}, which contains a backslash the docs provider's file listing rewrites to a path separator; set TMPDIR to a directory without one`);
  }
  assertStagingOutsideCollections(collections, stagingParent);
  const snapshotBase = mkdtempSync(join(stagingParent, STAGING_PREFIX));
  const snapshotRoot = join(snapshotBase, "root");
  /** @type {Array<[string, string]>} */
  const prefixes = [[snapshotRoot, root]];
  /** Provider messages quote the configured value; restore it where the snapshot replaced it. */
  /** @type {Array<[string, string]>} */
  const aliases = [];
  /** @type {Record<string, string>} */
  const overrides = { root: snapshotRoot };
  /** Resolved snapshot paths of every Markdown and control file copied (and checked) for the provider. */
  /** @type {Set<string>} */
  const files = new Set();
  const dispose = () => rmSync(snapshotBase, { recursive: true, force: true });
  const mapper = () => createSnapshotPathMapper(prefixes, nodePath, aliases);
  try {
    // A missing root stays missing, so the provider reports it as before.
    if (isDirectory(root)) mkdirSync(snapshotRoot, { mode: 0o700 });
    for (const { collection, key, configured, defaults, sourceDirectory, exists } of collections) {
      const markdown = MARKDOWN_COLLECTIONS.has(collection);
      if (exists && !markdown) {
        // Read live by the provider: it must not contain a staging tree either.
        Array.from(listProviderFiles(realpathSync(sourceDirectory), { key, sourceDirectory }));
        overrides[key] = sourceDirectory;
        continue;
      }
      if (!exists) {
        // A default candidate resolves into the empty snapshot root: missing there too, same strictness.
        if (configured === undefined || defaults.includes(configured)) continue;
        const missing = join(snapshotBase, "missing", collection);
        overrides[key] = missing;
        prefixes.push([missing, sourceDirectory]);
        aliases.push([`configured ${key} ${missing} `, `configured ${key} ${configured} `]);
        continue;
      }
      const snapshotDirectory = join(snapshotBase, "collections", collection);
      overrides[key] = snapshotDirectory;
      prefixes.push([snapshotDirectory, sourceDirectory]);
      mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
      for (const relativePath of listProviderFiles(realpathSync(sourceDirectory), { key, sourceDirectory })) {
        const name = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
        const isMarkdown = MARKDOWN_EXTENSIONS.has(extname(name));
        if (name !== CONTROL_FILE_NAME && !isMarkdown) continue;
        const target = join(snapshotDirectory, relativePath);
        snapshotFile(join(sourceDirectory, relativePath), target, isMarkdown);
        files.add(resolve(target));
      }
    }
    if (!isDirectory(root)) {
      // No collection is resolved under a missing root, so no configured Markdown directory may reach
      // the provider as the live source value: each becomes a missing directory inside the snapshot,
      // and the provider still reports its own missing-root error.
      for (const [collection, key] of COLLECTION_DIRECTORIES) {
        if (!MARKDOWN_COLLECTIONS.has(collection) || typeof content[key] !== "string" || !content[key]) continue;
        const configured = /** @type {string} */ (content[key]);
        const missing = join(snapshotBase, "missing", collection);
        overrides[key] = missing;
        prefixes.push([missing, resolve(root, configured)]);
        aliases.push([`configured ${key} ${missing} `, `configured ${key} ${configured} `]);
      }
    }
    return { content: overrides, base: snapshotBase, files, dispose, ...mapper() };
  } catch (error) {
    dispose();
    throw mapSnapshotError(error, mapper());
  }
}

/**
 * Check the final content configuration the provider receives: the root and every Markdown collection
 * directory (configured or left to the provider's defaults) must resolve inside this run's staging
 * tree, so the provider can only parse checked snapshot bytes, and on POSIX none may contain a backslash
 * (the provider's fast-glob listing would rewrite it to a separator and read another path). Fails closed
 * on anything else.
 * @param {Record<string, unknown>} content
 * @param {string} snapshotBase
 */
export function assertProviderContentInsideSnapshot(content, snapshotBase) {
  const { root } = content;
  if (typeof root !== "string" || !isAbsolute(root) || !isInside(snapshotBase, root)) {
    throw new Error(`Docs snapshot root ${String(root)} is outside its staging tree ${snapshotBase}`);
  }
  if (hasGlobRewrittenCharacter(root)) {
    throw new Error(`Docs snapshot root ${root} contains a backslash the provider's file listing would rewrite`);
  }
  for (const key of SNAPSHOT_KEYS) {
    if (key === "root" || content[key] === undefined) continue;
    const value = content[key];
    if (typeof value !== "string" || !isInside(snapshotBase, resolve(root, value))) {
      throw new Error(`Docs snapshot ${key} ${String(value)} is outside its staging tree ${snapshotBase}`);
    }
    if (hasGlobRewrittenCharacter(resolve(root, value))) {
      throw new Error(`Docs snapshot ${key} ${value} contains a backslash the provider's file listing would rewrite`);
    }
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
 * Defence in depth: every docs, pages or blog entry the provider returns must come from a file this
 * run copied into the snapshot and checked, never from a path the provider resolved elsewhere.
 * @param {unknown[]} entries
 * @param {{ files: Set<string>, toSourcePath: (path: string) => string }} snapshot
 */
export function assertEntriesFromSnapshot(entries, snapshot) {
  for (const entry of entries) {
    const { collection, absolutePath } = /** @type {{ collection?: unknown, absolutePath?: unknown }} */ (entry ?? {});
    if (typeof collection !== "string" || !MARKDOWN_COLLECTIONS.has(collection)) continue;
    if (typeof absolutePath !== "string" || !snapshot.files.has(resolve(absolutePath))) {
      const path = typeof absolutePath === "string" ? snapshot.toSourcePath(resolve(absolutePath)) : String(absolutePath);
      throw new Error(`The docs provider returned the ${collection} entry ${path}, which is not a checked snapshot file`);
    }
  }
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
        const providerContent = { ...content, ...snapshot.content };
        assertProviderContentInsideSnapshot(providerContent, snapshot.base);
        const provider = new FsContentProvider({ root: snapshot.content.root });
        const entries = await provider.listEntries({ ...input, config: { ...input.config, content: providerContent } });
        assertEntriesFromSnapshot(entries, snapshot);
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
