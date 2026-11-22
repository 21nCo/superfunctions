/**
 * Safe publication for `apifn check`: the spec repair (`--write`) and the report file.
 *
 * - No output may land on a file the run read (spec, base file, router module, config file) or
 *   on the other output. Separation is an outcome, checked during publication: every protected
 *   path (the inputs, the spec even when only a report is written, and each other output) is
 *   passed to publish with its observed state and looked up again at its bound destination after
 *   every change the run makes (a created directory, a staged temp file, a backup, a rename). A
 *   missing one must still be missing and an existing one unchanged; otherwise every published
 *   output and created directory is rolled back and the run exits 2 before stdout. A filesystem
 *   can join names in ways no name comparison predicts (vfat 8.3 short names, partial case
 *   folding), so name shape and probes only add refusals before publication and never prove two
 *   names distinct. The early refusals: two paths that lead, after symlinks, to the same name in
 *   the same directory or to the same existing inode; two missing names that differ only in case
 *   or Unicode normalization where a probe entry built from them folds (or cannot tell). The
 *   directory each output was observed in is bound for the run: it must still be that directory
 *   at every later step.
 * - Separation is established on the exact destination entries before any of them holds bytes:
 *   each missing destination is first reserved as an empty file (O_EXCL) and every protected path
 *   is checked again; only when every output is reserved and checked is any byte written. Each
 *   temp file is created empty and checked the same way before its bytes are written through its
 *   descriptor. A reservation is removed again only while it is still this run's empty file.
 * - Each output is staged as a complete temp file beside its destination, then renamed over it
 *   (or over its reservation; a symlinked spec keeps its link: the rename lands on the link's
 *   target). The identity of what this run installed is the staged file's own (rename keeps the
 *   inode), never a lookup of the destination after the rename.
 * - Immediately before the backup, the rename and each rollback step, the directory and the
 *   destination are checked again: the destination must still be the file the run observed (or
 *   still absent) before publishing. Before a rollback restores or unlinks an output, the run must
 *   still own it: the destination is the inode this run staged (its descriptor is kept open), with
 *   the change time it had right after the rename and exactly the bytes this run wrote, read back
 *   through that descriptor. An edit in place changes the change time, which no writer can set,
 *   and its bytes; size and modification time are not proof.
 * - stdout is part of the transaction: the backups are kept until the stdout write has completed
 *   (its callback, not its return), which is the commit. If a step before it fails, every
 *   published output is rolled back; bytes another writer put there are left alone and the error
 *   names the conflict.
 * - SIGINT, SIGTERM and SIGHUP are held for the whole publication: a signal that comes before
 *   stdout rolls every output back. One that no host listener received (it would end the process)
 *   also does not wait for a pending stdout write: the outputs are rolled back and the signal is
 *   raised again. A host that handles a signal during the stdout write keeps running, so the write
 *   is awaited and commits as usual. A run that writes no file holds no signal. When the run
 *   yields to the event loop before stdout, every protected path is checked again.
 *
 * Residual: POSIX has no compare-and-swap rename, so a replacement made between the last check
 * and the rename (a window of one system call) is not detected. A run that cannot clean up (killed
 * by SIGKILL, a crash) can leave an empty reservation at an output's own name or a staged temp
 * file beside it; output bytes never become reachable through a protected name, because every
 * name that holds them was checked while it was still empty.
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

type Alias = "same" | "distinct" | "unknown";

/** True when `found` is the inode `own` names. */
function sameInode(found: BigIntStats, own: BigIntStats): boolean {
  return found.dev === own.dev && found.ino === own.ino;
}

/**
 * Whether the directory `anchor` folds the entry names `a` and `b` together, judged by a probe of
 * other names: the run creates a probe whose name ends in `a` (O_EXCL) and looks up the same name
 * ending in `b`. The same inode is a fold and anything but a failed lookup unknown; both refuse
 * before publication. A failed lookup proves nothing about `a` and `b` themselves (vfat gives
 * each long name its own short alias), so "distinct" only means "not refused here" and the
 * publication guard decides. The probe never takes either destination name, so a probe that
 * cannot be removed or is interrupted leaves no placeholder there. It is removed while still ours.
 */
