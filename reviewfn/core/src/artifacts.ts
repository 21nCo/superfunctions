import { hostname } from "node:os";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm, stat as statPath } from "node:fs/promises";
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
/**
 * The panel report copies (`panel-report.json`, `panel-report.md`); retention metadata in `<output>/.panel-report-copies`,
 * next to the copies, and every write and cleanup of them serialized by `<output>/.panel-report.lock`.
 */
export const PANEL_REPORT_COPY_NAMES: ReportCopyNames = Object.freeze({ json: "panel-report.json", markdown: "panel-report.md" });

export class FileArtifactStore implements ArtifactStore {
  private readonly copyNames: readonly [string, string];
  private readonly copiesStem: string;
  /**
   * Panel copies are staged and replaced as a pair under the output directory's lock, and a failed write restores the
   * previous pair and retention record. The 0.1 copies keep their copy-by-copy writes and their record in the store.
   */
  private readonly copiesPaired: boolean;
  private readonly lockName: string;
  /** The staged-copy prefix of this copy set, `.reviewfn-copy.<stem>.`: a set's lock covers only its own staged copies. */
  private readonly stagedPrefix: string;

  /**
   * `reportCopiesDirectory` holds the report copies this store writes and expires; `copyNames` selects which set
   * (0.1 review copies by default). Each set keeps its own retention record, named after its JSON copy: `.report-copies`
   * in the store for the 0.1 copies, whose store lives inside their output directory. Any other set's record lives in
   * the copies directory itself, so it always describes the copies there, whichever artifact store (another repository,
   * a copied checkout, another spelling of the same path) wrote them, and a deleted directory takes its record with it.
   */
  public constructor(private readonly root: string, private readonly reportCopiesDirectory?: string, copyNames: ReportCopyNames = REVIEW_REPORT_COPY_NAMES) {
    for (const name of [copyNames.json, copyNames.markdown]) if (!/^[a-z][a-z0-9-]*\.(json|md)$/.test(name)) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Unsafe report copy name ${name}.`);
    if (!copyNames.json.endsWith(".json") || !copyNames.markdown.endsWith(".md")) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Report copy names must be a .json file and a .md file.");
    this.copyNames = [copyNames.json, copyNames.markdown];
    const stem = copyNames.json.slice(0, -".json".length);
    this.copiesStem = `.${stem}-copies`;
    this.lockName = `.${stem}.lock`;
    this.stagedPrefix = `.reviewfn-copy.${stem}.`;
    this.copiesPaired = !(copyNames.json === REVIEW_REPORT_COPY_NAMES.json && copyNames.markdown === REVIEW_REPORT_COPY_NAMES.markdown);
  }

  /** The retention record of this store's report copies. */
  private copiesRecord(): string { return path.join(this.copiesPaired ? this.reportCopiesDirectory! : this.root, this.copiesStem); }

  /**
   * The wait between attempts to take a copies directory's lock, ended early when `signal` aborts; tests override it to
   * observe or skip the wait.
   */
  protected async outputLockRetry(signal?: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 50);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Wait, as long as a write would, while the copies directory's lock is held, without taking it or writing anything,
   * so a command can refuse a directory whose lock a killed run left behind before it does any work: a lock still held
   * fails with REVIEWFN_OUTPUT_DIRECTORY_BUSY, a symlinked or non-regular one, or a copies directory that is the artifact
   * root, with REVIEWFN_ARTIFACT_UNSAFE. Aborting `signal` ends the wait with REVIEWFN_CANCELED. Writes and cleanup still
   * take the lock themselves.
   */
  public async checkReportCopiesLock(signal?: AbortSignal): Promise<void> {
    if (!this.copiesPaired || !this.reportCopiesDirectory) return;
    await this.refuseCopiesInRoot();
    const file = path.join(this.reportCopiesDirectory, this.lockName);
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new ReviewFnError("REVIEWFN_CANCELED", `Canceled while waiting for the report-copy lock ${file}.`, { lock: file });
      const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => missing(error) ? undefined : Promise.reject(error));
      if (!stat) return;
      this.refuseLock(file, stat, attempt);
      await this.outputLockRetry(signal);
    }
  }

  /**
   * Refuse a panel copies directory that is the artifact root itself, by path or through another spelling of it: the
   * root holds the store's lease and artifact metadata, so the copies, their lock and their record must live elsewhere.
   */
  private async refuseCopiesInRoot(): Promise<void> {
    const directory = this.reportCopiesDirectory!;
    const [root, copies] = await Promise.all([this.root, directory].map(item => statPath(item).catch((error: NodeJS.ErrnoException) => missing(error) ? undefined : Promise.reject(error))));
    const same = path.resolve(directory) === path.resolve(this.root) || (root !== undefined && copies !== undefined && root.dev === copies.dev && root.ino === copies.ino);
    if (same) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `The report copies directory ${directory} is the artifacts directory; write the copies to another directory.`, { directory, artifacts: this.root });
  }

  /** Refuse a symlinked or non-regular lock, and a lock still held at the last of the bounded attempts. */
  private refuseLock(file: string, stat: { isFile(): boolean }, attempt: number): void {
    if (!stat.isFile()) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Refusing a symlinked or non-regular report-copy lock ${file}.`);
    const directory = path.dirname(file);
    if (attempt >= 100) throw new ReviewFnError("REVIEWFN_OUTPUT_DIRECTORY_BUSY", `${directory} is locked by another ReviewFn run; retry, or delete ${file} once no ReviewFn run writes to the directory.`, { directory, lock: file });
  }

  /**
   * Run `action` holding `<output>/.panel-report.lock`, the one lock that serializes every write, rollback and cleanup
   * of a panel copies directory, whichever artifact store makes it. It is taken inside the store's lease (root, then
   * output, so two stores never wait on each other in opposite orders), created exclusively and never followed. A
   * symlinked or non-regular lock, and a copies directory that is the artifact root (whose lease would share the lock's
   * namespace), are refused; a lock still held after the bounded wait fails with REVIEWFN_OUTPUT_DIRECTORY_BUSY, naming
   * the file to remove once no ReviewFn run writes to the directory.
   */
  private async withOutputLock<T>(action: () => Promise<T>): Promise<T> {
    const directory = this.reportCopiesDirectory!;
    await safeDirectory(directory);
    await this.refuseCopiesInRoot();
    const file = path.join(directory, this.lockName);
    let handle;
    for (let attempt = 1; !handle; attempt++) {
      try { handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(file).catch((failure: NodeJS.ErrnoException) => missing(failure) ? undefined : Promise.reject(failure));
        if (stat) this.refuseLock(file, stat, attempt);
        await this.outputLockRetry();
      }
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() })); return await action(); }
    finally { await handle.close().catch(() => undefined); await rm(file, { force: true }); }
  }

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
    const [jsonName, markdownName] = this.copyNames;
    if (!this.copiesPaired) {
      await this.recordCopies(json, markdown, retentionDays);
      await safeWrite(path.join(this.reportCopiesDirectory, jsonName), json);
      await safeWrite(path.join(this.reportCopiesDirectory, markdownName), markdown);
      return;
    }
    await this.withOutputLock(async () => {
      const { previousRaw, currentCopies } = await this.recordCopies(json, markdown, retentionDays);
      const record = this.copiesRecord();
      await this.replaceCopyPair(json, markdown, currentCopies.get(markdownName), () => previousRaw ? safeWrite(record, previousRaw) : rm(record, { force: true }));
    });
  }

  /** Cover the current and proposed bytes of both copies in the retention record before either copy changes. */
  private async recordCopies(json: string, markdown: string, retentionDays: number): Promise<{ previousRaw?: Buffer; currentCopies: Map<string, Buffer | undefined> }> {
    const record = this.copiesRecord();
    const previousRaw = await safeRead(record).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    const previous = previousRaw ? parseReportCopies(previousRaw, this.copyNames) : {};
    const metadata: ReportCopies = {};
    const currentCopies = new Map<string, Buffer | undefined>();
    for (const [name, content] of [[this.copyNames[0], json], [this.copyNames[1], markdown]]) {
      const current = await safeRead(path.join(this.reportCopiesDirectory!, name)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      currentCopies.set(name, current);
      const prior = (previous[name] ?? []).filter(reference => current && reference.digest === sha256(current));
      const next = { digest: sha256(content), expiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString() };
      const references = new Map(prior.map(reference => [reference.digest, reference]));
      if (!references.has(next.digest) || Date.parse(references.get(next.digest)!.expiresAt) < Date.parse(next.expiresAt)) references.set(next.digest, next);
      metadata[name] = [...references.values()];
    }
    await safeWrite(record, JSON.stringify(metadata));
    return { previousRaw, currentCopies };
  }

  /**
   * Stage both copies, then move the Markdown and finally the JSON into place; the caller holds the directory's lock.
   * On any failure the staged files are removed, a replaced Markdown copy is rewritten from `previousMarkdown` (or
   * removed when there was none), and `restoreRecord` puts back the previous retention record, so the directory keeps
   * the previous pair and record (or none) and never a copy of this write. If that Markdown rollback itself fails, the
   * record keeps covering the old and new bytes so both stay expirable; the original error is rethrown either way.
   */
  private async replaceCopyPair(json: string, markdown: string, previousMarkdown: Buffer | undefined, restoreRecord: () => Promise<void>): Promise<void> {
    const directory = this.reportCopiesDirectory!;
    const [jsonFile, markdownFile] = this.copyNames.map(name => path.join(directory, name));
    const stamp = `${this.stagedPrefix}${randomUUID()}`;
    const [stagedJson, stagedMarkdown] = ["json", "md"].map(suffix => path.join(directory, `${stamp}.${suffix}`));
    let markdownLeftover = false;
    try {
      await this.writeCopyFile(stagedJson, json);
      await this.writeCopyFile(stagedMarkdown, markdown);
      await rename(stagedMarkdown, markdownFile);
      try { await rename(stagedJson, jsonFile); }
      catch (error) {
        await (previousMarkdown === undefined ? rm(markdownFile, { force: true }) : safeWrite(markdownFile, previousMarkdown)).catch(() => { markdownLeftover = true; });
        if (markdownLeftover) throw new Error(`${error instanceof Error ? error.message : String(error)}; restoring the previous ${markdownFile} also failed, so it holds this write's Markdown copy`, { cause: error });
        throw error;
      }
    } catch (error) {
      if (!markdownLeftover) await restoreRecord().catch(() => undefined);
      throw error;
    } finally {
      // Best effort: a staged file left here (by a crash) is swept by the next cleanup of this directory.
      await Promise.all([stagedJson, stagedMarkdown].map(file => rm(file, { force: true }).catch(() => undefined)));
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
    if (this.reportCopiesDirectory && !this.copiesPaired) await this.expireCopies(now, errors);
    else if (this.reportCopiesDirectory) {
      // A missing copies directory has nothing to expire, and cleanup never creates it.
      const exists = await lstat(this.reportCopiesDirectory).then(() => true, (error: NodeJS.ErrnoException) => missing(error) ? false : Promise.reject(error)).catch((error: unknown) => { errors.push(`Report copies: ${errorText(error)}`); return false; });
      if (exists) await this.withOutputLock(async () => { await this.expireCopies(now, errors); await this.deleteStagedCopies(errors); }).catch((error: unknown) => { errors.push(`Report copies: ${errorText(error)}`); });
    }
    return { deleted, errors };
  }

  /** Delete the copies whose every recorded reference has expired, and the record once it covers no remaining copy. */
  private async expireCopies(now: Date, errors: string[]): Promise<void> {
    try {
      const record = this.copiesRecord();
      const raw = await safeRead(record).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (!raw) return;
      const metadata = parseReportCopies(raw, this.copyNames);
      let remaining = false;
      const expiredCopies: string[] = [];
      for (const name of this.copyNames) {
        const file = path.join(this.reportCopiesDirectory!, name);
        const content = await safeRead(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (!content) continue;
        const references = metadata[name].filter(reference => reference.digest === sha256(content));
        if (!references.length) throw new Error("Report copy changed; refusing expiry deletion.");
        if (references.some(reference => Date.parse(reference.expiresAt) > now.getTime())) { remaining = true; continue; }
        expiredCopies.push(file);
      }
      // Validate both copies before deleting either when an export changed.
      for (const file of expiredCopies) await rm(file, { force: true });
      if (!remaining) await rm(record);
    } catch (error) { errors.push(`Report copies: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Remove staged copies of this copy set (`.reviewfn-copy.<stem>.<uuid>.json|md`) that an interrupted write left in the
   * copies directory. The caller holds the set's lock, which every write of the set holds too, so none of them belongs
   * to a write in progress; another copy set's staged copies are left to that set's cleanup.
   */
  private async deleteStagedCopies(errors: string[]): Promise<void> {
    for (const entry of await readdir(this.reportCopiesDirectory!)) {
      if (!entry.startsWith(this.stagedPrefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(json|md)$/.test(entry.slice(this.stagedPrefix.length))) continue;
      const file = path.join(this.reportCopiesDirectory!, entry);
      try {
        if (!(await lstat(file)).isFile()) throw new Error("refusing non-regular staged copy");
        await rm(file);
      } catch (error) { errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`); }
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

function errorText(error: unknown): string { return error instanceof ReviewFnError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error); }

type ReportCopies = Record<string, { digest: string; expiresAt: string }[]>;
function parseReportCopies(raw: Buffer, names: readonly string[]): ReportCopies {
  const value = JSON.parse(raw.toString("utf8")) as ReportCopies;
  for (const name of names) {
    if (!Array.isArray(value?.[name]) || value[name].length < 1 || value[name].length > 2 || value[name].some(reference => !reference || !/^[a-f0-9]{64}$/.test(reference.digest) || !Number.isFinite(Date.parse(reference.expiresAt)))) throw new Error("Invalid report-copy retention metadata.");
  }
  return value;
}
