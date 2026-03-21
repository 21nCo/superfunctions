import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import { readFile, stat } from "node:fs/promises";
import {
  assertValidSourceEntries,
  createDefaultDocsConfig,
  createDiagnostic,
  createDocsError,
  createSourceEntryId,
  normalizeProviderPath,
  toLegacyRawEntries,
  type DocsCollection,
  type DocsConfig,
  type DocsContentProvider,
  type DocsProviderListEntriesInput,
  type DocsProviderLoadAssetResult,
  type DocsProviderLoadEntryInput,
  type DocsProviderWatchInput,
  type DocsProviderWatchSubscription,
  type DocsSourceEntry,
} from "@docsfn/core";
import { buildFsWatchMetadata, createNoopWatchSubscription } from "./watch";

const CONTROL_FILE_NAME = "meta.json";
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const API_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const DEFAULT_COLLECTIONS: DocsCollection[] = [
  "docs",
  "pages",
  "blog",
  "api",
  "assets",
];

export interface FsProviderOptions {
  root: string;
  docsDir?: string;
  pagesDir?: string;
  blogDir?: string;
  apiDir?: string;
  assetsDir?: string;
}

interface CollectionDirectoryResolution {
  collection: DocsCollection;
  absolutePath: string;
}

export class FsContentProvider implements DocsContentProvider {
  readonly providerId = "fs";
  private options: FsProviderOptions;
  private lastCollectionDirectories: Partial<Record<DocsCollection, string>> = {};
  private lastEntries: DocsSourceEntry[] = [];

  constructor(options: FsProviderOptions) {
    this.options = options;
  }

  async listEntries(input: DocsProviderListEntriesInput): Promise<DocsSourceEntry[]> {
    const root = resolve(input.config.content.root || this.options.root);
    await this.ensureDirectoryExists(root, "root", root, true);

    const resolutions = await this.resolveCollectionDirectories({
      config: input.config,
      collections: input.collections,
      root,
    });
    this.lastCollectionDirectories = Object.fromEntries(
      resolutions.map((resolution) => [resolution.collection, resolution.absolutePath])
    );

    const allEntries: DocsSourceEntry[] = [];
    for (const resolution of resolutions) {
      const entries = await this.collectCollectionEntries(
        resolution.collection,
        resolution.absolutePath
      );
      allEntries.push(...entries);
    }

    this.lastEntries = assertValidSourceEntries(allEntries);
    return this.lastEntries;
  }

  async loadEntry(input: DocsProviderLoadEntryInput): Promise<DocsSourceEntry> {
    return input.entry;
  }

  async loadAsset(input: {
    config: DocsConfig;
    relativePath: string;
  }): Promise<DocsProviderLoadAssetResult> {
    const root = resolve(input.config.content.root || this.options.root);
    const resolution = await this.resolveSingleCollectionDirectory({
      collection: "assets",
      root,
      config: input.config,
      required: true,
    });
    if (!resolution) {
      throw this.createEntryInvalidError(
        "configured assets directory is missing",
        root
      );
    }

    const relativePath = normalizeProviderPath(input.relativePath);
    const absolutePath = resolve(resolution.absolutePath, relativePath);
    const fileBuffer = await readFile(absolutePath);
    return {
      relativePath,
      absolutePath,
      bytes: fileBuffer.byteLength,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
    };
  }

  async watch(
    input: DocsProviderWatchInput
  ): Promise<DocsProviderWatchSubscription> {
    const collections = input.collections ?? DEFAULT_COLLECTIONS;
    const entries = await this.listEntries({
      config: input.config,
      collections,
    });
    const metadata = buildFsWatchMetadata({
      root: input.config.content.root,
      collectionDirectories: this.lastCollectionDirectories,
      entries,
    });
    return createNoopWatchSubscription(metadata);
  }

  async list() {
    const config = createDefaultDocsConfig({ cwd: this.options.root });
    const entries = await this.listEntries({
      config: {
        ...config,
        content: {
          ...config.content,
          root: this.options.root,
        },
      },
      collections: DEFAULT_COLLECTIONS,
    });
    return toLegacyRawEntries(entries);
  }