function probeNames(anchor: Anchor, a: string, b: string): Alias {
  if (!stillAnchored(anchor)) return "unknown";
  const prefix = `.apifn-probe-${process.pid}-${randomBytes(4).toString("hex")}-`;
  const probe = path.join(anchor.dir, prefix + a);
  let fd: number;
  try {
    fd = openSync(probe, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    return "unknown";
  }
  const own = fstatSync(fd, BIG);
  try {
    const found = lstatSync(path.join(anchor.dir, prefix + b), BIG);
    return sameInode(found, own) && stillAnchored(anchor) ? "same" : "unknown";
  } catch (error) {
    return isMissingPath(error) && stillAnchored(anchor) ? "distinct" : "unknown";
  } finally {
    try {
      if (sameInode(lstatSync(probe, BIG), own)) unlinkSync(probe);
    } catch {
      // Already gone or replaced: another process's file is left alone.
    }
    closeSync(fd);
  }
}

/**
 * Whether two write locations are one file:
 * - both exist: inode identity alone decides (distinct inodes are never one file);
 * - exactly one exists: the failed lookup of the other already shows its name reaches no file
 *   there, so they are distinct;
 * - both missing: one file when bound to one directory under the same name. Names that differ
 *   only in case or Unicode normalization are probed at their first differing component in that
 *   directory (probeNames). A difference below a directory that does not exist yet has no
 *   directory to probe, so the answer is unknown.
 * "distinct" only means "not refused before publication": publish checks the outcome.
 */
function aliasOf(a: Location, b: Location): Alias {
  if (a.leaf !== null && b.leaf !== null) return a.leaf.dev === b.leaf.dev && a.leaf.ino === b.leaf.ino ? "same" : "distinct";
  if (a.leaf !== null || b.leaf !== null) return "distinct";
  if (a.anchor.dev !== b.anchor.dev || a.anchor.ino !== b.anchor.ino) return "distinct";
  if (a.rest === b.rest) return "same";
  if (foldPath(a.rest) !== foldPath(b.rest)) return "distinct";
  const partsA = a.rest.split(path.sep);
  const partsB = b.rest.split(path.sep);
  if (partsA.length !== partsB.length || partsA[0] === partsB[0]) return "unknown";
  const first = probeNames(a.anchor, partsA[0], partsB[0]);
  if (first !== "same") return first;
  return partsA.slice(1).join(path.sep) === partsB.slice(1).join(path.sep) ? "same" : "unknown";
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
          `${output.role} may be ${other.role}: its names differ only in case or Unicode normalization, and a probe in ${location.anchor.dir} cannot show whether the directory there folds them; pick another file.`,
        );
      }
    }
  }
}

/**
 * A path publication must leave as it found it: an input or the spec when the run does not write
 * it. `observed` is its state when the run read it (null when missing).
 */
export interface Guarded {
  /** How errors name the file, such as "the spec .apifn/openapi.yml". */
  role: string;
  /** The path as the run was given it: it must still lead to `destination`. */
  file: string;
  destination: string;
  observed: FileState;
}

/** `file` guarded at the destination a write would reach, in the state it is in now. */
export function guardOf(role: string, file: string): Guarded {
  const destination = writeDestination(file);
  return { role, file, destination, observed: currentState(destination) };
}

/** A step of the publisher, for tests that change the filesystem between steps (`mkdir`: after
 * the run created one directory for a destination, named in place of the destination;
 * `reserved`: right after an empty reservation was created at a missing destination;
 * `installed`: right after an output was renamed into place). */
export type PublishStep = "mkdir" | "reserved" | "backup" | "rename" | "installed" | "rollback";
export type PublishHook = (step: PublishStep, destination: string) => void;

