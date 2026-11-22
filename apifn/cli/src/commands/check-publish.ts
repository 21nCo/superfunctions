/**
 * Safe publication for `apifn check`: the spec repair (`--write`) and the report file.
 *
 * - No output may land on a file the run read (spec, base file, router module, config file) or
 *   on the other output. Two paths are one file when they lead, after symlinks, to the same name
 *   (NFC and case folded) in the same directory (device and inode, so a symlinked or bind-mounted
 *   directory counts), or to the same existing inode (a hard link). The directory each output was
 *   observed in is bound for the run: it must still be that directory at every later step.
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
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CheckUsageError, errorMessage, foldPath, isMissingPath, nearestExistingDir, writeDestination } from "./check-paths.js";

/** What a file was when the run looked at it: its identity, or absent. */
export type FileState = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number } | null;

export function stateOf(stats: Stats): FileState {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, mode: stats.mode };
}

function sameState(a: FileState, b: FileState): boolean {
  if (a === null || b === null) return a === b;
  return sameContent(a, b) && a.ctimeMs === b.ctimeMs;
}

/** Same inode with the same size and modification time (a new link or a rename changes ctime only). */
function sameContent(a: FileState, b: FileState): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The current state of `file` (not following a final symlink). */
function currentState(file: string): FileState {
  try {
    return stateOf(lstatSync(file));
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

/** A directory bound for the run: its path and the device and inode it had when observed. */
export interface Anchor {
  dir: string;
  dev: number;
  ino: number;
}

function anchorOf(dir: string): Anchor {
  const stats = statSync(dir);
  return { dir, dev: stats.dev, ino: stats.ino };
}

/** True while `anchor.dir` is still the directory it was bound to. */
function stillAnchored(anchor: Anchor): boolean {
  try {
    const stats = statSync(anchor.dir);
    return stats.dev === anchor.dev && stats.ino === anchor.ino;
  } catch {
    return false;
  }
}

interface Location {
  dev: number;
  ino: number;
  rest: string;
  leaf: FileState;
}

function locationOf(anchor: Anchor, destination: string, leaf: FileState): Location {
  return { dev: anchor.dev, ino: anchor.ino, rest: foldPath(path.relative(anchor.dir, destination)), leaf };
}

function locate(file: string): Location {
  const destination = writeDestination(file);
  let leaf: FileState = null;
  try {
    leaf = stateOf(statSync(destination));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return locationOf(anchorOf(nearestExistingDir(destination)), destination, leaf);
}

function sameFile(a: Location, b: Location): boolean {
  if (a.dev === b.dev && a.ino === b.ino && a.rest === b.rest) return true;
  return a.leaf !== null && b.leaf !== null && a.leaf.dev === b.leaf.dev && a.leaf.ino === b.leaf.ino;
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
    const clash = others.find((other) => sameFile(location, locate(other.file)));
    if (clash) {
      throw new CheckUsageError(`${output.role} is ${clash.role}; pick another file.`);
    }
  }
}

/** A step of the publisher, for tests that change the filesystem between steps. */
export type PublishStep = "backup" | "rename" | "rollback";
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
  createdDir?: string;
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

/** Removes the directories mkdir created for a destination, deepest first, while empty. */
function removeCreatedDirs(staged: Staged): void {
  if (staged.createdDir === undefined) return;
  let dir = path.dirname(staged.destination);
  for (;;) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
    if (dir === staged.createdDir) return;
    dir = path.dirname(dir);
  }
}

/** True while the directories bound for this output are still the ones the run observed. */
function placeHolds(staged: Staged): boolean {
  return stillAnchored(staged.anchor) && (staged.parent === undefined || stillAnchored(staged.parent));
}

function changed(staged: Staged): CheckUsageError {
  return new CheckUsageError(`${staged.destination} changed while apifn check ran; ${staged.output.option} wrote nothing.`);
}

function stage(staged: Staged): void {
  if (!stillAnchored(staged.anchor)) throw changed(staged);
  staged.createdDir = mkdirSync(path.dirname(staged.destination), { recursive: true });
  if (!stillAnchored(staged.anchor)) throw changed(staged);
  staged.parent = anchorOf(path.dirname(staged.destination));
  const temp = tempName(staged.destination);
  const fd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o666);
  staged.temp = temp;
  staged.fd = fd;
  if (staged.before !== null) fchmodSync(fd, staged.before.mode & 0o7777);
  writeFileSync(fd, staged.bytes);
  fsyncSync(fd);
  staged.installed = stateOf(fstatSync(fd));
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
    sameState(stateOf(fstatSync(staged.fd)), installed) &&
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
  staged.installed = stateOf(fstatSync(staged.fd as number));
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
      stage(staged);
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
