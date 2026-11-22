/**
 * Safe publication for `apifn check`: the spec repair (`--write`) and the report file.
 *
 * - No output may land on a file the run read (spec, base file, router module, config file) or
 *   on the other output. Two paths are one file when they lead, after symlinks, to the same name
 *   (NFC and case folded) in the same directory (device and inode, so a symlinked or bind-mounted
 *   directory counts), or to the same existing inode (a hard link).
 * - Each output is staged as a complete temp file beside its destination, then renamed over it
 *   (a symlinked spec keeps its link: the rename lands on the link's target).
 * - Before the renames, each destination must still be the file the run observed (the same
 *   inode, size and times, or still absent); otherwise nothing is published.
 * - After the renames the caller writes stdout. If that or a later rename fails, every published
 *   output is rolled back, but only while the destination is still exactly what this run put
 *   there; bytes another writer put there are left alone and the error names the conflict.
 */

import {
  closeSync,
  copyFileSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
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

interface Location {
  dev: number;
  ino: number;
  rest: string;
  leaf: FileState;
}

function locate(file: string): Location {
  const destination = writeDestination(file);
  const dir = nearestExistingDir(destination);
  const anchor = statSync(dir);
  let leaf: FileState = null;
  try {
    leaf = stateOf(statSync(destination));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return { dev: anchor.dev, ino: anchor.ino, rest: foldPath(path.relative(dir, destination)), leaf };
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

export interface PlannedOutput {
  /** The option that names the output, such as "--report report.md" or "--write". */
  option: string;
  /** How a write failure names it, such as "report" or "spec". */
  noun: string;
  /** The path as the user gave it (for messages). */
  file: string;
  /** Where the write lands (observe). */
  destination: string;
  text: string;
  /** The state the destination was in when the run observed or read it. */
  observed: FileState;
}

/**
 * Where a write to `file` lands (symlinks followed) and the state it is in now. An existing
 * destination must be a regular file.
 */
export function observe(file: string): { destination: string; state: FileState } {
  const destination = writeDestination(file);
  const state = currentState(destination);
  if (state !== null && (state.mode & constants.S_IFMT) !== constants.S_IFREG) {
    throw new CheckUsageError(`${file} is not a regular file.`);
  }
  return { destination, state };
}

interface Staged {
  output: PlannedOutput;
  destination: string;
  before: FileState;
  temp?: string;
  createdDir?: string;
  backup?: string;
  published?: FileState;
}

/**
 * Rejects an output that may land on one of the files listed beside it (see the module comment).
 */
export function assertSeparateFiles(checks: Array<{ output: NamedFile; others: NamedFile[] }>): void {
  for (const { output, others } of checks) {
    const at = locate(output.file);
    const clash = others.find((other) => sameFile(at, locate(other.file)));
    if (clash) {
      throw new CheckUsageError(`${output.role} is ${clash.role}; pick another file.`);
    }
  }
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

function stage(staged: Staged): void {
  staged.createdDir = mkdirSync(path.dirname(staged.destination), { recursive: true });
  const temp = tempName(staged.destination);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
  staged.temp = temp;
  try {
    if (staged.before !== null) fchmodSync(fd, staged.before.mode & 0o7777);
    writeFileSync(fd, staged.output.text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
}

/** Undoes one published output while the destination still holds exactly what this run wrote. */
function rollBack(staged: Staged): string | null {
  if (staged.published === undefined) {
    removeQuietly(staged.temp);
    removeQuietly(staged.backup);
    removeCreatedDirs(staged);
    return null;
  }
  if (!sameState(currentState(staged.destination), staged.published)) {
    const kept = staged.backup ? ` Its previous bytes are in ${staged.backup}.` : "";
    return `${staged.destination} changed after apifn check wrote it, so it was left as it is.${kept}`;
  }
  if (staged.backup) {
    renameSync(staged.backup, staged.destination);
  } else {
    unlinkSync(staged.destination);
    removeCreatedDirs(staged);
  }
  return null;
}

function rollBackAll(all: Staged[], error: unknown): CheckUsageError {
  const problems: string[] = [];
  for (const staged of [...all].reverse()) {
    try {
      const conflict = rollBack(staged);
      if (conflict) problems.push(conflict);
    } catch (restoreError) {
      problems.push(`Failed to restore ${staged.destination}: ${errorMessage(restoreError)}`);
    }
  }
  return new CheckUsageError([errorMessage(error), ...problems].join(" "));
}

/**
 * Publishes the outputs (in order), then runs `emit` (stdout). Any failure rolls back what was
 * published and throws a CheckUsageError.
 */
export function publish(outputs: PlannedOutput[], emit: () => void): void {
  const all: Staged[] = outputs.map((output) => ({
    output,
    destination: output.destination,
    before: output.observed,
  }));

  for (const staged of all) {
    try {
      stage(staged);
    } catch (error) {
      throw rollBackAll(all, new CheckUsageError(`Failed to write ${staged.output.noun} ${staged.output.file}: ${errorMessage(error)}`));
    }
  }
  for (const staged of all) {
    if (!sameState(currentState(staged.destination), staged.before)) {
      throw rollBackAll(
        all,
        new CheckUsageError(`${staged.destination} changed while apifn check ran; ${staged.output.option} wrote nothing.`)
      );
    }
  }
  for (const staged of all) {
    try {
      backUp(staged);
      renameSync(staged.temp as string, staged.destination);
      staged.temp = undefined;
      staged.published = currentState(staged.destination);
    } catch (error) {
      throw rollBackAll(all, new CheckUsageError(`Failed to write ${staged.output.noun} ${staged.output.file}: ${errorMessage(error)}`));
    }
  }
  try {
    emit();
  } catch (error) {
    throw rollBackAll(all, new CheckUsageError(`Failed to write the report to stdout: ${errorMessage(error)}`));
  }
  for (const staged of all) removeQuietly(staged.backup);
}
