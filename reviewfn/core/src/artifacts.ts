import { hostname } from "node:os";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { safeDirectory, safeRead, safeWrite } from "./safe-files.js";
import { sha256 } from "./canonical.js";
import { ReviewFnError } from "./errors.js";
import type { ArtifactStore } from "./types.js";

interface ArtifactMetadata { id: string; digest: string; kind: string; createdAt: string; expiresAt: string }

function validateKind(kind: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Unsafe artifact kind ${kind}.`);
}

/** The file names of a set of JSON and Markdown report copies kept under report-copy retention. */
export interface ReportCopyNames { json: string; markdown: string }

/** The 0.1 review report copies (`report.json`, `report.md`); retention metadata in `<artifacts>/.report-copies`. */
export const REVIEW_REPORT_COPY_NAMES: ReportCopyNames = Object.freeze({ json: "report.json", markdown: "report.md" });
/** The panel report copies (`panel-report.json`, `panel-report.md`); retention metadata in `<artifacts>/.panel-report-copies-<directory digest>`. */
export const PANEL_REPORT_COPY_NAMES: ReportCopyNames = Object.freeze({ json: "panel-report.json", markdown: "panel-report.md" });

export class FileArtifactStore implements ArtifactStore {
  private readonly copyNames: readonly [string, string];
  private readonly copiesStem: string;
  private readonly copiesMarkerKeyed: boolean;
  /** Panel copies are replaced as a pair (both or neither); the 0.1 copies keep their copy-by-copy writes. */
  private readonly copiesPaired: boolean;

  /**
   * `reportCopiesDirectory` holds the report copies this store writes and expires; `copyNames` selects which set
   * (0.1 review copies by default). Each set keeps its own retention metadata in the store, named after its JSON copy:
   * `.report-copies` for the 0.1 copies, whose store lives inside their output directory. Any other set's store can be
   * shared by several output directories, so its metadata name also carries a digest of the copies directory's
   * physical path (its realpath, so `/tmp/out` and `/private/tmp/out` on macOS name the same marker), and cleanup for
   * one output directory never drops the retention of another's copies.
   */
  public constructor(private readonly root: string, private readonly reportCopiesDirectory?: string, copyNames: ReportCopyNames = REVIEW_REPORT_COPY_NAMES) {
    for (const name of [copyNames.json, copyNames.markdown]) if (!/^[a-z][a-z0-9-]*\.(json|md)$/.test(name)) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Unsafe report copy name ${name}.`);
    if (!copyNames.json.endsWith(".json") || !copyNames.markdown.endsWith(".md")) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Report copy names must be a .json file and a .md file.");
    this.copyNames = [copyNames.json, copyNames.markdown];
    this.copiesStem = `.${copyNames.json.slice(0, -".json".length)}-copies`;
    const review = copyNames.json === REVIEW_REPORT_COPY_NAMES.json && copyNames.markdown === REVIEW_REPORT_COPY_NAMES.markdown;
    this.copiesMarkerKeyed = !review && Boolean(reportCopiesDirectory);
    this.copiesPaired = !review;
  }

  /**
   * The retention metadata name of this store's report copies, or undefined when the copies directory does not exist
   * (cleanup then has no copies to expire). A keyed name hashes the directory's realpath, after `safeDirectory` has
   * refused symlinked components other than the root-owned macOS aliases, so every spelling of one directory agrees.
   * A keyed marker also records that realpath, so cleanup can drop the marker of a directory that no longer exists.
   */
  private async copiesMarker(): Promise<{ name: string; directory?: string } | undefined> {
    if (!this.copiesMarkerKeyed) return { name: this.copiesStem };
    const physical = await realpath(this.reportCopiesDirectory!).catch((error: NodeJS.ErrnoException) => missing(error) ? undefined : Promise.reject(error));
    return physical === undefined ? undefined : { name: this.keyedMarker(physical), directory: physical };
  }

  private keyedMarker(physical: string): string { return `${this.copiesStem}-${sha256(physical).slice(0, 16)}`; }

  /** Report-copy writes; tests override this to inject a failure between the two copies. */
  protected async writeCopyFile(file: string, content: string): Promise<void> { await safeWrite(file, content); }

  public put(kind: string, content: string | Uint8Array, retentionDays: number) { return this.withLease(() => this.putUnlocked(kind, content, retentionDays)); }
  public importFrom(sourceRoot: string) { return this.withLease(() => this.importUnlocked(sourceRoot)); }
  public writeReportCopies(json: string, markdown: string, retentionDays: number) { return this.withLease(() => this.writeCopiesUnlocked(json, markdown, retentionDays)); }
  public deleteExpired(now = new Date()) { return this.withLease(() => this.deleteExpiredUnlocked(now)); }

  private async withLease<T>(action: () => Promise<T>): Promise<T> {
    await this.ensureSafeRoot();
    const file = path.join(this.root, ".retention.lock");
    let handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 99) throw new Error("Artifact store is busy; retry or clean a confirmed abandoned .retention.lock.");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { await handle!.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() })); return await action(); } finally { await handle!.close(); await rm(file); }
  }

  private async putUnlocked(kind: string, content: string | Uint8Array, retentionDays: number): Promise<{ digest: string; id: string }> {
    validateKind(kind);
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "retentionDays must be a positive integer.");
    await this.ensureSafeRoot();
    const bytes = Buffer.from(content);
    if (bytes.length > 32 * 1024 * 1024) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Artifact exceeds the 32 MiB read/write budget.");
    const digest = sha256(bytes);
    const id = `${kind}-${digest}`;
    const dataPath = path.join(this.root, `${id}.artifact`);
    const metadataPath = path.join(this.root, `${id}.json`);
    const createdAt = new Date();
    const metadata: ArtifactMetadata = { id, digest, kind, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString() };
    await writeExclusiveOrVerify(dataPath, bytes, digest);
    await this.mergeMetadata(metadataPath, metadata);
    return { digest, id };
  }

  /** Import immutable data while merging its original expiration, not resetting it. */
  private async importUnlocked(sourceRoot: string): Promise<void> {
    await this.ensureSafeRoot();
    for (const entry of await readdir(sourceRoot)) {
      if (!entry.endsWith(".json")) continue;
      const metadata = JSON.parse((await safeRead(path.join(sourceRoot, entry))).toString("utf8")) as ArtifactMetadata;
      validateMetadata(metadata, entry);
      const bytes = await safeRead(path.join(sourceRoot, `${metadata.id}.artifact`));
      if (sha256(bytes) !== metadata.digest) throw new Error("Imported artifact digest mismatch.");
      await writeExclusiveOrVerify(path.join(this.root, `${metadata.id}.artifact`), bytes, metadata.digest);
      await this.mergeMetadata(path.join(this.root, entry), metadata);
    }
  }

  private async writeCopiesUnlocked(json: string, markdown: string, retentionDays: number): Promise<void> {
    if (!this.reportCopiesDirectory || !Number.isInteger(retentionDays) || retentionDays <= 0) throw new Error("Report-copy directory and positive retention are required.");
    await this.ensureSafeRoot();
    await safeDirectory(this.reportCopiesDirectory);
    const markerName = await this.copiesMarker();
    if (!markerName) throw new Error("Report-copy directory disappeared before the copies were written.");
    const marker = path.join(this.root, markerName.name);
    const previousRaw = await safeRead(marker).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    const previous = previousRaw ? parseReportCopies(previousRaw, this.copyNames) : {};
    const metadata: ReportCopies = {};
    const [jsonName, markdownName] = this.copyNames;
    const currentCopies = new Map<string, Buffer | undefined>();
    for (const [name, content] of [[jsonName, json], [markdownName, markdown]]) {
      const current = await safeRead(path.join(this.reportCopiesDirectory, name)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      currentCopies.set(name, current);
      const prior = (previous[name] ?? []).filter(reference => current && reference.digest === sha256(current));
      const next = { digest: sha256(content), expiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString() };
      // Keep the current and proposed bytes covered before either copy changes.
      const references = new Map(prior.map(reference => [reference.digest, reference]));
      if (!references.has(next.digest) || Date.parse(references.get(next.digest)!.expiresAt) < Date.parse(next.expiresAt)) references.set(next.digest, next);
      metadata[name] = [...references.values()];
    }
    await safeWrite(marker, JSON.stringify(markerName.directory === undefined ? metadata : { ...metadata, directory: markerName.directory }));
    if (!this.copiesPaired) {
      await safeWrite(path.join(this.reportCopiesDirectory, jsonName), json);
      await safeWrite(path.join(this.reportCopiesDirectory, markdownName), markdown);
      return;
    }
    await this.replaceCopyPair(json, markdown, currentCopies.get(markdownName), async () => { if (previousRaw) await safeWrite(marker, previousRaw); else await rm(marker, { force: true }); });
  }

  /**
   * Stage both copies, then move the Markdown and finally the JSON into place. On any failure the staged files are
   * removed, a replaced Markdown copy is rewritten from `previousMarkdown` (or removed when there was none), and
   * `restoreMarker` drops this write's retention entries, so the directory keeps the previous pair (or none) and never
   * a copy of this write.
   */
  private async replaceCopyPair(json: string, markdown: string, previousMarkdown: Buffer | undefined, restoreMarker: () => Promise<void>): Promise<void> {
    const directory = this.reportCopiesDirectory!;
    const [jsonFile, markdownFile] = this.copyNames.map(name => path.join(directory, name));
    const stamp = randomUUID();
    const [stagedJson, stagedMarkdown] = ["json", "md"].map(suffix => path.join(directory, `.reviewfn-copy-${stamp}.${suffix}`));
    try {
      await this.writeCopyFile(stagedJson, json);
      await this.writeCopyFile(stagedMarkdown, markdown);
      await rename(stagedMarkdown, markdownFile);
      try { await rename(stagedJson, jsonFile); }
      catch (error) {
        await (previousMarkdown === undefined ? rm(markdownFile, { force: true }) : safeWrite(markdownFile, previousMarkdown));
        throw error;
      }
    } catch (error) {
      await restoreMarker();
      throw error;
    } finally {
      await Promise.all([stagedJson, stagedMarkdown].map(file => rm(file, { force: true })));
    }
  }

  private async mergeMetadata(file: string, metadata: ArtifactMetadata): Promise<void> {
    const existing = await safeRead(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing) {
      const previous = JSON.parse(existing.toString("utf8")) as ArtifactMetadata;
      validateMetadata(previous, path.basename(file));
      if (Date.parse(previous.expiresAt) > Date.parse(metadata.expiresAt)) metadata = previous;
    }
    await safeWrite(file, JSON.stringify(metadata, null, 2));
  }

  public async get(id: string): Promise<Uint8Array | undefined> {
    if (!/^[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}$/.test(id)) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Unsafe artifact id ${id}.`);
    return safeRead(path.join(this.root, `${id}.artifact`)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  }

  private async deleteExpiredUnlocked(now = new Date()): Promise<{ deleted: string[]; errors: string[] }> {
    await this.ensureSafeRoot();
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const entry of await readdir(this.root)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse((await safeRead(path.join(this.root, entry))).toString("utf8")) as ArtifactMetadata;
        validateMetadata(metadata, entry);
        if (Date.parse(metadata.expiresAt) > now.getTime()) continue;
        const artifactPath = path.join(this.root, `${metadata.id}.artifact`);
        if ((await lstat(artifactPath).catch(() => undefined))?.isSymbolicLink()) throw new Error("refusing symlinked artifact");
        await rm(artifactPath, { force: true });
        await rm(path.join(this.root, entry));
        deleted.push(metadata.id);
      } catch (error) {
        errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A crashed put can leave data before its metadata commit; the store lease
    // excludes active writers while these content-addressed orphans are removed.
    for (const entry of await readdir(this.root)) {
      if (!/^[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}\.artifact$/.test(entry)) continue;
      try {
        const id = entry.slice(0, -".artifact".length);
        const metadata = await lstat(path.join(this.root, `${id}.json`)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (metadata) continue;
        const file = path.join(this.root, entry);
        if (!(await lstat(file)).isFile()) throw new Error("Refusing non-regular orphan artifact.");
        await rm(file);
        deleted.push(id);
      } catch (error) { errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.reportCopiesDirectory) {
      try {
        const markerName = (await this.copiesMarker())?.name;
        const raw = markerName === undefined ? undefined : await safeRead(path.join(this.root, markerName)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (raw) {
          const metadata = parseReportCopies(raw, this.copyNames);
          let remaining = false;
          const expiredCopies: string[] = [];
          for (const name of this.copyNames) {
            const file = path.join(this.reportCopiesDirectory, name);
            const content = await safeRead(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
            if (!content) continue;
            const references = metadata[name].filter(reference => reference.digest === sha256(content));
            if (!references.length) throw new Error("Report copy changed; refusing expiry deletion.");
            if (references.some(reference => Date.parse(reference.expiresAt) > now.getTime())) { remaining = true; continue; }
            expiredCopies.push(file);
          }
          // Validate both copies before deleting either when an export changed.
          for (const file of expiredCopies) await rm(file, { force: true });
          if (!remaining) await rm(path.join(this.root, markerName!));
        }
      } catch (error) { errors.push(`Report copies: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.copiesMarkerKeyed) await this.deleteOrphanedMarkers(errors);
    return { deleted, errors };
  }

  /**
   * Drop the keyed markers whose recorded output directory no longer exists: no copies are left to expire there. Only
   * the marker inside the store is removed, and only when its name matches the digest of the directory it records. A
   * marker that cannot be read, or whose directory cannot be checked, is left for that directory's own cleanup.
   */
  private async deleteOrphanedMarkers(errors: string[]): Promise<void> {
    for (const entry of await readdir(this.root)) {
      if (!entry.startsWith(`${this.copiesStem}-`) || !/-[a-f0-9]{16}$/.test(entry)) continue;
      const directory = await safeRead(path.join(this.root, entry)).then(raw => (JSON.parse(raw.toString("utf8")) as { directory?: unknown }).directory, () => undefined);
      if (typeof directory !== "string" || !path.isAbsolute(directory) || this.keyedMarker(directory) !== entry) continue;
      if (!await realpath(directory).then(() => false, (error: NodeJS.ErrnoException) => missing(error))) continue;
      await rm(path.join(this.root, entry)).catch((error: unknown) => { errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`); });
    }
  }

  private async ensureSafeRoot(): Promise<void> {
    await safeDirectory(this.root);
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Artifact root must be a real directory.");
  }
}

async function writeExclusiveOrVerify(file: string, bytes: Uint8Array, digest: string): Promise<void> {
  try {
    const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await safeRead(file);
    if (sha256(existing) !== digest) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Existing content-addressed artifact has unexpected bytes.");
  }
}

function validateMetadata(metadata: ArtifactMetadata, entry: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}$/.test(metadata.id) || entry !== `${metadata.id}.json` || metadata.id !== `${metadata.kind}-${metadata.digest}` || !Number.isFinite(Date.parse(metadata.expiresAt))) throw new Error("Invalid artifact metadata identity or expiry.");
}

function missing(error: NodeJS.ErrnoException): boolean { return error.code === "ENOENT" || error.code === "ENOTDIR"; }

type ReportCopies = Record<string, { digest: string; expiresAt: string }[]>;
function parseReportCopies(raw: Buffer, names: readonly string[]): ReportCopies {
  const value = JSON.parse(raw.toString("utf8")) as ReportCopies;
  for (const name of names) {
    if (!Array.isArray(value?.[name]) || value[name].length < 1 || value[name].length > 2 || value[name].some(reference => !reference || !/^[a-f0-9]{64}$/.test(reference.digest) || !Number.isFinite(Date.parse(reference.expiresAt)))) throw new Error("Invalid report-copy retention metadata.");
  }
  return value;
}
