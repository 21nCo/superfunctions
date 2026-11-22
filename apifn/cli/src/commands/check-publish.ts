/**
 * Safe publication for `apifn check`: the spec repair (`--write`) and the report file.
 *
 * - No output may land on a file the run read (spec, base file, router module, config file) or
 *   on the other output. Two paths are one file when they lead, after symlinks, to the same name
 *   in the same directory (device and inode, so a symlinked or bind-mounted directory counts), or
 *   to the same existing inode (a hard link). Two existing files are one only by inode; a missing
 *   name and an existing file are distinct (its lookup failed). Two missing names that differ only
 *   in case or Unicode normalization are one where their directory folds such names, judged from
 *   that directory's own entries (see aliasOf); with no such evidence the run refuses. The
 *   directory each output was observed in is bound for the run: it must still be that directory
 *   at every later step.
 * - Each output is staged as a complete temp file beside its destination, then renamed over it
 *   (a symlinked spec keeps its link: the rename lands on the link's target). The identity of
 *   what this run installed is the staged file's own (rename keeps the inode), never a lookup of
 *   the destination after the rename.
 * - Immediately before the backup, the rename and each rollback step, the directory and the
 *   destination are checked again: the destination must still be the file the run observed (or
 *   still absent) before publishing. Before a rollback restores or unlinks an output, the run must
 *   still own it: the destination is the inode this run staged (its descriptor is kept open), with
 *   the change time it had right after the rename and exactly the bytes this run wrote, read back
 *   through that descriptor. An edit in place changes the change time, which no writer can set,
 *   and its bytes; size and modification time are not proof.
 * - stdout is part of the transaction: the backups are kept until the stdout write has completed
 *   (its callback, not its return). If that or a later step fails, every published output is
 *   rolled back; bytes another writer put there are left alone and the error names the conflict.
 *
 * Residual: POSIX has no compare-and-swap rename, so a replacement made between the last check
 * and the rename (a window of one system call) is not detected.
 */

import {
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CheckUsageError, errorMessage, foldPath, isMissingPath, nearestExistingDir, writeDestination } from "./check-paths.js";

/**
 * What a file was when the run looked at it: its identity, or absent. Every field comes from a
 * bigint stat: device and inode numbers above 2^53 stay distinct, and times keep nanoseconds.
 */
export type FileState = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: number } | null;

export function stateOf(stats: BigIntStats): FileState {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, mode: Number(stats.mode) };
}

const BIG = { bigint: true } as const;

function sameState(a: FileState, b: FileState): boolean {
  if (a === null || b === null) return a === b;
  return sameContent(a, b) && a.ctimeNs === b.ctimeNs;
}