interface Staged {
  output: PlannedOutput;
  destination: string;
  before: FileState;
  /** The empty file this run created at a missing destination, until the rename replaces it. */
  reserved?: FileState;
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
function makeParents(staged: Staged, hook: PublishHook | undefined, verify: Verify): void {
  const missing: string[] = [];
  for (let dir = path.dirname(staged.destination); !existsSync(dir) && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    missing.unshift(dir);
  }
  for (const dir of missing) {
    mkdirSync(dir);
    staged.created.unshift(anchorOf(dir));
    hook?.("mkdir", dir);
    verify(staged);
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
 * True while the directories bound for this output are still the ones the run observed and each
 * created directory is still the one this run made.
 */
function dirsHold(staged: Staged): boolean {
  return (
    stillAnchored(staged.anchor) &&
    (staged.parent === undefined || stillAnchored(staged.parent)) &&
    staged.created.every(stillAnchored)
  );
}

/** dirsHold, and the path the user gave still leads to the bound destination. */
function placeHolds(staged: Staged): boolean {
  return dirsHold(staged) && sameDestination(staged.output.file, staged.destination);
}

function changed(staged: Staged): CheckUsageError {
  return new CheckUsageError(`${staged.destination} changed while apifn check ran; ${staged.output.option} wrote nothing.`);
}

/** What the destination of `staged` must be now: what the run installed there, or the observed
 * file (with a backup link's change time) or absence. */
function expectedNow(staged: Staged): FileState {
  if (staged.published) return staged.installed as FileState;
  return staged.backup === undefined ? heldNow(staged) : expectedBeforeRename(staged);
}

/** What the destination holds before this run publishes there: its reservation or the observed file. */
function heldNow(staged: Staged): FileState {
  return staged.reserved ?? staged.before;
}

/** Checks, after a change the run made for `staged`, that no protected path changed. */
type Verify = (staged: Staged) => void;

function verifier(all: Staged[], guarded: Guarded[]): Verify {
  return (staged) => {
    const reached = (role: string, destination: string) =>
      new CheckUsageError(
        `${staged.output.option} reached ${role} (${destination}) while apifn check wrote it: the filesystem treats the two names as one file, or another process changed it; pick another file.`
      );
    for (const guard of guarded) {
      const holds = sameDestination(guard.file, guard.destination) && sameState(currentState(guard.destination), guard.observed);
      if (!holds) throw reached(guard.role, guard.destination);
    }
    for (const other of all) {
      // Each output's own path must still lead to its bound destination, too (placeHolds).
      if (!placeHolds(other) || !sameState(currentState(other.destination), expectedNow(other))) {
        throw reached(`the output of ${other.output.option}`, other.destination);
      }
    }
  };
}

/**
 * Creates the destination's directories and, when the destination is missing, an empty
 * reservation there (O_EXCL), then checks every protected path before any output holds bytes.
 */
function reserve(staged: Staged, hook: PublishHook | undefined, verify: Verify): void {
  if (!stillAnchored(staged.anchor)) throw changed(staged);
  makeParents(staged, hook, verify);
  if (!placeHolds(staged)) throw changed(staged);
  staged.parent = anchorOf(path.dirname(staged.destination));
  if (staged.before !== null) return;
  const fd = openSync(staged.destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    staged.reserved = stateOf(fstatSync(fd, BIG));
  } finally {
    closeSync(fd);
  }
  hook?.("reserved", staged.destination);
  verify(staged);
}

/** Removes the reservation while it is still this run's empty file; another writer's is kept. */
function releaseReservation(staged: Staged): string | null {
  if (staged.reserved === undefined) return null;
  const now = currentState(staged.destination);
  if (now === null) return null;
  if (!dirsHold(staged) || !sameState(now, staged.reserved)) {
    return `${staged.destination} changed after apifn check reserved it, so it was left as it is.`;
  }
  unlinkSync(staged.destination);
  return null;
}

/** Stages the output's bytes in a temp file that was checked while still empty. */
function stage(staged: Staged, verify: Verify): void {
  if (!placeHolds(staged)) throw changed(staged);
  const temp = tempName(staged.destination);
  const fd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o666);
  staged.temp = temp;
  staged.fd = fd;
  verify(staged);
  if (staged.before !== null) fchmodSync(fd, staged.before.mode & 0o7777);
  writeFileSync(fd, staged.bytes);
  fsyncSync(fd);
  staged.installed = stateOf(fstatSync(fd, BIG));
  verify(staged);
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
 * inode with the same change time as right after the rename, holding exactly the bytes written, in
 * the bound directories. Rollback acts on the bound destination only, so a path the user gave that
 * now leads elsewhere (a link retargeted) does not stop it from undoing this run's write there.
 */
function stillOwned(staged: Staged): boolean {
  if (!dirsHold(staged) || staged.fd === undefined) return false;
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
  return staged.linked ? (staged.backupState as FileState) : heldNow(staged);
}

/** Renames the staged file over the destination, re-checking the place before each step. */
function install(staged: Staged, hook: PublishHook | undefined, verify: Verify): void {
  hook?.("backup", staged.destination);
  if (!placeHolds(staged) || !sameState(currentState(staged.destination), heldNow(staged))) throw changed(staged);
  backUp(staged);
  verify(staged);
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
  hook?.("installed", staged.destination);
  verify(staged);
}

/** Undoes one published output while the destination still holds exactly what this run installed. */
function rollBack(staged: Staged, hook: PublishHook | undefined): string | null {
  if (!staged.published) {
    removeQuietly(staged.temp);
    removeQuietly(staged.backup);
    const conflict = releaseReservation(staged);
    removeCreatedDirs(staged);
    return conflict;
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

const HELD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The signal recorders of the publications running now. */
const RECORDERS = new Set<unknown>();

/**
 * Lets the event loop pass its poll phase once, so a held signal already raised reaches its
 * listener (an immediate scheduled during the poll phase runs before the loop polls again).
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

interface HeldSignals {
  /** The first held signal so far. */
  received: () => NodeJS.Signals | undefined;
  /** Settles with the first held signal no host listener received (it would end the process). */
  arrived: Promise<NodeJS.Signals>;
  release: () => void;
}

/**
 * Records SIGINT, SIGTERM and SIGHUP until `release`, which removes the recorder and raises again
 * each signal that no other listener had (an embedding host's, a one-shot one included), so it
 * keeps its default action.
 */
function holdSignals(): HeldSignals {
  let received: NodeJS.Signals | undefined;
  const unhandled = new Set<NodeJS.Signals>();
  let notify: (signal: NodeJS.Signals) => void = () => {};
  const arrived = new Promise<NodeJS.Signals>((resolve) => {
    notify = resolve;
  });
  // The recorder runs first, so the other listeners present now are exactly those this delivery
  // reaches (a one-shot one included); another publication's recorder is not a host's.
  const record = (signal: NodeJS.Signals) => {
    received ??= signal;
    if (process.listeners(signal).some((listener) => !RECORDERS.has(listener))) return;
    unhandled.add(signal);
    notify(signal);
  };
  RECORDERS.add(record);
  for (const signal of HELD_SIGNALS) process.prependListener(signal, record);
  return {
    received: () => received,
    arrived,
    release: () => {
      for (const signal of HELD_SIGNALS) process.removeListener(signal, record);
      RECORDERS.delete(record);
      for (const signal of unhandled) process.kill(process.pid, signal);
    },
  };
}

/**
 * Publishes the outputs (in order), then awaits `emit` (stdout). After every change it makes, the
 * guarded paths and the other outputs must be as expected (see the module comment). Any failure,
 * including one stdout reports after its write returned, or a held signal that arrived before the
 * commit, rolls back what was published and throws a CheckUsageError (a held signal is then
 * raised again).
 */
export async function publish(
  outputs: PlannedOutput[],
  guarded: Guarded[],
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
  // A run that writes no file has nothing to roll back: it leaves signals alone.
  const signals: HeldSignals =
    all.length > 0 ? holdSignals() : { received: () => undefined, arrived: new Promise(() => {}), release: () => {} };
  try {
    await publishAll(all, verifier(all, guarded), emit, hook, signals);
  } finally {
    for (const staged of all) if (staged.fd !== undefined) closeSync(staged.fd);
    // A signal that came during the last synchronous steps (a failure path too) is recorded now.
    await nextTurn();
    signals.release();
  }
}

/** Runs `step` for each output; a failure rolls back every output. */
function eachOutput(all: Staged[], hook: PublishHook | undefined, step: (staged: Staged) => void): void {
  for (const staged of all) {
    try {
      step(staged);
    } catch (error) {
      throw rollBackAll(all, writeFailure(staged, error), hook);
    }
  }
}

async function publishAll(
  all: Staged[],
  verify: Verify,
  emit: () => void | Promise<void>,
  hook: PublishHook | undefined,
  signals: HeldSignals
): Promise<void> {
  const interrupted = (signal: NodeJS.Signals) =>
    rollBackAll(all, new CheckUsageError(`apifn check received ${signal} while it wrote its outputs.`), hook);
  // When the run yields to the event loop before stdout, a held signal can arrive and another
  // process can act: after the yield, roll back on a signal and check every protected path again.
  const checkpoint = async () => {
    await nextTurn();
    const signal = signals.received();
    if (signal !== undefined) throw interrupted(signal);
    const last = all.at(-1);
    if (last === undefined) return;
    try {
      verify(last);
    } catch (error) {
      throw rollBackAll(all, writeFailure(last, error), hook);
    }
  };
  // Reservation, staging and installation run in one synchronous stretch.
  eachOutput(all, hook, (staged) => reserve(staged, hook, verify));
  eachOutput(all, hook, (staged) => stage(staged, verify));
  eachOutput(all, hook, (staged) => install(staged, hook, verify));
  await checkpoint();
  // A stdout write can wait on its reader indefinitely: a signal that will end the process does not
  // wait for it. A host that handles the signal keeps running, so the write is awaited.
  const outcome = await Promise.race([
    Promise.resolve()
      .then(emit)
      .then(
        () => ({ done: true as const }),
        (error: unknown) => ({ error })
      ),
    signals.arrived.then((signal) => ({ signal })),
  ]);
  if ("signal" in outcome) throw interrupted(outcome.signal);
  if ("error" in outcome) {
    throw rollBackAll(all, new CheckUsageError(`Failed to write the report to stdout: ${errorMessage(outcome.error)}`), hook);
  }
  // Committed: the report is delivered, so nothing after this point undoes the outputs it names.
  for (const staged of all) removeQuietly(staged.backup);
}
