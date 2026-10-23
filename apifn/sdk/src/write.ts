// Writes a generation result into a package directory. Only files the
// generator owns are created, replaced or deleted; seeds are created once; the
// custom-code area and every other file are left alone. One run at a time holds
// the directory's lock file from reading the previous manifest to writing the new one;
// a dry run only reads, reports a held lock instead of taking it, and re-checks what it
// read so it never reports a plan for files another run replaced meanwhile.

import { randomUUID } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat as follow, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { sha256Hex } from "@apifn/contracts";
import { comparePaths, isSafeRelativePath } from "./paths.js";
import {
  SDK_ARTIFACT_MANIFEST_FILE,
  SDK_ARTIFACT_MANIFEST_VERSION,
  SDK_OUTPUT_LOCK_FILE,
  type SdkArtifactManifest,
  type SdkDiagnostic,
  type SdkGenerationResult,
} from "./types.js";

export interface WriteSdkOptions {
  /**
   * Plan only: report what would change without creating, changing or removing anything, so the directory
   * may be read-only. The lock is not taken; a lock held before or during planning is SDK_OUTPUT_CONFLICT.
   * Every file read is re-checked after planning: if another run replaced any of them meanwhile, the plan is
   * made again, and after repeated changes the result is SDK_OUTPUT_CONFLICT, never a plan for mixed files.
   */
  dryRun?: boolean;
}

export interface WriteSdkResult {
  ok: boolean;
  /** Owned files created or replaced (or that would be, in a dry run). */
  written: string[];
  /** Files whose contents already match, including a manifest briefly replaced by an interim one and restored. */
  unchanged: string[];
  /** Files owned by the previous generation that this one no longer produces. */
  deleted: string[];
  /** Custom-code seeds created because they were missing. */
  seeded: string[];
  diagnostics: SdkDiagnostic[];
}