  private async resolveCollectionDirectories(input: {
    config: DocsConfig;
    collections: DocsCollection[];
    root: string;
  }): Promise<CollectionDirectoryResolution[]> {
    const resolutions: CollectionDirectoryResolution[] = [];
    for (const collection of input.collections) {
      const resolution = await this.resolveSingleCollectionDirectory({
        collection,
        root: input.root,
        config: input.config,
        required: collection === "docs",
      });
      if (resolution) {
        resolutions.push(resolution);
      }
    }
    return resolutions;
  }

  private async resolveSingleCollectionDirectory(input: {
    collection: DocsCollection;
    root: string;
    config: DocsConfig;
    required: boolean;
  }): Promise<CollectionDirectoryResolution | null> {
    const explicitDir = this.getExplicitCollectionDirectory(
      input.collection,
      input.config
    );
    if (explicitDir) {
      const absolutePath = resolve(input.root, explicitDir);
      const strict =
        input.collection === "docs" ||
        !this.getDefaultCollectionCandidates(input.collection).includes(explicitDir);
      const exists = await this.ensureDirectoryExists(
        absolutePath,
        `${input.collection}Dir`,
        explicitDir,
        strict
      );
      if (!exists) {
        return null;
      }
      return { collection: input.collection, absolutePath };
    }

    const candidates = this.getDefaultCollectionCandidates(input.collection);
    for (const candidate of candidates) {
      const absolutePath = resolve(input.root, candidate);
      if (await this.directoryExists(absolutePath)) {
        return { collection: input.collection, absolutePath };
      }
    }

    if (input.required) {
      const missing =
        input.collection === "docs" ? "content/docs or docs" : input.collection;
      throw this.createEntryInvalidError(
        `configured ${input.collection}Dir ${missing} does not exist`,
        input.root
      );
    }

    return null;
  }

  private getExplicitCollectionDirectory(
    collection: DocsCollection,
    config: DocsConfig
  ): string | undefined {
    if (collection === "docs") {
      return config.content.docsDir ?? this.options.docsDir;
    }
    if (collection === "pages") {
      return config.content.pagesDir ?? this.options.pagesDir;
    }
    if (collection === "blog") {
      return config.content.blogDir ?? this.options.blogDir;
    }
    if (collection === "api") {
      return config.content.apiDir ?? this.options.apiDir;
    }
    return config.content.assetsDir ?? this.options.assetsDir;
  }

  private getDefaultCollectionCandidates(collection: DocsCollection): string[] {
    if (collection === "docs") {
      return ["content/docs", "docs"];
    }
    if (collection === "pages") {
      return ["pages"];
    }
    if (collection === "blog") {
      return ["blog"];
    }
    if (collection === "api") {
      return ["api"];
    }
    return ["public", "assets"];
  }

  private async ensureDirectoryExists(
    absolutePath: string,
    key: string,
    configuredValue: string,
    strict: boolean
  ): Promise<boolean> {
    const stats = await this.tryStat(absolutePath);
    if (stats?.isDirectory()) {
      return true;
    }

    if (!strict) {
      return false;
    }

    throw this.createEntryInvalidError(
      `configured ${key} ${configuredValue} does not exist`,
      absolutePath
    );
  }

  private async directoryExists(absolutePath: string): Promise<boolean> {
    const stats = await this.tryStat(absolutePath);
    return Boolean(stats?.isDirectory());
  }

  private async tryStat(absolutePath: string) {
    try {
      return await stat(absolutePath);
    } catch {
      return null;
    }
  }