/** Same inode with the same size and modification time (a new link or a rename changes ctime only). */
function sameContent(a: FileState, b: FileState): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** The current state of `file` (not following a final symlink). */
function currentState(file: string): FileState {
  try {
    return stateOf(lstatSync(file, BIG));
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

/** A directory bound for the run: its path and the device and inode it had when observed. */
export interface Anchor {
  dir: string;
  dev: bigint;
  ino: bigint;
}

function anchorOf(dir: string): Anchor {
  const stats = statSync(dir, BIG);
  return { dir, dev: stats.dev, ino: stats.ino };
}

/** True while `anchor.dir` is still the directory it was bound to. */
function stillAnchored(anchor: Anchor): boolean {
  try {
    const stats = statSync(anchor.dir, BIG);
    return stats.dev === anchor.dev && stats.ino === anchor.ino;
  } catch {
    return false;
  }
}

interface Location {
  anchor: Anchor;
  /** The destination's path below the anchor, as spelled. */
  rest: string;
  leaf: FileState;
}

function locationOf(anchor: Anchor, destination: string, leaf: FileState): Location {
  return { anchor, rest: path.relative(anchor.dir, destination), leaf };
}

function locate(file: string): Location {
  const destination = writeDestination(file);
  let leaf: FileState = null;
  try {
    leaf = stateOf(statSync(destination, BIG));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return locationOf(anchorOf(nearestExistingDir(destination)), destination, leaf);
}

/** The other-case spelling of `name` (null when it has none that keeps every letter in place). */
function otherCase(name: string): string | null {
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  if (lower === upper || lower.length !== name.length || upper.length !== name.length) return null;
  const variant = name === lower ? upper : lower;
  return variant.toLowerCase() === lower ? variant : null;
}

/** The other Unicode normalization of `name` (null when NFC and NFD spell it alike). */
function otherNormalization(name: string): string | null {
  const nfd = name.normalize("NFD");
  if (nfd !== name) return nfd;
  const nfc = name.normalize("NFC");
  return nfc === name ? null : nfc;
}

/**
 * What the directory `anchor` itself shows about whether it treats `variantOf(name)` as `name`,
 * from its own entries (never its parent's policy, which can differ per directory):
 * - a variant listed as an entry of its own is a distinct name, even when both share an inode
 *   (hard links), so the directory does not fold;
 * - a variant the listing lacks and a lookup does not find is a distinct name too;
 * - a variant the listing lacks but a lookup finds as the same inode is a fold.
 * Null when no entry can tell (no entry with a variant, or the directory cannot be listed).
 */
function foldsVariants(anchor: Anchor, variantOf: (name: string) => string | null): boolean | null {
  let entries: string[];
  try {
    entries = readdirSync(anchor.dir);
  } catch {
    return null;
  }
  const listed = new Set(entries);
  for (const name of entries) {
    const variant = variantOf(name);
    if (variant === null) continue;
    if (listed.has(variant)) return false;
    let original: BigIntStats;
    try {
      original = lstatSync(path.join(anchor.dir, name), BIG);
    } catch {
      continue;
    }
    try {
      const found = lstatSync(path.join(anchor.dir, variant), BIG);
      // Another inode under an unlisted name appeared after the listing: no evidence either way.
      if (found.dev === original.dev && found.ino === original.ino) return true;
    } catch (error) {
      if (isMissingPath(error)) return false;
    }
  }
  return null;
}

/** Spelling with letter case folded and normalization kept, to tell whether two names differ in normalization. */
function caseFolded(value: string): string {
  return value.toUpperCase().toLowerCase();
}

type Alias = "same" | "distinct" | "unknown";

/**
 * Whether two write locations are one file:
 * - both exist: inode identity alone decides (distinct inodes are never one file);
 * - exactly one exists: the failed lookup of the other already shows its name reaches no file
 *   there, so they are distinct;
 * - both missing: one file when bound to one directory under the same name, or names that differ
 *   only in case or Unicode normalization where that directory folds such names. The evidence
 *   comes from that directory's own entries (foldsVariants); with none, the answer is unknown.
 */
function aliasOf(a: Location, b: Location): Alias {
  if (a.leaf !== null && b.leaf !== null) return a.leaf.dev === b.leaf.dev && a.leaf.ino === b.leaf.ino ? "same" : "distinct";
  if (a.leaf !== null || b.leaf !== null) return "distinct";
  if (a.anchor.dev !== b.anchor.dev || a.anchor.ino !== b.anchor.ino) return "distinct";
  if (a.rest === b.rest) return "same";
  if (foldPath(a.rest) !== foldPath(b.rest)) return "distinct";
  const evidence: Array<boolean | null> = [];
  if (a.rest.normalize("NFC") !== b.rest.normalize("NFC")) evidence.push(foldsVariants(a.anchor, otherCase));
  if (caseFolded(a.rest) !== caseFolded(b.rest)) evidence.push(foldsVariants(a.anchor, otherNormalization));
  if (evidence.includes(false)) return "distinct";
  return evidence.includes(null) ? "unknown" : "same";
}

export interface NamedFile {
  /** How errors name the file, such as "the spec" or "the --base-spec file base.yml". */
  role: string;
  file: string;
}

/** Where a write to a file lands, the state it was in and the directory bound for the run. */
export interface Observed {
  destination: string;
  state: FileState;
  anchor: Anchor;
}

export interface PlannedOutput {
  /** The option that names the output, such as "--report report.md" or "--write". */
  option: string;
  /** How a write failure names it, such as "report" or "spec". */
  noun: string;
  /** The path as the user gave it (for messages). */
  file: string;
  /** Where the write lands and the directory bound for it (observe). */
  target: Observed;
  text: string;
  /** The state the destination was in when the run observed or read it. */
  observed: FileState;
}

/**
 * Where a write to `file` lands (symlinks followed), the state it is in now and its nearest
 * existing directory, bound for the run. An existing destination must be a regular file.
 */
export function observe(file: string): Observed {
  const destination = writeDestination(file);
  const state = currentState(destination);
  if (state !== null && (state.mode & constants.S_IFMT) !== constants.S_IFREG) {
    throw new CheckUsageError(`${file} is not a regular file.`);
  }
  return { destination, state, anchor: anchorOf(nearestExistingDir(destination)) };
}

/**
 * Rejects an output that may land on one of the files listed beside it (see the module comment).
 * The output is compared at the location `observe` bound, the one the publisher later re-checks.
 */
export function assertSeparateFiles(checks: Array<{ output: NamedFile; at: Observed; others: NamedFile[] }>): void {
  for (const { output, at, others } of checks) {
    const location = locationOf(at.anchor, at.destination, at.state);
    for (const other of others) {
      const alias = aliasOf(location, locate(other.file));
      if (alias === "same") throw new CheckUsageError(`${output.role} is ${other.role}; pick another file.`);
      if (alias === "unknown") {
        throw new CheckUsageError(
          `${output.role} may be ${other.role}: its names differ only in case or Unicode normalization, and ${location.anchor.dir} has no entry that shows whether it folds such names; pick another file.`,
        );
      }
    }
  }
}

/** A step of the publisher, for tests that change the filesystem between steps (`mkdir`: after
 * the run created one directory for a destination, named in place of the destination). */
export type PublishStep = "mkdir" | "backup" | "rename" | "rollback";
export type PublishHook = (step: PublishStep, destination: string) => void;

interface Staged {
  output: PlannedOutput;
  destination: string;
  before: FileState;
  anchor: Anchor;
  /** The destination's own directory once it exists. */
  parent?: Anchor;
  temp?: string;
  /** The staged file's descriptor, kept open until publish ends: it names this run's inode. */
  fd?: number;
  /** The bytes this run wrote. */
  bytes: Buffer;
  /** The staged file's identity (after the rename, its change time then), read through `fd`. */
  installed?: FileState;
  /** The directories this run created for the destination, deepest first, with their identities. */
  created: Anchor[];
  backup?: string;
  backupState?: FileState;
  /** True when the backup is a hard link to the observed file (not a copy). */
  linked?: boolean;
  published: boolean;
}

function tempName(destination: string): string {
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  return path.join(path.dirname(destination), `.${path.basename(destination)}.apifn-${suffix}.tmp`);
}

function removeQuietly(file: string | undefined): void {
  if (file === undefined) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Removes the directories this run created for a destination, deepest first, while empty and
 * still the directory this run created (another process's replacement is left alone).
 */
function removeCreatedDirs(staged: Staged): void {
  for (const created of staged.created) {
    if (!stillAnchored(created)) return;
    try {
      rmdirSync(created.dir);
    } catch {
      return;
    }
  }
}

/**
 * Creates the missing directories above the destination one at a time, shallowest first, and
 * records each in `staged.created` (deepest first) as soon as it exists, so a failure at any later
 * point leaves a record of every directory this run made. A directory that appears meanwhile
 * (EEXIST) is someone else's: the run stops.
 */
function makeParents(staged: Staged, hook: PublishHook | undefined): void {
  const missing: string[] = [];
  for (let dir = path.dirname(staged.destination); !existsSync(dir) && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    missing.unshift(dir);
  }
  for (const dir of missing) {
    mkdirSync(dir);
    staged.created.unshift(anchorOf(dir));
    hook?.("mkdir", dir);
  }
}

/** True when `file` still leads where it led when the run observed it (no link was retargeted). */
function sameDestination(file: string, destination: string): boolean {
  try {
    return writeDestination(file) === destination;
  } catch {
    return false;
  }
}

/**
 * True while the directories bound for this output are still the ones the run observed, each
 * created directory is still the one this run made, and the path the user gave still leads to the
 * bound destination.
 */
function placeHolds(staged: Staged): boolean {
  return (
    stillAnchored(staged.anchor) &&
    (staged.parent === undefined || stillAnchored(staged.parent)) &&
    staged.created.every(stillAnchored) &&
    sameDestination(staged.output.file, staged.destination)
  );
}

function changed(staged: Staged): CheckUsageError {
  return new CheckUsageError(`${staged.destination} changed while apifn check ran; ${staged.output.option} wrote nothing.`);
}

function stage(staged: Staged, hook: PublishHook | undefined): void {
  if (!stillAnchored(staged.anchor)) throw changed(staged);
  makeParents(staged, hook);
  if (!placeHolds(staged)) throw changed(staged);
  staged.parent = anchorOf(path.dirname(staged.destination));
  const temp = tempName(staged.destination);
  const fd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o666);
  staged.temp = temp;
  staged.fd = fd;
  if (staged.before !== null) fchmodSync(fd, staged.before.mode & 0o7777);
  writeFileSync(fd, staged.bytes);
  fsyncSync(fd);
  staged.installed = stateOf(fstatSync(fd, BIG));
}

/** True when the file open as `fd` holds exactly `bytes`. */
function holdsBytes(fd: number, bytes: Buffer): boolean {
  const read = Buffer.alloc(bytes.length + 1);
  let total = 0;
  for (;;) {
    const count = readSync(fd, read, total, read.length - total, total);
    if (count === 0) break;
    total += count;
    if (total === read.length) break;
  }
  return total === bytes.length && read.subarray(0, total).equals(bytes);
}

/**
 * True while the destination is still what this run installed (see the module comment): the same
 * inode with the same change time as right after the rename, holding exactly the bytes written.
 */
function stillOwned(staged: Staged): boolean {
  if (!placeHolds(staged) || staged.fd === undefined) return false;
  const installed = staged.installed as FileState;
  return (
    sameState(currentState(staged.destination), installed) &&
    sameState(stateOf(fstatSync(staged.fd, BIG)), installed) &&
    holdsBytes(staged.fd, staged.bytes)
  );
}

function backUp(staged: Staged): void {
  if (staged.before === null) return;
  const backup = tempName(staged.destination).replace(/\.tmp$/, ".bak");
  try {
    linkSync(staged.destination, backup);
  } catch {
    copyFileSync(staged.destination, backup, constants.COPYFILE_EXCL);
  }
  staged.backup = backup;
  staged.backupState = currentState(backup);
  // A link made by name must name the observed file; a copy must have copied it.
  staged.linked = sameContent(staged.backupState, staged.before);
  if (!staged.linked && !sameState(currentState(staged.destination), staged.before)) throw changed(staged);
}

/** What the destination must be right before the rename: the backup's inode (the link changed its
 * change time) or, after a copy, the observed file unchanged. */
function expectedBeforeRename(staged: Staged): FileState {
  return staged.linked ? (staged.backupState as FileState) : staged.before;
}

/** Renames the staged file over the destination, re-checking the place before each step. */
function install(staged: Staged, hook: PublishHook | undefined): void {
  hook?.("backup", staged.destination);
  if (!placeHolds(staged) || !sameState(currentState(staged.destination), staged.before)) throw changed(staged);
  backUp(staged);
  hook?.("rename", staged.destination);
  if (!placeHolds(staged) || !sameState(currentState(staged.destination), expectedBeforeRename(staged))) {
    throw changed(staged);
  }
  if (!sameState(currentState(staged.temp as string), staged.installed as FileState)) throw changed(staged);
  renameSync(staged.temp as string, staged.destination);
  staged.temp = undefined;
  staged.published = true;
  // The rename changes the change time of the installed inode and, by dropping a link, of the
  // backup's: record both now, the installed one through the descriptor, not by name.
  staged.installed = stateOf(fstatSync(staged.fd as number, BIG));
  if (staged.backup !== undefined) {
    const backupNow = currentState(staged.backup);
    if (sameContent(backupNow, staged.backupState as FileState)) staged.backupState = backupNow;
  }
}

/** Undoes one published output while the destination still holds exactly what this run installed. */
function rollBack(staged: Staged, hook: PublishHook | undefined): string | null {
  if (!staged.published) {
    removeQuietly(staged.temp);
    removeQuietly(staged.backup);
    removeCreatedDirs(staged);
    return null;
  }
  hook?.("rollback", staged.destination);
  const kept = staged.backup ? ` Its previous bytes are in ${staged.backup}.` : "";
  const conflict = `${staged.destination} changed after apifn check wrote it, so it was left as it is.${kept}`;
  if (!stillOwned(staged)) return conflict;
  if (staged.backup) {
    if (!sameState(currentState(staged.backup), staged.backupState as FileState)) return conflict;
    renameSync(staged.backup, staged.destination);
  } else {
    unlinkSync(staged.destination);
    removeCreatedDirs(staged);
  }
  return null;
}

function rollBackAll(all: Staged[], error: CheckUsageError, hook: PublishHook | undefined): CheckUsageError {
  const problems: string[] = [];
  for (const staged of [...all].reverse()) {
    try {
      const conflict = rollBack(staged, hook);
      if (conflict) problems.push(conflict);
    } catch (restoreError) {
      problems.push(`Failed to restore ${staged.destination}: ${errorMessage(restoreError)}`);
    }
  }
  return new CheckUsageError([error.message, ...problems].join(" "));
}

function writeFailure(staged: Staged, error: unknown): CheckUsageError {
  if (error instanceof CheckUsageError) return error;
  return new CheckUsageError(`Failed to write ${staged.output.noun} ${staged.output.file}: ${errorMessage(error)}`);
}

/**
 * Publishes the outputs (in order), then awaits `emit` (stdout). Any failure, including one stdout
 * reports after its write returned, rolls back what was published and throws a CheckUsageError.
 */
export async function publish(
  outputs: PlannedOutput[],
  emit: () => void | Promise<void>,
  hook?: PublishHook
): Promise<void> {
  const all: Staged[] = outputs.map((output) => ({
    output,
    destination: output.target.destination,
    before: output.observed,
    anchor: output.target.anchor,
    bytes: Buffer.from(output.text, "utf8"),
    created: [],
    published: false,
  }));
  try {
    await publishAll(all, emit, hook);
  } finally {
    for (const staged of all) if (staged.fd !== undefined) closeSync(staged.fd);
  }
}

async function publishAll(all: Staged[], emit: () => void | Promise<void>, hook: PublishHook | undefined): Promise<void> {
  for (const staged of all) {
    try {
      stage(staged, hook);
    } catch (error) {
      throw rollBackAll(all, writeFailure(staged, error), hook);
    }
  }
  for (const staged of all) {
    try {
      install(staged, hook);
    } catch (error) {
      throw rollBackAll(all, writeFailure(staged, error), hook);
    }
  }
  try {
    await emit();
  } catch (error) {
    throw rollBackAll(all, new CheckUsageError(`Failed to write the report to stdout: ${errorMessage(error)}`), hook);
  }
  for (const staged of all) removeQuietly(staged.backup);
}