async function stat(file: string): Promise<Stats | null>;
async function stat(file: string, options: { bigint: true }): Promise<BigIntStats | null>;
async function stat(file: string, options?: { bigint: true }): Promise<Stats | BigIntStats | null> {
  try {
    return await lstat(file, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type Entry = Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink">;

/** The file system reads a plan makes. */
interface Reader {
  stat(file: string): Promise<Entry | null>;
  read(file: string): Promise<string>;
}

const direct: Reader = { stat: (file) => stat(file), read: (file) => readFile(file, "utf8") };

/**
 * A reader that records what each read saw, so a dry run can tell whether anything it read changed before
 * it finished. A file's identity includes its inode and change time: every write replaces a file by renaming
 * a new one over it and always replaces the manifest, so even a write that restores the same contents shows.
 * The first observation of a path is what the plan relied on: a later one that differs is itself a change.
 */
class RecordingReader implements Reader {
  private readonly seen = new Map<string, { file: string; read: boolean; value: string }>();
  private differed: string | null = null;

  async stat(file: string): Promise<Entry | null> {
    const info = await stat(file, { bigint: true });
    this.observe(`stat:${file}`, { file, read: false, value: identity(info) });
    return info;
  }

  async read(file: string): Promise<string> {
    const contents = await readFile(file, "utf8");
    this.observe(`read:${file}`, { file, read: true, value: sha256Hex(contents) });
    return contents;
  }

  private observe(key: string, observation: { file: string; read: boolean; value: string }): void {
    const first = this.seen.get(key);
    if (!first) this.seen.set(key, observation);
    else if (first.value !== observation.value) this.differed ??= observation.file;
  }

  /** The first file that no longer looks as it did when first read, or null when none changed. */
  async changed(): Promise<string | null> {
    if (this.differed !== null) return this.differed;
    for (const { file, read, value } of this.seen.values()) {
      // A read that now fails (say, a directory on the path became a file) is a change too.
      const now = read ? await readFile(file, "utf8").then(sha256Hex, () => null) : await stat(file, { bigint: true }).then(identity, () => null);
      if (now !== value) return file;
    }
    return null;
  }
}

/** A directory only by kind (its own times change with any entry); a file by inode, size and times. */
function identity(info: BigIntStats | null): string {
  if (!info) return "absent";
  if (info.isDirectory()) return "directory";
  if (!info.isFile()) return info.isSymbolicLink() ? "symlink" : "other";
  return `file:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

interface PreviousGeneration {
  manifest: SdkArtifactManifest;
  /** Owned paths and the digests their contents had when generated. */
  owned: Map<string, Set<string>>;
}

/**
 * Written before any owned file changes and replaced by the final manifest: it keeps the previous
 * generation's provenance and digests, adds the paths this run may create, and lists in `pendingFiles`
 * what this run writes, so after an interruption either version of a file counts as generated.
 */
type InterimManifest = SdkArtifactManifest & { pendingFiles: Array<{ path: string; sha256: string }> };

/** The generation a previous run recorded, null when there is none, or why its manifest is unusable. */
async function previousGeneration(outDir: string, reader: Reader): Promise<PreviousGeneration | null | string> {
  const file = path.join(outDir, SDK_ARTIFACT_MANIFEST_FILE);
  const info = await reader.stat(file);
  if (!info) return null;
  if (!info.isFile()) return `${SDK_ARTIFACT_MANIFEST_FILE} is not a regular file.`;
  let manifest: Partial<SdkArtifactManifest>;
  try {
    manifest = JSON.parse(await reader.read(file)) as Partial<SdkArtifactManifest>;
  } catch {
    return `${SDK_ARTIFACT_MANIFEST_FILE} is not valid JSON.`;
  }
  const files = manifest?.files;
  const pending = (manifest as Partial<InterimManifest> | null)?.pendingFiles ?? [];
  if (manifest?.manifestVersion !== SDK_ARTIFACT_MANIFEST_VERSION || !Array.isArray(files) || !Array.isArray(pending)) {
    return `${SDK_ARTIFACT_MANIFEST_FILE} is not an ${SDK_ARTIFACT_MANIFEST_VERSION} manifest.`;
  }
  const owned = new Map<string, Set<string>>();
  for (const entry of [...files, ...pending]) {
    if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string" || !isSafeRelativePath(entry.path)) return `${SDK_ARTIFACT_MANIFEST_FILE} lists an invalid file entry.`;
    const digests = owned.get(entry.path) ?? new Set<string>();
    digests.add(entry.sha256);
    owned.set(entry.path, digests);
  }
  return { manifest: manifest as SdkArtifactManifest, owned };
}

/** Rejects a path whose existing ancestors inside the output directory include a symlink or non-directory. */
async function checkAncestors(outDir: string, relative: string, reader: Reader): Promise<string | null> {
  const segments = relative.split("/");
  let current = outDir;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await reader.stat(current);
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) return `"${path.relative(outDir, current)}" is not a plain directory.`;
  }
  return null;
}

const isLockPath = (relative: string) => relative.toLowerCase() === SDK_OUTPUT_LOCK_FILE;

interface OutputLock {
  file: string;
  nonce: string;
}

/** Who holds the lock file at `file`, for a conflict message. */
async function lockConflict(file: string): Promise<string> {
  let holder = "holder unknown";
  try {
    const held = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown; hostname?: unknown; startedAt?: unknown };
    holder = `process ${String(held.pid)} on ${String(held.hostname)} since ${String(held.startedAt)}`;
  } catch {
    // Unreadable, or its holder has not finished writing it.
  }
  return `${file} exists: another run is writing this directory (${holder}). If no run is active, a crashed run left it behind: remove it and rerun.`;
}

/** Creates the lock file exclusively, or explains who holds it. A held lock is never taken over. */
async function acquireLock(root: string): Promise<OutputLock | string> {
  const file = path.join(root, SDK_OUTPUT_LOCK_FILE);
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return lockConflict(file);
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), nonce })}\n`);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return { file, nonce };
}

/** Why a dry run cannot rely on its plan: another run holds the lock. Null when no lock file exists. */
async function heldLock(root: string): Promise<string | null> {
  const file = path.join(root, SDK_OUTPUT_LOCK_FILE);
  return (await stat(file)) ? lockConflict(file) : null;
}

/** Removes the lock only while it is still this run's own. */
async function releaseLock(lock: OutputLock): Promise<void> {
  try {
    if ((JSON.parse(await readFile(lock.file, "utf8")) as { nonce?: unknown }).nonce !== lock.nonce) return;
  } catch {
    return;
  }
  await rm(lock.file, { force: true });
}

export async function writeSdk(outDir: string, result: SdkGenerationResult, options: WriteSdkOptions = {}): Promise<WriteSdkResult> {
  const outcome: WriteSdkResult = { ok: false, written: [], unchanged: [], deleted: [], seeded: [], diagnostics: [] };
  const conflict = (message: string, pointer?: string) => outcome.diagnostics.push({ code: "SDK_OUTPUT_CONFLICT", severity: "error", message, pointer });
  if (!result.ok || !result.manifest) {
    conflict("Generation failed; nothing was written.");
    return outcome;
  }
  const generated = { ...result, manifest: result.manifest };
  const root = path.resolve(outDir);
  const rootInfo = await follow(root).catch(() => null);
  if (rootInfo && !rootInfo.isDirectory()) {
    conflict(`${root} exists and is not a directory.`);
    return outcome;
  }
  if (options.dryRun) return dryRun(root, generated);
  if (!rootInfo) await mkdir(root, { recursive: true });
  const lock = await acquireLock(root);
  if (typeof lock === "string") {
    conflict(lock, SDK_OUTPUT_LOCK_FILE);
    return outcome;
  }
  try {
    return await transaction(root, generated, options, outcome, direct);
  } finally {
    await releaseLock(lock);
  }
}

/** How many times a dry run plans again after another run changed files it read. */
const DRY_RUN_ATTEMPTS = 3;

/**
 * Plans without the lock or any write. Another run may write while this reads, so the plan is accepted
 * only when no lock was held before or after it and every file it read is still as it was; the directory
 * then held exactly those files throughout, whether or not it existed at the start.
 */
async function dryRun(root: string, result: Generated): Promise<WriteSdkResult> {
  const failed = (message: string, pointer: string): WriteSdkResult => ({
    ok: false,
    written: [],
    unchanged: [],
    deleted: [],
    seeded: [],
    diagnostics: [{ code: "SDK_OUTPUT_CONFLICT", severity: "error", message, pointer }],
  });
  for (let attempt = 1; ; attempt++) {
    const before = await heldLock(root);
    if (before !== null) return failed(before, SDK_OUTPUT_LOCK_FILE);
    const reader = new RecordingReader();
    let planned: { outcome: WriteSdkResult } | { error: unknown };
    try {
      planned = { outcome: await transaction(root, result, { dryRun: true }, { ok: false, written: [], unchanged: [], deleted: [], seeded: [], diagnostics: [] }, reader) };
    } catch (error) {
      // A read can fail because another run replaced or removed what an earlier read saw; plan again then.
      if ((await reader.changed()) === null && (await heldLock(root)) === null) throw error;
      planned = { error };
    }
    const changed = await reader.changed();
    const held = await heldLock(root);
    if (held !== null) return failed(held, SDK_OUTPUT_LOCK_FILE);
    if (changed === null) {
      if ("outcome" in planned) return planned.outcome;
      // A writer held the lock when the read failed but has released it and changed nothing this plan
      // read: plan again, and report the error itself if it persists.
      if (attempt === DRY_RUN_ATTEMPTS) throw planned.error;
      continue;
    }
    if (attempt === DRY_RUN_ATTEMPTS) {
      const relative = path.relative(root, changed).split(path.sep).join("/");
      return failed(`"${relative}" changed while it was being checked, ${DRY_RUN_ATTEMPTS} times: another run is writing this directory. Rerun the check once it finishes.`, relative);
    }
  }
}

type Generated = SdkGenerationResult & { manifest: SdkArtifactManifest };

/** Plans and applies the write; the caller holds the directory's lock unless this is a dry run. */
async function transaction(root: string, result: Generated, options: WriteSdkOptions, outcome: WriteSdkResult, reader: Reader): Promise<WriteSdkResult> {
  const conflict = (message: string, pointer?: string) => outcome.diagnostics.push({ code: "SDK_OUTPUT_CONFLICT", severity: "error", message, pointer });
  const generation = await previousGeneration(root, reader);
  if (typeof generation === "string") {
    conflict(`${generation} Remove it, or choose an empty output directory.`, SDK_ARTIFACT_MANIFEST_FILE);
    return outcome;
  }
  const previous = generation?.owned;
  const customRoot = result.manifest.customCode.root;

  // Plan every change before writing anything, so a conflict leaves the directory untouched.
  const writes: Array<{ path: string; contents: string }> = [];
  for (const file of result.files) {
    if (!isSafeRelativePath(file.path) || isLockPath(file.path)) {
      conflict(`"${file.path}" is not a safe package-relative path.`, file.path);
      continue;
    }
    const ancestor = await checkAncestors(root, file.path, reader);
    if (ancestor) {
      conflict(`Cannot write "${file.path}": ${ancestor}`, file.path);
      continue;
    }
    const target = path.join(root, file.path);
    const info = await reader.stat(target);
    if (file.ownership === "seed") {
      if (info) continue;
      outcome.seeded.push(file.path);
      writes.push(file);
      continue;
    }
    if (!info) {
      outcome.written.push(file.path);
      writes.push(file);
      continue;
    }
    if (!info.isFile()) {
      conflict(`"${file.path}" exists and is not a regular file.`, file.path);
      continue;
    }
    const current = await reader.read(target);
    const owned = file.path === SDK_ARTIFACT_MANIFEST_FILE || previous?.has(file.path) === true;
    if (current === file.contents) {
      outcome.unchanged.push(file.path);
      continue;
    }
    if (!owned) {
      conflict(`"${file.path}" exists and was not written by a previous generation; move it, or into ${customRoot} for custom code.`, file.path);
      continue;
    }
    const recorded = previous?.get(file.path);
    if (recorded !== undefined && !recorded.has(sha256Hex(current))) {
      outcome.diagnostics.push({
        code: "SDK_OWNED_FILE_MODIFIED",
        severity: "warning",
        message: `"${file.path}" was edited after generation; regeneration replaces it. Keep custom code in ${customRoot}.`,
        pointer: file.path,
      });
    }
    outcome.written.push(file.path);
    writes.push(file);
  }
  const produced = new Set(result.files.map((file) => file.path));
  for (const stale of [...(previous?.keys() ?? [])].sort(comparePaths)) {
    if (produced.has(stale) || stale.startsWith(customRoot) || isLockPath(stale)) continue;
    if (await checkAncestors(root, stale, reader)) continue;
    const target = path.join(root, stale);
    const info = await reader.stat(target);
    if (!info?.isFile()) continue;
    if (!previous?.get(stale)?.has(sha256Hex(await reader.read(target)))) {
      outcome.diagnostics.push({ code: "SDK_OWNED_FILE_MODIFIED", severity: "warning", message: `"${stale}" was edited after generation and is no longer generated; it is deleted.`, pointer: stale });
    }
    outcome.deleted.push(stale);
  }
  if (outcome.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return outcome;
  outcome.ok = true;
  if (options.dryRun) return outcome;

  // A crash part-way must neither orphan new files nor make rewritten ones look hand-edited: first record
  // every path this run may create or replace, keeping the previous provenance and digests.
  const seeds = new Set(result.manifest.customCode.seeds);
  const owned = writes.filter((file) => !seeds.has(file.path) && file.path !== SDK_ARTIFACT_MANIFEST_FILE);
  const manifestFile = result.files.find((file) => file.path === SDK_ARTIFACT_MANIFEST_FILE);
  // The interim manifest is always replaced by the final one, even when that equals the previous manifest.
  const interimWritten = owned.length > 0 || outcome.deleted.length > 0;
  if (interimWritten) {
    const base = generation?.manifest ?? result.manifest;
    const recorded = [...(previous ?? [])].flatMap(([file, digests]) => [...digests].map((sha256) => ({ path: file, sha256 })));
    const created = owned.filter((file) => !previous?.has(file.path)).map((file) => ({ path: file.path, sha256: sha256Hex(file.contents) }));
    const interim: InterimManifest = {
      ...base,
      files: (generation ? [...recorded, ...created] : created).sort((a, b) => comparePaths(a.path, b.path)),
      pendingFiles: owned.map((file) => ({ path: file.path, sha256: sha256Hex(file.contents) })),
    };
    await atomicWrite(path.join(root, SDK_ARTIFACT_MANIFEST_FILE), `${JSON.stringify(interim, null, 2)}\n`);
  }
  for (const file of writes) {
    if (file.path === SDK_ARTIFACT_MANIFEST_FILE) continue;
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await atomicWrite(path.join(root, file.path), file.contents);
  }
  for (const stale of outcome.deleted) await rm(path.join(root, stale), { force: true });
  if (manifestFile && (interimWritten || writes.some((file) => file.path === SDK_ARTIFACT_MANIFEST_FILE))) {
    await atomicWrite(path.join(root, manifestFile.path), manifestFile.contents);
  }
  return outcome;
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  // Unique per write, so failure cleanup never removes a temporary file another write still owns.
  const temporary = `${file}.apifn-tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
