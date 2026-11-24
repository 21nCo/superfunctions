/**
 * Safe publication for `apifn check`: the spec repair (`--write`) and the report file.
 *
 * - No output may land on a file the run read (spec, base file, router module, config file) or
 *   on the other output. These guards cover runs that write a file; a stdout-only run makes no
 *   change and reports the inputs as it read them. Separation is an outcome, checked during publication: every protected
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
 *   names the conflict. Temp files and backups are removed (on rollback or at the commit) only
 *   while they are still this run's, in their bound directories: the temp the inode its kept
 *   descriptor names, the backup the inode its kept descriptor names. Every name the run may remove
 *   (temp, backup, reservation, created directory) has its inode held open until publish ends, so a
 *   freed inode number cannot pass to another writer's file. Only a file the run can read whole is replaced;
 *   right before a backup is restored or removed, its held inode, its bytes and then its name are re-checked.
 * - Cancellation is an AbortSignal, never a process signal: this module installs, inspects,
 *   removes and raises no process signal listener, so an embedding host's own handling is left
 *   alone. An abort before the commit rolls every output back (checked after each step and after
 *   the yield before stdout); one while the stdout write is pending abandons that write and rolls
 *   back. Both exit 2. `onPublishing` reports when files are being written. The standalone binary
 *   (signals.ts) alone handles SIGINT, SIGTERM and SIGHUP: while files are being written it turns
 *   one into an abort and raises it again once the rollback is done; otherwise it keeps its default
 *   action at once. When the run yields to the event
 *   loop before stdout, every protected path is checked again.
 *
 * Residual: POSIX has no compare-and-swap rename, so a replacement made between the last check
 * and the rename (a window of one system call) is not detected. Node has no mkdirat either: a
 * directory swapped in between the run's mkdir and its open of that name (one system call) is held
 * as the run's; rollback removes it only while it is empty. A run that cannot clean up (killed
 * by SIGKILL, a crash) can leave an empty reservation at an output's own name or a staged temp
 * file beside it; output bytes never become reachable through a protected name, because every
 * name that holds them was checked while it was still empty.
 */

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_SPEC_BYTES } from "./check-parse.js";
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
  let own: BigIntStats | undefined;
  try {
    own = fstatSync(fd, BIG);
    const found = lstatSync(path.join(anchor.dir, prefix + b), BIG);
    return sameInode(found, own) && stillAnchored(anchor) ? "same" : "unknown";
  } catch (error) {
    return own !== undefined && isMissingPath(error) && stillAnchored(anchor) ? "distinct" : "unknown";
  } finally {
    try {
      if (own !== undefined && stillAnchored(anchor) && sameInode(lstatSync(probe, BIG), own)) unlinkSync(probe);
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

/** Where a path the run reads leads (symlinks followed) and the state it had when the run read it. */
export interface Bound {
  destination: string;
  observed: FileState;
}

/**
 * Binds `file` before the run reads it: where it leads and its state now. Taken before the read
 * (a module import, which reports no state of its own), a change made during or after the read
 * no longer matches at publication.
 */
export function bindBeforeRead(file: string): Bound {
  const destination = writeDestination(file);
  return { destination, observed: currentState(destination) };
}

/**
 * A path publication must leave as it found it: an input or the spec when the run does not write
 * it. `observed` is its state when the run read it (null when missing), bound at the read, never
 * looked up again when publication starts.
 */
export interface Guarded extends Bound {
  /** How errors name the file, such as "the spec .apifn/openapi.yml". */
  role: string;
  /** The path as the run was given it: it must still lead to `destination`. */
  file: string;
}

/** True while `guard`'s path still leads to its destination, in the state the run read. */
function guardHolds(guard: Guarded): boolean {
  return sameDestination(guard.file, guard.destination) && sameState(currentState(guard.destination), guard.observed);
}

/** Exit 2 before anything is written or printed when an input changed after the run read it. */
function assertInputsUnchanged(guarded: Guarded[]): void {
  const broken = guarded.find((guard) => !guardHolds(guard));
  if (broken === undefined) return;
  throw new CheckUsageError(
    `${broken.role} (${broken.destination}) changed after apifn check read it; nothing was written or printed.`
  );
}

/** A step of the publisher, for tests that change the filesystem between steps (`mkdir`: after
 * the run created one directory for a destination, named in place of the destination;
 * `reserved`: right after an empty reservation was created at a missing destination;
 * `staged`: right after an output's bytes were written to its temp file; `installed`: right after an
 * output was renamed into place; `committed`: after stdout completed,
 * before the backups are removed). */
export type PublishStep = "mkdir" | "reserved" | "staged" | "backup" | "rename" | "installed" | "rollback" | "committed";
export type PublishHook = (step: PublishStep, destination: string) => void;

interface Staged {
  output: PlannedOutput;
  destination: string;
  before: FileState;
  /** The empty file this run created at a missing destination, until the rename replaces it. */
  reserved?: FileState;
  /** The reservation's descriptor, recorded as soon as it exists. */
  reservedFd?: number;
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
  /** True when the backup is a hard link to the observed file (not a copy); only a file the run read whole is backed up. */
  linked?: boolean;
  /** The backup's inode, open until publish ends (an open inode's number is never reused), and a copy's bytes. */
  backupFd?: number;
  previous?: Buffer;
  /** The observed bytes' SHA-256, read through the held descriptor before the link. */
  digest?: string | null;
  /** Descriptors that pin the reservation and each created directory until publish ends. */
  held: number[];
  published: boolean;
}

function tempName(destination: string): string {
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  return path.join(path.dirname(destination), `.${path.basename(destination)}.apifn-${suffix}.tmp`);
}

/** Same device and inode (both present). */
function sameFile(a: FileState, b: FileState): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/** Unlinks `file`; a name already gone is fine, any other failure is reported. */
function unlinkReported(file: string): string | null {
  try {
    unlinkSync(file);
    return null;
  } catch (error) {
    return isMissingPath(error) ? null : `Failed to remove ${file}: ${errorMessage(error)}`;
  }
}

/** Removes the staged temp file while it is the inode open as `staged.fd`, in the bound directories; another writer's is left and named. */
function removeTemp(staged: Staged): string | null {
  const temp = staged.temp;
  if (temp === undefined) return null;
  const now = currentState(temp);
  const held = dirsHold(staged);
  if (held && now === null) return null;
  if (!held || staged.fd === undefined || !sameFile(now, stateOf(fstatSync(staged.fd, BIG)))) {
    return `${temp}, apifn check's temp file, or its directory changed while apifn check ran, so it was left as it is.`;
  }
  staged.temp = undefined;
  return unlinkReported(temp);
}

/** Right before a restore or removal: the held inode's content identity (a link's change time moves when
 * the shared destination is renamed over), its bytes, its state unchanged across that read, then its name in that state. */
function backupVerified(staged: Staged): FileState | false {
  const made = staged.backupState;
  const fd = staged.backupFd;
  if (staged.backup === undefined || !made || fd === undefined || !dirsHold(staged)) return false; // never made: not this run's
  const was = stateOf(fstatSync(fd, BIG));
  // A copy is this run's own inode, so its change time is too; a link's mode must still be the recorded one.
  if (staged.linked ? !sameContent(was, made) || was?.mode !== made.mode : !sameState(was, made)) return false;
  // An incomplete copy (its write failed) is never restored: its unchanged state is all that is checked.
  const intact = staged.linked ? typeof staged.digest === "string" && digestOf(fd) === staged.digest : staged.previous === undefined || holdsBytes(fd, staged.previous);
  const read = stateOf(fstatSync(fd, BIG)); // an edit, even one restoring the mtime, changes the change time
  return intact && sameState(read, was) && sameState(currentState(staged.backup), read) && read; // the verified state
}

/** The SHA-256 of the file open as `fd`, read from its start; null when it cannot be read through `fd`
 * or holds more than MAX_SPEC_BYTES (no read goes past that bound): such a file is never replaced. */
function digestOf(fd: number): string | null {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  try {
    let at = 0;
    for (let count = 0; at <= MAX_SPEC_BYTES && (count = readSync(fd, chunk, 0, chunk.length, at)) > 0; at += count) hash.update(chunk.subarray(0, count));
    return at > MAX_SPEC_BYTES ? null : hash.digest("hex");
  } catch {
    return null;
  }
}

/** Removes the backup while it is still this run's (backupVerified); another writer's is left and named. */
function removeBackup(staged: Staged): string | null {
  const backup = staged.backup;
  if (backup === undefined) return null;
  if (currentState(backup) === null && dirsHold(staged)) return null;
  if (!backupVerified(staged)) {
    return `${backup}, apifn check's backup of ${staged.destination}, or its directory changed while apifn check ran, so it was left as it is.`;
  }
  staged.backup = undefined;
  return unlinkReported(backup);
}

/**
 * Removes the directories this run created for a destination, deepest first, while empty and
 * still the directory this run created; one left behind (another process's replacement, or one
 * rmdir refused) is named.
 */
function removeCreatedDirs(staged: Staged): string | null {
  for (const created of staged.created) {
    // One left behind is named, with the created directories above it (gone already leaves nothing).
    const left = `${created.dir}, a directory apifn check created, and those it created above it were left as they are`;
    if (!stillAnchored(created)) {
      if (currentState(created.dir) === null) continue;
      return `${left}: it is no longer the directory apifn check created.`;
    }
    try {
      rmdirSync(created.dir);
    } catch (error) {
      return `${left}: ${errorMessage(error)}`;
    }
  }
  return null;
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
    // Bound without following a link: a name swapped for a link or file is never recorded or removed.
    const made = holdDir(staged, dir);
    if (!made.isDirectory()) throw changed(staged);
    staged.created.unshift({ dir, dev: made.dev, ino: made.ino });
    hook?.("mkdir", dir);
    verify(staged);
  }
}

/** Opens a directory this run created without following a link and keeps it open (POSIX), so its
 * identity cannot pass to another directory while the run may remove it. Windows cannot open a directory
 * here; its file ID carries a sequence number that a reused file record changes. */
function holdDir(staged: Staged, dir: string): BigIntStats {
  if (process.platform === "win32") return lstatSync(dir, BIG);
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  staged.held.push(fd);
  return fstatSync(fd, BIG);
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
      if (!guardHolds(guard)) throw reached(guard.role, guard.destination);
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
  staged.held.push(fd);
  staged.reservedFd = fd;
  staged.reserved = stateOf(fstatSync(fd, BIG));
  hook?.("reserved", staged.destination);
  verify(staged);
}

/** Removes the reservation while it is still this run's empty file (its held inode); another writer's is kept. */
function releaseReservation(staged: Staged): string | null {
  if (staged.reservedFd === undefined) return null;
  const now = currentState(staged.destination);
  if (now === null) return null;
  const own = stateOf(fstatSync(staged.reservedFd, BIG));
  if (!dirsHold(staged) || !sameFile(now, own) || !sameState(now, staged.reserved ?? own) || now.size !== 0n) {
    return `${staged.destination} changed after apifn check reserved it, so it was left as it is.`;
  }
  unlinkSync(staged.destination);
  return null;
}

/** Stages the output's bytes in a temp file that was checked while still empty. */
function stage(staged: Staged, hook: PublishHook | undefined, verify: Verify): void {
  if (!placeHolds(staged)) throw changed(staged);
  const temp = tempName(staged.destination);
  const fd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o666);
  staged.temp = temp;
  staged.fd = fd;
  verify(staged);
  if (staged.before !== null) fchmodSync(fd, staged.before.mode & 0o7777);
  writeFileSync(fd, staged.bytes);
  fsyncSync(fd);
  hook?.("staged", staged.destination);
  // The identity recorded is of the bytes this run wrote, read back while the file's state held still.
  const written = stateOf(fstatSync(fd, BIG));
  if (!holdsBytes(fd, staged.bytes) || !sameState(stateOf(fstatSync(fd, BIG)), written)) throw changed(staged);
  staged.installed = written;
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

/** Backs the observed file up: a hard link to the observed inode itself, or a new O_EXCL copy written and read through its
 * descriptor. A backup name that holds anything else is another writer's: the run stops, and rollback leaves and names it. */
function backUp(staged: Staged): void {
  const before = staged.before;
  if (before === null) return;
  const backup = tempName(staged.destination).replace(/\.tmp$/, ".bak");
  staged.backup = backup;
  // The observed file is opened (never blocking, never through a link) before the link: the link must be that very inode.
  staged.backupFd = openHeld(staged);
  // The digest of the observed bytes, read before the link with the descriptor's state unchanged across it.
  const held = (fd: number) => sameState(stateOf(fstatSync(fd, BIG)), before);
  if (!held(staged.backupFd)) throw changed(staged);
  staged.digest = digestOf(staged.backupFd);
  if (!held(staged.backupFd)) throw changed(staged);
  // Only a file this run can back up verifiably is replaced: one it cannot read whole is left as it is.
  if (staged.digest === null) throw unverifiable(staged);
  try {
    linkSync(staged.destination, backup);
    staged.linked = true;
  } catch {
    staged.linked = false;
  }
  if (staged.linked) {
    const made = currentState(backup);
    // Not the observed inode, or its mode changed (sameContent ignores mode): never this run's backup, so it is left and named.
    staged.backupState = made?.mode === before.mode && sameContent(made, before) && sameFile(made, stateOf(fstatSync(staged.backupFd, BIG))) ? made : null;
    if (staged.backupState === null) throw changed(staged);
    return;
  }
  const source = staged.backupFd;
  staged.previous = readFileSync(source);
  staged.backupFd = undefined; // cleared first: a close that fails after releasing it is never retried
  closeSync(source);
  const fd = openSync(backup, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  staged.backupFd = fd;
  try {
    fchmodSync(fd, before.mode & 0o7777);
    writeFileSync(fd, staged.previous);
    fsyncSync(fd);
  } catch (error) {
    staged.previous = undefined;
    throw error;
  } finally {
    staged.backupState = stateOf(fstatSync(fd, BIG));
  }
  if (!sameFile(currentState(backup), staged.backupState) || !sameState(currentState(staged.destination), before)) {
    throw changed(staged);
  }
}

/** Opens the observed file for reading to hold its inode; one the run may not read is never replaced. */
function openHeld(staged: Staged): number {
  try {
    return openSync(staged.destination, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw unverifiable(staged);
    throw error;
  }
}

/** The refusal to replace a file the run cannot read whole, so it could neither verify nor restore a backup. */
function unverifiable(staged: Staged): CheckUsageError {
  return new CheckUsageError(`${staged.output.option} would replace ${staged.destination}, which apifn check cannot read whole (no read permission, or more than ${MAX_SPEC_BYTES} bytes), so it could not keep a backup it can verify and restore; that file was left as it is. Make it readable or remove it, then run apifn check again.`);
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
  const verified = staged.backup !== undefined && backupVerified(staged); // read first: never replace without a restorable backup
  if (staged.backup !== undefined && !verified) throw changed(staged);
  if (!placeHolds(staged) || !sameState(currentState(staged.destination), expectedBeforeRename(staged))) {
    throw changed(staged);
  }
  if (!sameState(currentState(staged.temp as string), staged.installed as FileState)) throw changed(staged);
  if (verified && !sameState(currentState(staged.backup as string), verified)) throw changed(staged);
  renameSync(staged.temp as string, staged.destination);
  staged.temp = undefined;
  staged.published = true;
  // The rename changes the change time of the installed inode and, by dropping a link, of the
  // backup's link: record both now, the installed one through the descriptor (a copy keeps its own).
  staged.installed = stateOf(fstatSync(staged.fd as number, BIG));
  const backupNow = staged.linked ? stateOf(fstatSync(staged.backupFd as number, BIG)) : null; // adopted only unchanged
  if (sameContent(backupNow, staged.backupState as FileState)) staged.backupState = backupNow;
  hook?.("installed", staged.destination);
  verify(staged);
}

/** Undoes one published output while the destination still holds exactly what this run installed. */
function rollBack(staged: Staged, hook: PublishHook | undefined): string | null {
  if (!staged.published) {
    // Each cleanup step runs on its own: a failure in one is named and never skips the others.
    const conflicts: string[] = [];
    for (const step of [removeTemp, removeBackup, releaseReservation, removeCreatedDirs]) {
      try {
        const conflict = step(staged);
        if (conflict !== null) conflicts.push(conflict);
      } catch (error) {
        conflicts.push(`Failed to clean up after ${staged.destination}: ${errorMessage(error)}`);
      }
    }
    return conflicts.length === 0 ? null : conflicts.join(" ");
  }
  hook?.("rollback", staged.destination);
  if (!stillOwned(staged)) {
    let kept = "";
    if (staged.backup !== undefined) {
      // A backup is named as the recovery file only while it still holds the previous bytes.
      kept = backupVerified(staged)
        ? ` Its previous bytes are in ${staged.backup}.`
        : ` Its backup ${staged.backup} changed or is gone too, so it holds no copy of the previous bytes apifn check can vouch for.`;
    }
    return `${staged.destination} changed after apifn check wrote it, so it was left as it is.${kept}`;
  }
  if (staged.backup) {
    // Verified right before the rename: a backup swapped or edited since is never installed.
    const verified = backupVerified(staged);
    if (!verified) {
      return `${staged.backup}, apifn check's backup of ${staged.destination}, changed or is gone, so ${staged.destination} was left with the bytes apifn check wrote and the backup was left as it is.`;
    }
    // The destination again after the backup's read: one replaced meanwhile is left as it is.
    if (!sameState(currentState(staged.destination), staged.installed as FileState)) return `${staged.destination} changed after apifn check wrote it, so it was left as it is. Its previous bytes are in ${staged.backup}.`;
    if (!sameState(currentState(staged.backup), verified)) return `${staged.backup}, apifn check's backup of ${staged.destination}, changed, so both were left as they are.`;
    renameSync(staged.backup, staged.destination);
  } else {
    unlinkSync(staged.destination);
    return removeCreatedDirs(staged);
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
  // An abort says nothing it wrote is kept only when every rollback step left nothing behind.
  const outcome = error instanceof AbortedRun && problems.length === 0 ? ["No output it wrote is kept."] : problems;
  return new CheckUsageError([error.message, ...outcome].join(" "));
}

function writeFailure(staged: Staged, error: unknown): CheckUsageError {
  if (error instanceof CheckUsageError) return error;
  return new CheckUsageError(`Failed to write ${staged.output.noun} ${staged.output.file}: ${errorMessage(error)}`);
}

/**
 * Lets the event loop pass its poll phase once, so a signal already raised reaches the binary's
 * listener and aborts (an immediate scheduled during the poll phase runs before the loop polls
 * again).
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/**
 * Publishes the outputs (in order), then awaits `emit` (stdout), checking the guarded paths and other outputs after every
 * change (see the module comment). Any failure before the commit, a stdout failure or an abort of `signal` included, rolls
 * back what was published and throws a CheckUsageError. Returns notices for entries the commit left alone.
 */
export async function publish(
  outputs: PlannedOutput[],
  guarded: Guarded[],
  emit: () => void | Promise<void>,
  hook?: PublishHook,
  signal?: AbortSignal,
  onPublishing?: (publishing: boolean) => void
): Promise<string[]> {
  // An input that changed after the run read it fails the run before any change or output.
  assertInputsUnchanged(guarded);
  const all: Staged[] = outputs.map((output) => ({
    output,
    destination: output.target.destination,
    before: output.observed,
    anchor: output.target.anchor,
    bytes: Buffer.from(output.text, "utf8"),
    created: [],
    held: [],
    published: false,
  }));
  const notices: string[] = [];
  // Only a run that writes files has anything to roll back on an abort.
  if (all.length > 0) onPublishing?.(true);
  try {
    notices.push(...(await publishAll(all, verifier(all, guarded), guarded, emit, hook, signal)));
    return notices;
  } finally {
    // A close failure (each temp was fsynced) never changes the verdict: after the commit it is a notice.
    for (const staged of all) for (const fd of [staged.fd, staged.backupFd, ...staged.held]) if (fd !== undefined) try { closeSync(fd); } catch (error) { notices.push(`Failed to close a descriptor apifn check held for ${staged.destination}: ${errorMessage(error)}`); }
    try { // after the verdict is settled, a throwing callback is a notice
      if (all.length > 0) onPublishing?.(false);
    } catch (error) { notices.push(`The onPublishing callback failed after apifn check finished writing: ${errorMessage(error)}`); }
  }
}

/** An abort before the commit; rollBackAll states what of the run's output was kept. */
class AbortedRun extends CheckUsageError {}

function abortError(signal: AbortSignal): CheckUsageError {
  const why = typeof signal.reason === "string" ? `received ${signal.reason}` : "was aborted";
  return new AbortedRun(`apifn check ${why} before its report was delivered.`);
}

/** Settles when `signal` aborts (never without one); `stop` removes its listener. */
function abortOf(signal: AbortSignal | undefined): { aborted: Promise<void>; stop: () => void } {
  let stop = () => {};
  const aborted = new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    stop = () => signal.removeEventListener("abort", onAbort);
  });
  return { aborted, stop };
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
  guarded: Guarded[],
  emit: () => void | Promise<void>,
  hook: PublishHook | undefined,
  signal: AbortSignal | undefined
): Promise<string[]> {
  if (signal?.aborted) throw abortError(signal);
  // Every check after a change also stops on an abort: the outputs are then rolled back.
  const checked: Verify = (staged) => {
    if (signal?.aborted) throw abortError(signal);
    verify(staged);
  };
  // When the run yields to the event loop before stdout, an abort can arrive and another process
  // can act: after the yield, roll back on an abort and check every protected path again.
  const checkpoint = async () => {
    await nextTurn();
    const last = all.at(-1);
    if (signal?.aborted && last === undefined) throw abortError(signal);
    if (last === undefined) {
      assertInputsUnchanged(guarded);
      return;
    }
    try {
      checked(last);
    } catch (error) {
      throw rollBackAll(all, writeFailure(last, error), hook);
    }
  };
  // Reservation, staging and installation run in one synchronous stretch.
  eachOutput(all, hook, (staged) => reserve(staged, hook, checked));
  eachOutput(all, hook, (staged) => stage(staged, hook, checked));
  eachOutput(all, hook, (staged) => install(staged, hook, checked));
  await checkpoint();
  // A stdout write can wait on its reader indefinitely: an abort does not wait for it.
  const abort = abortOf(signal);
  let outcome: { done: true } | { error: unknown } | { aborted: true };
  try {
    outcome = await Promise.race([
      Promise.resolve()
        .then(emit)
        .then(
          () => ({ done: true as const }),
          (error: unknown) => ({ error })
        ),
      abort.aborted.then(() => ({ aborted: true as const })),
    ]);
  } finally {
    abort.stop();
  }
  if ("aborted" in outcome) throw rollBackAll(all, abortError(signal as AbortSignal), hook);
  if ("error" in outcome) {
    throw rollBackAll(all, new CheckUsageError(`Failed to write the report to stdout: ${errorMessage(outcome.error)}`), hook);
  }
  // Committed: the report is delivered, so nothing after this point undoes the outputs it names.
  // A backup another writer replaced is left alone; the returned notices name it.
  hook?.("committed", all.at(-1)?.destination ?? "");
  // Each backup is cleaned up on its own: a failure there is a notice, never a change of verdict.
  return all
    .map((staged) => {
      try {
        return removeBackup(staged);
      } catch (error) {
        return `Failed to remove ${staged.backup}, apifn check's backup of ${staged.destination}: ${errorMessage(error)}`;
      }
    })
    .filter((notice): notice is string => notice !== null);
}