  private async collectCollectionEntries(
    collection: DocsCollection,
    absoluteDirectory: string
  ): Promise<DocsSourceEntry[]> {
    const filePaths = await fg("**/*", {
      cwd: absoluteDirectory,
      absolute: true,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      unique: true,
      suppressErrors: false,
    });

    const normalizedSortedPaths = filePaths.sort((left, right) =>
      normalizeProviderPath(left).localeCompare(normalizeProviderPath(right), "en", {
        sensitivity: "variant",
        numeric: true,
      })
    );

    const entries: DocsSourceEntry[] = [];
    for (const absolutePath of normalizedSortedPaths) {
      const relativePath = normalizeProviderPath(
        absolutePath.slice(absoluteDirectory.length + 1)
      );
      const extension = extname(relativePath).toLowerCase();
      const fileName = basename(relativePath).toLowerCase();

      if (fileName === CONTROL_FILE_NAME) {
        entries.push(await this.createControlEntry(collection, relativePath, absolutePath));
        continue;
      }

      if (collection === "assets") {
        entries.push(await this.createAssetEntry(relativePath, absolutePath));
        continue;
      }

      if (
        (collection === "docs" || collection === "pages" || collection === "blog") &&
        MARKDOWN_EXTENSIONS.has(extension)
      ) {
        entries.push(
          await this.createMarkdownEntry(collection, relativePath, absolutePath)
        );
        continue;
      }

      if (collection === "api" && API_EXTENSIONS.has(extension)) {
        entries.push(await this.createApiEntry(relativePath, absolutePath));
      }
    }

    return entries;
  }

  private async createMarkdownEntry(
    collection: Extract<DocsCollection, "docs" | "pages" | "blog">,
    relativePath: string,
    absolutePath: string
  ): Promise<DocsSourceEntry> {
    const fileBuffer = await readFile(absolutePath);
    const rawText = fileBuffer.toString("utf8");
    const parsed = matter(rawText);
    const fileStats = await stat(absolutePath);
    const derivedTitle = this.deriveTitleFromPath(relativePath);

    return {
      id: createSourceEntryId(collection, relativePath),
      collection,
      relativePath,
      absolutePath,
      entryType: "content",
      body: parsed.content,
      frontmatter: {
        title: derivedTitle,
        ...parsed.data,
      },
      bytes: fileBuffer.byteLength,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
      updatedAt: fileStats.mtime.toISOString(),
      meta: {
        extension: extname(relativePath).toLowerCase(),
      },
    };
  }

  private async createControlEntry(
    collection: DocsCollection,
    relativePath: string,
    absolutePath: string
  ): Promise<DocsSourceEntry> {
    const fileBuffer = await readFile(absolutePath);
    const rawText = fileBuffer.toString("utf8");
    const fileStats = await stat(absolutePath);

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }

    return {
      id: createSourceEntryId(collection, relativePath),
      collection,
      relativePath,
      absolutePath,
      entryType: "control",
      body: rawText,
      frontmatter: {},
      bytes: fileBuffer.byteLength,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
      updatedAt: fileStats.mtime.toISOString(),
      meta: {
        controlFile: true,
        parsed,
      },
    };
  }

  private async createApiEntry(
    relativePath: string,
    absolutePath: string
  ): Promise<DocsSourceEntry> {
    const fileBuffer = await readFile(absolutePath);
    const fileStats = await stat(absolutePath);
    return {
      id: createSourceEntryId("api", relativePath),
      collection: "api",
      relativePath,
      absolutePath,
      entryType: "content",
      body: fileBuffer.toString("utf8"),
      frontmatter: {
        title: this.deriveTitleFromPath(relativePath),
      },
      bytes: fileBuffer.byteLength,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
      updatedAt: fileStats.mtime.toISOString(),
      meta: {
        extension: extname(relativePath).toLowerCase(),
      },
    };
  }

  private async createAssetEntry(
    relativePath: string,
    absolutePath: string
  ): Promise<DocsSourceEntry> {
    const fileBuffer = await readFile(absolutePath);
    const fileStats = await stat(absolutePath);
    return {
      id: createSourceEntryId("assets", relativePath),
      collection: "assets",
      relativePath,
      absolutePath,
      entryType: "asset",
      frontmatter: {},
      bytes: fileBuffer.byteLength,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
      updatedAt: fileStats.mtime.toISOString(),
      meta: {
        extension: extname(relativePath).toLowerCase(),
      },
    };
  }

  private deriveTitleFromPath(relativePath: string): string {
    const fileName = basename(relativePath).replace(/\.[^/.]+$/, "");
    return fileName
      .split(/[-_]/g)
      .map((segment) =>
        segment.length > 0
          ? `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`
          : segment
      )
      .join(" ");
  }

  private createEntryInvalidError(message: string, absolutePath: string) {
    return createDocsError({
      code: "DOCS_ENTRY_INVALID",
      message,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ENTRY_INVALID",
          message,
          location: { absolutePath },
        }),
      ],
    });
  }
}
