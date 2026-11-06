import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { processBirthSignature, processIdentityStatus, resolveContainedPath, type DevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";

import { DEFAULT_RUNTIME, isNamedRuntime, resolveInstanceIdentity } from "./identity.js";
import { checkoutReceipts, devfnStateDirectories, runtimeDirectory, runtimeOutputPath, STATE_DIRECTORY_ENTRY } from "./runtime.js";
import { DevFnError, type InstanceIdentity, type LifecycleReceipt } from "./types.js";

/**
 * The environment-output files one instance of a checkout claims and has
 * written, as canonical paths. `targets` are held while the DevFn process
 * that claimed them runs or the instance's receipt is not stopped; down
 * empties them. `written` remembers every file the instance wrote with the
 * digest of what it last wrote there, so a named runtime keeps rewriting its
 * own unchanged files and no one else's. `pending` records a file a named
 * runtime is about to create or replace with the digest of its new content,
 * before any of it can reach the file: an interrupted write leaves no file,
 * the content it last wrote or the content it intended (both its own), or
 * someone else's file. `runtimeDirectory` is the canonical runtime directory
 * the claimant writes its logs and runtime.env to, held like its targets.
 * `recorded` keeps, like `written`, every runtime directory it claimed and every state directory inside the checkout it started in (task-input attribution); `made`, every directory DevFn created for it, recorded before creation (a task input only beyond attributed state); `replaced`, the outputs its receipt recorded when this claim replaced it (staging cleanup).
 */
interface WrittenOutput { target: string; sha256: string }

interface OutputClaim {
  version: 1;
  instanceId: string;
  runtime: string;
  targets: string[];
  written: WrittenOutput[];
  pending?: WrittenOutput[];
  runtimeDirectory?: string; recorded?: string[]; made?: string[]; replaced?: string[];
  /** The canonical state directory of the start, recorded before any lease there; only DevFn's entries in it are held unless DevFn made it. */
  stateDir?: string;
  /** In-checkout state directories it uses that a start did not create, recorded before DevFn writes there: their DevFn entries are held by name, kept like `recorded`. */
  shared?: string[];
  pid: number;
  birthSignature?: string;
  createdAt: string;
}

// Claims live among the receipts, a directory DevFn owned in every release,
// so no path an earlier manifest could write to becomes DevFn's.
const CLAIMS = path.join(".devfn", "receipts", "outputs");
const CLAIMS_LOCK = "claims.lock";
// The lock guards a few file operations, so a holder verified dead (pid and
// birth signature) is recovered well within a waiter's budget: a crashed
// runtime never holds up another runtime's start. A live holder is never
// taken over however long it holds the lock.
const CLAIMS_LOCK_TIMEOUT_MS = 30_000;
const CLAIMS_LOCK_STALE_MS = 5_000;
// So are an instance's lifecycle locks, checkout-wide and per state directory.
export const LIFECYCLE_LOCK = { timeoutMs: 30_000, staleMs: CLAIMS_LOCK_STALE_MS };
const INSTANCE_ID = /^[0-9a-f]{12}$/;
// What creating the claims directory and its lock reports while a sibling
// removes the empty directories it created (macOS reports EINVAL for a mkdir
// in a directory being removed), and how often that is retried.
const CLAIMS_SETUP_RACES = new Set(["ENOENT", "EINVAL", "ENOTDIR"]);
const CLAIMS_SETUP_ATTEMPTS = 50;

/** Paths compare case-folded where the default filesystems fold case. */
const pathKey = (value: string): string => process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;

const relativeName = (root: string, target: string): string => path.relative(root, target) || target;

/**
 * A DevFn staging file of an output, `.<file name>.<uuid>.devfn-tmp` beside
 * it: the file name it stages, or undefined for any other name.
 */
const STAGING = /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.devfn-tmp$/;
export const stagedOutputName = (name: string): string | undefined => STAGING.exec(name)?.[1];
const stagingPath = (target: string): string => path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.devfn-tmp`);

/**
 * The file a write to target reaches: a symlink's target, otherwise the
 * realpath of its nearest existing directory joined with the rest.
 */
async function canonicalTarget(target: string, depth = 0): Promise<{ canonical: string; exists: boolean; symlink: boolean }> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    const resolved = await realpath(target).catch(() => undefined);
    if (resolved !== undefined) return { canonical: resolved, exists: true, symlink: true };
    // A dangling link reaches the path its text names once that is created.
    const text = depth < 32 ? await readlink(target).catch(() => undefined) : undefined;
    const reached = text === undefined ? undefined : await canonicalTarget(path.resolve(path.dirname(target), text), depth + 1).catch(() => undefined);
    return { canonical: reached?.canonical ?? path.resolve(target), exists: false, symlink: true };
  }
  const rest = [path.basename(target)];
  let directory = path.dirname(target);
  for (;;) {
    try { return { canonical: path.join(await realpath(directory), ...rest), exists: stat !== undefined, symlink: false }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(directory);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === directory) throw error;
      rest.unshift(path.basename(directory));
      directory = parent;
    }
  }
}

async function claimDirectory(root: string): Promise<string> {
  return await resolveContainedPath(root, CLAIMS, "environmentOutputs");
}

function parseClaim(text: string, instanceId: string): OutputClaim | undefined {
  try {
    const value = JSON.parse(text) as OutputClaim;
    const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string");
    const files = (items: unknown) => Array.isArray(items) &&
      items.every((item: WrittenOutput) => typeof item?.target === "string" && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256));
    if (value.version === 1 && value.instanceId === instanceId && typeof value.runtime === "string" && strings(value.targets) && files(value.written) &&
      (value.pending === undefined || files(value.pending)) && (value.runtimeDirectory === undefined || typeof value.runtimeDirectory === "string") && (value.stateDir === undefined || typeof value.stateDir === "string") && (value.recorded === undefined || strings(value.recorded)) && (value.made === undefined || strings(value.made)) && (value.replaced === undefined || strings(value.replaced)) && (value.shared === undefined || strings(value.shared)) &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === "string") return value;
  } catch { /* Malformed below. */ }
  return undefined;
}

/** Claim records of the checkout by instance; a malformed record cannot be attributed and is refused. */
export async function readClaims(root: string): Promise<Map<string, { claim: OutputClaim; text: string }>> {
  const directory = await claimDirectory(root);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const claims = new Map<string, { claim: OutputClaim; text: string }>();
  for (const name of names) {
    const instanceId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!INSTANCE_ID.test(instanceId)) continue;
    const text = await readFile(path.join(directory, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text === undefined) continue;
    const claim = parseClaim(text, instanceId);
    if (!claim) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment-output claim ${path.join(directory, name)} is malformed, so DevFn cannot tell which files instance ${instanceId} owns; stop that runtime with devfn down, then remove the file.`,
        { instanceId, claim: path.join(directory, name) });
    }
    claims.set(instanceId, { claim, text });
  }
  return claims;
}

async function readOwnClaim(root: string, instanceId: string): Promise<string | undefined> {
  return await readFile(path.join(await claimDirectory(root), `${instanceId}.json`), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function writeClaim(root: string, claim: OutputClaim): Promise<void> {
  const directory = await claimDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${claim.instanceId}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

async function removeClaim(root: string, instanceId: string): Promise<void> {
  await unlink(path.join(await claimDirectory(root), `${instanceId}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

const canonicalKey = async (item: string): Promise<string> => pathKey((await canonicalTarget(item)).canonical);
/** Whether a comparison key is a directory's or lies inside it. */
export const within = (key: string, directory: string): boolean => key === directory || key.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep); // A filesystem root already ends in a separator.

/** Canonical files by comparison key. */
async function addCanonical(files: Map<string, string>, paths: readonly string[] | undefined): Promise<void> {
  for (const item of paths ?? []) {
    const { canonical } = await canonicalTarget(item);
    files.set(pathKey(canonical), canonical);
  }
}

/**
 * The identity of an existing regular file (device and inode, following a
 * link), which every hard link to it shares; undefined for anything else.
 */
async function fileIdentity(file: string): Promise<string | undefined> {
  return (await linkedIdentity(file))?.id;
}

/** A regular file's identity and whether it has more than one name. */
async function linkedIdentity(file: string): Promise<{ id: string; linked: boolean } | undefined> {
  const info = await stat(file, { bigint: true }).catch(() => undefined);
  return info?.isFile() ? { id: `${info.dev}:${info.ino}`, linked: info.nlink > 1n } : undefined;
}

const digest = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

/** Whether a file is a regular file holding exactly the content recorded for it. */
async function holdsRecorded(item: WrittenOutput): Promise<boolean> {
  if (!(await lstat(item.target).catch(() => undefined))?.isFile()) return false;
  const content = await readFile(item.target).catch(() => undefined);
  return content !== undefined && digest(content) === item.sha256;
}

/** Record one written file, replacing an earlier record of the same path. */
const withWritten = (written: readonly WrittenOutput[], item: WrittenOutput): WrittenOutput[] =>
  [...written.filter((entry) => pathKey(entry.target) !== pathKey(item.target)), item].sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);

/** The files an instance wrote: its written history and any interrupted creation or replacement that provably left its intended content. */
async function writtenByClaim(claim: OutputClaim | undefined): Promise<WrittenOutput[]> {
  if (!claim) return [];
  let written = [...claim.written];
  for (const item of claim.pending ?? []) if (await holdsRecorded(item)) written = withWritten(written, item);
  return written;
}

const live = (receipt: LifecycleReceipt | undefined): boolean => receipt !== undefined && receipt.state !== "stopped";

async function claimantRuns(claim: OutputClaim): Promise<boolean> {
  const status = await processIdentityStatus(claim.pid, claim.birthSignature, claim.createdAt);
  return status !== "exited" && status !== "identity-mismatch";
}

/** Task-input attribution of the checkout's instances (`own` starts now, so its earlier outputs are released): `held` are every runtime directory and state directory a start made inside the checkout a receipt or claim records and another's outputs while its live receipt, running claimant or pending write holds them; `released`, every file an instance wrote while it holds what it last wrote there; `shared`, every other state directory inside the checkout they record, of which only DevFn's entries (STATE_DIRECTORY_ENTRY) are held. */
export async function taskAttribution(config: DevFnConfig, root: string, claims: () => Promise<Map<string, { claim: OutputClaim }>>, own?: string): Promise<{ held: string[]; released: string[]; made: string[]; shared: string[] }> {
  const receipts = await checkoutReceipts(config, root), held = [...receipts].flatMap(([id, { receipt }]) => [receipt.runtimeDir, ...id !== own && live(receipt) ? receipt.environmentOutputs ?? [] : []]), released: string[] = [], read = await claims();
  const made = [...receipts].flatMap(([id, { receipt }]) => madeByRelease(receipt, read.get(id)?.claim)); // An earlier release's claimless receipt: its runtime directory's parents, as a claim replacing it records them.
  for (const [id, { claim }] of read) { made.push(...claim.made ?? []); held.push(...claim.runtimeDirectory ? [claim.runtimeDirectory] : [], ...claim.recorded ?? [], ...id === own ? [] : [...(claim.pending ?? []).map((item) => item.target), ...claim.targets.length && await claimantRuns(claim) ? claim.targets : []]); for (const item of await writtenByClaim(claim)) if (await holdsRecorded(item)) released.push(item.target); }
  // A recorded state directory inside the checkout keeps DevFn's entries out, so a user's file there stays an input; one equal to or containing the checkout never hides it.
  const rootKey = pathKey(await realpath(root).catch(() => path.resolve(root))), shared: string[] = [];
  const recordedStateDirs = [...[...receipts.values()].map(({ receipt }) => receipt.stateDir), ...[...read.values()].flatMap(({ claim }) => [claim.stateDir, ...claim.shared ?? []])];
  for (const stateDir of recordedStateDirs) if (stateDir && await canonicalKey(path.resolve(root, stateDir)).then((key) => key !== rootKey && within(key, rootKey))) shared.push(stateDir);
  return { held, released, made, shared };
}

/** What an earlier release made for an instance whose receipt has no claim (its runtime directory's parents): the provenance every first claim of it starts from. */ const madeByRelease = (receipt: LifecycleReceipt | undefined, claim: OutputClaim | undefined): string[] => receipt && !claim ? [path.dirname(receipt.runtimeDir), path.dirname(path.dirname(receipt.runtimeDir))] : [];
/** The trust state @devfn/config writes in a state directory: its record, the record's temp files and its lock. */
const TRUST_STATE = /^trust\.(?:json(?:\..+\.tmp)?|lock)$/;

/** A union of path lists, in first-seen order. */
const union = (...lists: (readonly string[] | undefined)[]): string[] => [...new Set(lists.flatMap((list) => list ?? []))];

/**
 * Create a start's or stop's state directory under the instance's lifecycle lock. A state directory inside the checkout is
 * first recorded in the instance's claim, under the claims lock and before DevFn writes anything there: the directories this
 * creates as made; the state directory itself, when a start creates it, as held whole (`recorded`), and otherwise, also when it
 * existed before, as shared, whose DevFn entries are held by name. The record stays with the claim through a failed or
 * interrupted start and a refused stop. A state path that is or lies below something other than a directory, or claims that
 * cannot be read, refuse it before any write; a failed creation keeps provenance only for the directories it left. It returns
 * the withdrawal of a refused start: the record it added for an existing state directory goes again when the start left that
 * directory's DevFn entries as they were, and so does a claim then left attributing nothing, with its claim directories.
 */
export async function makeStateDirectory(config: DevFnConfig, root: string, identity: InstanceIdentity, stateDir: string, starting = false): Promise<() => Promise<void>> {
  let withdraw: () => Promise<void> = async () => undefined;
  const fresh = (await missingDirectories(path.join(root, CLAIMS))).at(-1);
  await withInstanceLifecycleLock(root, identity.instanceId, async () => {
    const rootKey = pathKey(await realpath(root).catch(() => path.resolve(root)));
    const inside = (item: string) => pathKey(item) !== rootKey && within(pathKey(item), rootKey);
    const { canonical } = await canonicalTarget(path.resolve(stateDir));
    const missing = await missingDirectories(canonical);
    const parent = missing.length ? path.dirname(missing.at(-1)!) : canonical;
    if (!(await stat(parent).catch(() => undefined))?.isDirectory()) {
      throw Object.assign(new Error(`State directory ${stateDir} is, or lies below, something other than a directory`), { code: "ENOTDIR" });
    }
    // A state directory outside the checkout, and so every directory created for it, is never a task input.
    if (!inside(canonical)) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      return;
    }
    const making = missing.filter(inside);
    const field = starting && missing.includes(canonical) ? "recorded" : "shared";
    const lock = path.join(await claimDirectory(root), CLAIMS_LOCK), options = { timeoutMs: CLAIMS_LOCK_TIMEOUT_MS, staleMs: CLAIMS_LOCK_STALE_MS };
    let current: OutputClaim | undefined, next: OutputClaim | undefined;
    await withFileLock(lock, async () => {
      const claims = await readClaims(root);
      current = claims.get(identity.instanceId)?.claim;
      const attributed = [...current?.recorded ?? [], ...current?.shared ?? []].some((item) => pathKey(item) === pathKey(canonical));
      if (attributed && !making.length) return;
      const receipts = await checkoutReceipts(config, root), receipt = receipts.get(identity.instanceId)?.receipt;
      next = { ...current ?? { version: 1, instanceId: identity.instanceId, runtime: identity.runtime ?? DEFAULT_RUNTIME, targets: [], written: [], pid: process.pid, createdAt: new Date().toISOString() } };
      // One no instance records that holds only trust state, as `--trust` creates it just before, is DevFn's too: transparent while it holds nothing else.
      const recorders = [...[...receipts.values()].map((entry) => entry.receipt.stateDir), ...[...claims.values()].flatMap((entry) => [entry.claim.stateDir, ...entry.claim.shared ?? [], ...entry.claim.recorded ?? []])];
      const recordedAnywhere = (await Promise.all(recorders.map(async (item) => item !== undefined && await canonicalKey(path.resolve(root, item)) === pathKey(canonical)))).some(Boolean);
      const names = missing.includes(canonical) || recordedAnywhere ? [] : await readdir(canonical).catch(() => [] as string[]);
      const ours = names.length && names.every((name) => TRUST_STATE.test(name)) ? [canonical] : [];
      next.made = union(current?.made, madeByRelease(receipt, current), making, ours);
      next[field] = union(current?.[field], [canonical]);
      if (field === "shared" && !making.length) {
        const before = await stateEntries(canonical);
        withdraw = async () => await withdrawStateRecord(root, identity.instanceId, canonical, before, fresh);
      }
      await writeClaim(root, next);
    }, options);
    await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(async (error: unknown) => {
      const published = next;
      if (published) await withFileLock(lock, async () => await restoreStateClaim(root, current, published, making), options);
      throw error;
    });
  });
  return withdraw;
}

/** A state directory's DevFn entries other than locks, with their modification times. */
async function stateEntries(directory: string): Promise<string> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => STATE_DIRECTORY_ENTRY.test(name) && !/\.lock(?:\.released\..+)?$/.test(name)).sort();
  return JSON.stringify(await Promise.all(names.map(async (name) => [name, (await lstat(path.join(directory, name)).catch(() => undefined))?.mtimeMs ?? null])));
}

/** Remove the record a refused start added for an existing state directory where it changed no DevFn entry; a claim then holding nothing, whose every recorded path is gone, goes too. */
async function withdrawStateRecord(root: string, instanceId: string, stateDir: string, before: string, fresh: string | undefined): Promise<void> {
  await withInstanceLifecycleLock(root, instanceId, async () => await withFileLock(path.join(await claimDirectory(root), CLAIMS_LOCK), async () => {
    const text = await readOwnClaim(root, instanceId), claim = text === undefined ? undefined : parseClaim(text, instanceId);
    if (!claim?.shared?.some((item) => pathKey(item) === pathKey(stateDir)) || await stateEntries(stateDir) !== before) return;
    const rest: OutputClaim = { ...claim, shared: claim.shared.filter((item) => pathKey(item) !== pathKey(stateDir)) };
    const holds = claim.targets.length || claim.written.length || claim.pending?.length || claim.runtimeDirectory !== undefined || claim.stateDir !== undefined;
    const provenance = [...rest.recorded ?? [], ...rest.made ?? [], ...rest.shared ?? [], ...rest.replaced ?? []];
    const remains = (await Promise.all(provenance.map(async (item) => await lstat(item).then(() => true, () => false)))).some(Boolean);
    await (holds || remains ? writeClaim(root, rest) : removeClaim(root, instanceId));
  }, { timeoutMs: CLAIMS_LOCK_TIMEOUT_MS, staleMs: CLAIMS_LOCK_STALE_MS }));
  if (fresh) await removeEmptyDirectories(path.join(root, CLAIMS), fresh);
}

/** After a failed creation, the claim before it keeps provenance only for the directories the creation left; a claim it created goes when it left none. */
async function restoreStateClaim(root: string, current: OutputClaim | undefined, published: OutputClaim, making: readonly string[]): Promise<void> {
  const left: string[] = [];
  for (const item of making) if (await lstat(item).then(() => true, () => false)) left.push(item);
  if (!current && !left.length) return await removeClaim(root, published.instanceId);
  const made = published.made!.filter((item) => !making.includes(item) || left.includes(item));
  const { shared: _published, ...rest } = published;
  await writeClaim(root, { ...rest, recorded: current?.recorded ?? [], ...current?.shared ? { shared: current.shared } : {}, made });
}
/** A directory and its ancestors that do not exist yet: what creating it would create. */ async function missingDirectories(target: string): Promise<string[]> { const missing: string[] = []; for (let current = target; current !== path.dirname(current) && !await lstat(current).then(() => true, () => false); current = path.dirname(current)) missing.push(current); return missing; }

interface Target { output: string; target: string; canonical: string; key: string; exists: boolean; symlink: boolean }

/**
 * DevFn's own state as canonical directories: the configured instance
 * runtime directories, the receipts with the output claims among them, and
 * the state directory when it lies inside the checkout. Runtime directories
 * other instances recorded elsewhere are held by those instances (Holder).
 */
async function stateDirectoryKeys(config: DevFnConfig, root: string, stateDir: string | undefined): Promise<string[]> {
  const keys = await Promise.all(devfnStateDirectories(config.runtimeDir).map(async (item) => await canonicalKey(path.resolve(root, item))));
  if (stateDir) {
    const rootKey = pathKey(await realpath(root).catch(() => path.resolve(root)));
    const stateKey = await canonicalKey(path.resolve(stateDir));
    if (stateKey !== rootKey && within(stateKey, rootKey)) keys.push(stateKey);
  }
  return keys;
}

/** The selected runtime's declared outputs; one whose file lands in DevFn's own state is refused. */
async function selectedTargets(config: DevFnConfig, root: string, runtime: string, stateDir: string | undefined): Promise<Target[]> {
  const targets: Target[] = [];
  let reserved: string[] | undefined;
  for (const output of config.environmentOutputs ?? []) {
    const target = await resolveContainedPath(root, runtimeOutputPath(output.path, runtime), "environmentOutputs.path");
    const resolved = await canonicalTarget(target);
    const key = pathKey(resolved.canonical);
    reserved ??= await stateDirectoryKeys(config, root, stateDir);
    if (reserved.some((directory) => within(key, directory))) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} resolves to ${resolved.canonical}, inside DevFn's own state (runtime directories, receipts, output claims or the state directory); write it elsewhere.`,
        { runtime, target: resolved.canonical });
    }
    targets.push({ output: output.path, target, ...resolved, key });
  }
  return targets;
}

interface Holder {
  instanceId: string;
  owner: { runtime: string; instanceId: string; receipt?: string; projectId?: string };
  entry: { receipt: LifecycleReceipt; file: string } | undefined;
  /** The canonical files it holds, by comparison key. */
  files: Map<string, string>;
  /**
   * The canonical runtime directories it writes logs, runtime.env and
   * artifacts to: its live receipt's, and the one its running claimant
   * claimed. A replacement under a changed runtimeDir holds both.
   */
  runtimeDirectories: { key: string; path: string }[];
  /** The canonical state directories (registry, leases, locks) its live receipt and running claimant record. */
  stateDirectories: { key: string; path: string }[];
  /** Its stable receipt and claim record, which are its state whether or not it is live. */
  stateFiles: string[];
  /** A live receipt of an earlier release that records no files and has no claim: what it holds cannot be known. */
  unknown: boolean;
}

/**
 * Every other instance of the checkout and the files it holds: its claimed
 * targets while its claimant runs or its receipt is not stopped, the files a
 * live receipt records (its runtime.env included), and every runtime
 * directory its live receipt or running claimant records, wherever a
 * runtimeDir put it.
 */
async function otherHolders(config: DevFnConfig, root: string, identity: InstanceIdentity, claims: Map<string, { claim: OutputClaim; text: string }>): Promise<Holder[]> {
  const receipts = await checkoutReceipts(config, root);
  const claimsDirectory = await claimDirectory(root);
  const holders: Holder[] = [];
  for (const instanceId of new Set([...claims.keys(), ...receipts.keys()])) {
    if (instanceId === identity.instanceId) continue;
    const claim = claims.get(instanceId)?.claim;
    const entry = receipts.get(instanceId);
    const receipt = entry?.receipt;
    const files = new Map<string, string>();
    // A running claimant holds what it claimed whether or not a receipt of
    // the instance is live: a replacement holds both its old and new state.
    const running = claim !== undefined && (claim.targets.length > 0 || claim.runtimeDirectory !== undefined) && await claimantRuns(claim);
    if (claim?.targets.length && (live(receipt) || running)) await addCanonical(files, claim.targets);
    if (live(receipt)) await addCanonical(files, receipt!.environmentOutputs);
    const directories = async (...items: (string | undefined)[]) => {
      const found: { key: string; path: string }[] = [];
      for (const directory of items) {
        if (directory === undefined) continue;
        const { canonical } = await canonicalTarget(directory);
        if (!found.some((item) => item.key === pathKey(canonical))) found.push({ key: pathKey(canonical), path: canonical });
      }
      return found;
    };
    const runtimeDirectories = await directories(live(receipt) ? receipt!.runtimeDir : undefined, running ? claim!.runtimeDirectory : undefined);
    const stateDirectories = await directories(live(receipt) ? receipt!.stateDir : undefined, running ? claim!.stateDir : undefined);
    const stateFiles = [...(entry ? [entry.file] : []), ...(claims.has(instanceId) ? [path.join(claimsDirectory, `${instanceId}.json`)] : [])];
    holders.push({ instanceId, entry, files, runtimeDirectories, stateDirectories, stateFiles, unknown: live(receipt) && !receipt!.environmentOutputs?.length && !(claim && (claim.targets.length || claim.runtimeDirectory !== undefined || claim.written.length)), // A claim that only records provenance knows none of its files.
      owner: { runtime: claim?.runtime ?? String(receipt?.runtime ?? DEFAULT_RUNTIME), instanceId, ...(entry ? { receipt: entry.file, projectId: String(entry.receipt.projectId) } : {}) } });
  }
  return holders;
}

/** The regular files under a directory, never following a link. */
async function* regularFiles(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* regularFiles(item);
    else if (entry.isFile()) yield item;
  }
}

/**
 * The other instance holding the file with this identity (a hard link to its file), if any: a file it holds, its receipt or claim record, or, for a file
 * with more than one link, any file it generated in its runtime directories (logs, receipt copy, runtime.env, Compose files, artifacts).
 */
async function holderOfIdentity(holders: readonly Holder[], identity: string, linked: boolean): Promise<{ holder: Holder; file: string } | undefined> {
  for (const holder of holders) {
    for (const file of [...holder.files.values(), ...holder.stateFiles]) if (await fileIdentity(file) === identity) return { holder, file };
  }
  if (!linked) return undefined;
  for (const holder of holders) {
    for (const directory of holder.runtimeDirectories) {
      for await (const file of regularFiles(directory.path)) {
        const info = await lstat(file, { bigint: true }).catch(() => undefined);
        if (info?.isFile() && info.nlink > 1n && `${info.dev}:${info.ino}` === identity) return { holder, file };
      }
    }
  }
  return undefined;
}

const aliasRefusal = async (config: DevFnConfig, root: string, runtime: string, target: string, canonical: string, found: { holder: Holder; file: string }) => new DevFnError("DEVFN_RUNTIME_INVALID",
  `Environment output ${relativeName(root, target)} of runtime ${runtime} is the same file (a hard link) as ${relativeName(root, found.file)}, which runtime ${found.holder.owner.runtime} (instance ${found.holder.instanceId}) writes; DevFn left it untouched. Remove the link, or ${await ownerRemedy(config, root, found.holder.instanceId, found.holder.entry, found.holder.owner.runtime)}.`,
  { runtime, target: canonical, owner: found.holder.owner });

/**
 * How to stop the owner of a receipt. A receipt this manifest cannot select
 * (another project ID, or a runtime name that does not derive its instance)
 * is named with what it records, since devfn down cannot reach it.
 */
async function ownerRemedy(config: DevFnConfig, root: string, instanceId: string, entry: { receipt: LifecycleReceipt; file: string } | undefined, runtime: string): Promise<string> {
  const flag = runtime === DEFAULT_RUNTIME ? "" : ` --runtime ${runtime}`;
  if (!entry) return "wait for the DevFn command that claimed it to finish";
  const projectId = String(entry.receipt.projectId);
  const reachable = projectId === config.project.id &&
    await resolveInstanceIdentity(config.project.id, root, runtime).then((identity) => identity.instanceId === instanceId, () => false);
  if (reachable) return `stop it with devfn down${flag} first`;
  return `its receipt ${entry.file} records project ${JSON.stringify(projectId.slice(0, 64))} and runtime ${JSON.stringify(runtime.slice(0, 64))}, which this manifest cannot select; set project.id back to ${JSON.stringify(projectId.slice(0, 64))} and run devfn down${flag}, or, once nothing that receipt lists runs, remove it`;
}

/**
 * Refuse environment outputs this instance may not write: a file another
 * instance of the checkout holds, by path or as a hard link to it, a file in
 * another live instance's runtime directory, any file while another
 * instance's claims cannot be known, and for a named runtime a symlink or an
 * existing file this instance never wrote. The default runtime keeps writing
 * its own outputs over existing files as earlier releases did. Whatever it
 * declares, an instance whose own runtime directory holds another's file
 * (written there under another runtimeDir), or is, contains or lies in
 * another instance's runtime directory, is refused: its logs, receipt and
 * runtime.env would overwrite them.
 */
async function assertTargetsAvailable(config: DevFnConfig, root: string, identity: InstanceIdentity, targets: readonly Target[],
  claims: Map<string, { claim: OutputClaim; text: string }>): Promise<void> {
  const runtime = identity.runtime ?? DEFAULT_RUNTIME;
  const wanted = new Map(targets.map((item) => [item.key, item]));
  const holders = await otherHolders(config, root, identity, claims);
  const ownDirectory = runtimeDirectory(config, root, identity.instanceId);
  const ownKey = await canonicalKey(ownDirectory);
  for (const holder of holders) {
    // Two runtime directories are disjoint: neither is the other, by a
    // symlink or a runtimeDir, nor lies inside it, or their logs, receipts
    // and runtime.env would overwrite each other.
    const other = holder.runtimeDirectories.find((item) => within(ownKey, item.key) || within(item.key, ownKey));
    if (other) {
      const relation = ownKey === other.key ? "is" : within(ownKey, other.key) ? "lies in" : "contains";
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${runtime} keeps its logs and runtime.env in ${relativeName(root, ownDirectory)}, which ${relation} ${relativeName(root, other.path)}, the runtime directory of runtime ${holder.owner.runtime} (instance ${holder.instanceId}); DevFn left it untouched. Remove the symlink or change runtimeDir, or ${await ownerRemedy(config, root, holder.instanceId, holder.entry, holder.owner.runtime)}.`,
        { runtime, target: other.path, owner: holder.owner });
    }
    const file = [...holder.files].find(([key]) => within(key, ownKey))?.[1];
    if (file === undefined) continue;
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${runtime} keeps its logs and runtime.env in ${relativeName(root, ownDirectory)}, where runtime ${holder.owner.runtime} (instance ${holder.instanceId}) writes ${relativeName(root, file)}; DevFn left it untouched. Move that output elsewhere, or ${await ownerRemedy(config, root, holder.instanceId, holder.entry, holder.owner.runtime)}.`,
      { runtime, target: file, owner: holder.owner });
  }
  if (!targets.length) return;
  for (const holder of holders) {
    const { instanceId, owner, entry } = holder;
    if (holder.unknown) {
      // A live receipt of an earlier release records what it wrote only once
      // it wrote it; without that or a claim its files cannot be known.
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${owner.runtime} (instance ${instanceId}) has a ${entry!.receipt.state} receipt that records no environment outputs, so DevFn cannot tell whether it owns ${targets.map((item) => relativeName(root, item.target)).join(", ")}; ${await ownerRemedy(config, root, instanceId, entry, owner.runtime)}.`,
        { runtime, owner });
    }
    const directory = holder.runtimeDirectories.find((item) => targets.some((target) => within(target.key, item.key)));
    const inside = directory && targets.find((item) => within(item.key, directory.key));
    if (directory && inside) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, inside.target)} of runtime ${runtime} lies in ${relativeName(root, directory.path)}, the runtime directory of runtime ${owner.runtime} (instance ${instanceId}), which holds its logs and runtime.env; write it elsewhere, or ${await ownerRemedy(config, root, instanceId, entry, owner.runtime)}.`,
        { runtime, target: inside.canonical, owner });
    }
    const state = holder.stateDirectories.find((item) => targets.some((target) => within(target.key, item.key)));
    const stateTarget = state && targets.find((item) => within(item.key, state.key));
    if (state && stateTarget) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, stateTarget.target)} of runtime ${runtime} resolves to ${stateTarget.canonical}, inside ${relativeName(root, state.path)}, the state directory of runtime ${owner.runtime} (instance ${instanceId}), which holds its port registry, leases and locks; write it elsewhere, or ${await ownerRemedy(config, root, instanceId, entry, owner.runtime)}.`,
        { runtime, target: stateTarget.canonical, owner });
    }
    const taken = [...holder.files.keys()].map((key) => wanted.get(key)).find((item) => item !== undefined);
    if (taken) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, taken.target)} of runtime ${runtime} is the file runtime ${owner.runtime} (instance ${instanceId}) writes; give the outputs distinct names, or ${await ownerRemedy(config, root, instanceId, entry, owner.runtime)}.`,
        { runtime, target: taken.canonical, owner });
    }
  }
  // An existing output that is another name of a held file is that file.
  for (const item of targets) {
    const id = item.exists ? await linkedIdentity(item.canonical) : undefined;
    const found = id === undefined ? undefined : await holderOfIdentity(holders, id.id, id.linked);
    if (found) throw await aliasRefusal(config, root, runtime, item.target, item.canonical, found);
  }
  if (!isNamedRuntime(identity.runtime)) return;
  // Its claim record is the only attribution: every named runtime has one, and a write records each file in it.
  const written = new Map((await writtenByClaim(claims.get(identity.instanceId)?.claim)).map((item) => [pathKey(item.target), item]));
  for (const item of targets) {
    if (item.symlink) throw symlinkRefusal(root, runtime, item.target);
    if (!item.exists) continue;
    const own = written.get(item.key);
    if (!own) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, item.target)} of runtime ${runtime} already exists and runtime ${runtime} did not write it; move it away or rename the output.`,
        { runtime, target: item.canonical });
    }
    if (!(await holdsRecorded({ target: item.canonical, sha256: own.sha256 }))) throw changedRefusal(root, runtime, item.target, item.canonical);
  }
}

const changedRefusal = (root: string, runtime: string, target: string, canonical: string) => new DevFnError("DEVFN_RUNTIME_INVALID",
  `Environment output ${relativeName(root, target)} of runtime ${runtime} changed since runtime ${runtime} wrote it; DevFn left it untouched. Move it away, or restore what DevFn wrote, before starting it again.`,
  { runtime, target: canonical });

const symlinkRefusal = (root: string, runtime: string, target: string) => new DevFnError("DEVFN_RUNTIME_INVALID",
  `Environment output ${relativeName(root, target)} of runtime ${runtime} is a symlink; a named runtime writes only its own regular files.`, { runtime, target });

/** What up refuses for this runtime's environment outputs, checked without claiming them (preflight and doctor). */
export async function assertEnvironmentOutputsAvailable(config: DevFnConfig, root: string, identity: InstanceIdentity, stateDir?: string): Promise<void> {
  const targets = await selectedTargets(config, root, identity.runtime ?? DEFAULT_RUNTIME, stateDir);
  await assertTargetsAvailable(config, root, identity, targets, await readClaims(root));
}

export interface EnvironmentOutputClaim {
  /** Hand the claim to the lifecycle receipt just written; restore() then keeps it. */
  commit(): Promise<void>;
  /**
   * Refuse unless the runtime directory path still reaches the real
   * directory the claim created or found there: called before each generated
   * write (runtime.env, receipt, logs, Compose files, artifacts), so none is
   * redirected by a symlink or directory swapped in after the claim.
   */
  assertRuntimeDirectory(): Promise<void>;
  /**
   * The path of a file or directory DevFn generates in the claimed runtime
   * directory (runtime.env, receipt.json, logs, compose, artifacts), checked
   * as each write is about to happen: the directory is still the one the
   * claim bound, and no child symlink on the path leads out of it.
   */
  runtimePath(relative: string): Promise<string>;
  /** Give back the targets of a claim no receipt took over; the files written stay this instance's. */
  restore(): Promise<void>;
  /** The receipt that held this instance's previous claim now says stopped: restore() then gives back its targets and runtime directory too, as down releases them, and keeps only the files written. */
  previousStopped(): void;
  /** Write one claimed environment output, attributing it to this instance no later than it exists. */
  write(target: string, content: string, mode: number): Promise<void>;
}

const LINKLESS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Create a file that must not exist yet, complete or not at all, without
 * following a link at its name: a private temporary file is flushed, then
 * hard-linked into place, which fails if anything exists there. Without hard
 * links, an exclusive no-follow open creates it.
 */
async function createExclusive(target: string, content: string, mode: number): Promise<"created" | "exists"> {
  const temp = stagingPath(target);
  try {
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await link(temp, target);
    return "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    if (!code || !LINKLESS.has(code)) throw error;
  } finally { await unlink(temp).catch(() => undefined); }
  let file;
  try { file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  }
  try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); }
  catch (error) {
    // A write that failed leaves no partial file this instance cannot attribute.
    await file.close().catch(() => undefined);
    file = undefined;
    await unlink(target).catch(() => undefined);
    throw error;
  } finally { await file?.close(); }
  return "created";
}

/** Replace a regular file in place of a link-free path: write a private temporary file, then rename it over the target. */
async function replaceRegular(target: string, content: string, mode: number): Promise<void> {
  const temp = stagingPath(target);
  try {
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await rename(temp, target);
  } finally { await unlink(temp).catch(() => undefined); }
}

/**
 * Write a file in place as DevFn v0.1 did (truncate, keep its inode, apply
 * the mode), without following a link at its name: a symlink there fails.
 * The file is opened without truncation first, so a file with other hard
 * links that `held` reports as another runtime's is left untouched.
 */
async function overwriteInPlace<T>(target: string, content: string, mode: number, held: (identity: string) => Promise<T | undefined>): Promise<"written" | "symlink" | { aliased: T }> {
  let file;
  try { file = await open(target, constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return "symlink";
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    const owner = info.nlink > 1n ? await held(`${info.dev}:${info.ino}`) : undefined;
    if (owner !== undefined) return { aliased: owner };
    await file.truncate(0);
    await file.writeFile(content, "utf8");
    await file.chmod(mode);
  } finally { await file.close(); }
  return "written";
}

/** Remove staging files an interrupted write left beside claimed targets, never a file a claim (also as recorded history) or any checkout receipt records as an output. */
async function removeOrphanedStaging(targets: readonly Target[], claims: Map<string, { claim: OutputClaim }>, receipts: Map<string, { receipt: LifecycleReceipt }>): Promise<void> {
  const outputs = new Set([...targets.map((item) => item.key), ...[...claims.values()].flatMap(({ claim }) => [...claim.targets, ...claim.written.map((item) => item.target)].map(pathKey)), ...await Promise.all([...[...receipts.values()].flatMap(({ receipt }) => receipt.environmentOutputs ?? []), ...[...claims.values()].flatMap(({ claim }) => claim.replaced ?? [])].map(async (item) => pathKey((await canonicalTarget(item)).canonical)))]);
  for (const item of targets) {
    const names = await readdir(path.dirname(item.canonical)).catch(() => [] as string[]);
    for (const name of names) {
      const staged = stagedOutputName(name);
      if (staged !== undefined && pathKey(staged) === pathKey(path.basename(item.canonical)) && !outputs.has(pathKey(path.join(path.dirname(item.canonical), name)))) await unlink(path.join(path.dirname(item.canonical), name)).catch(() => undefined);
    }
  }
}

/**
 * Claim this instance's environment outputs under the checkout-wide output
 * lock, before any lease, receipt or process exists, so concurrent starts of
 * runtimes whose outputs coincide are arbitrated: the first claim wins.
 */
export async function claimEnvironmentOutputs(config: DevFnConfig, root: string, identity: InstanceIdentity, stateDir?: string): Promise<EnvironmentOutputClaim> {
  const runtime = identity.runtime ?? DEFAULT_RUNTIME;
  let previous: OutputClaim | undefined;
  let hadPrevious = false;
  let claim!: OutputClaim;
  const ownDirectory = runtimeDirectory(config, root, identity.instanceId);
  // The real directory the claim holds: its canonical path and identity.
  let bound!: { canonical: string; id: string }; let making: string[] = [];
  const record = async (targets: readonly Target[]) => {
    // An interrupted creation is this instance's only if it left exactly the content it recorded.
    claim = { version: 1, instanceId: identity.instanceId, runtime, targets: targets.map((item) => item.canonical), written: await writtenByClaim(previous),
      runtimeDirectory: bound.canonical, ...previous?.shared ? { shared: previous.shared } : {}, ...stateDir ? { stateDir: (await canonicalTarget(path.resolve(stateDir))).canonical } : {}, ...await checkoutReceipts(config, root).then((receipts) => receipts.get(identity.instanceId)?.receipt).then((receipt) => ({ recorded: [...new Set([...previous?.recorded ?? [], bound.canonical, ...receipt ? [receipt.runtimeDir] : []])], made: [...new Set([...previous?.made ?? [], ...claim?.made ?? [], ...making, ...madeByRelease(receipt, previous)])], replaced: [...new Set([...previous?.replaced ?? [], ...receipt?.environmentOutputs ?? []])] })), pid: process.pid, ...await processBirthSignature(process.pid).then((value) => value ? { birthSignature: value } : {}), createdAt: new Date().toISOString() };
    await writeClaim(root, claim);
  };
  // Every start, also one without outputs, claims its runtime directory
  // under the lock, atomically with the check against its siblings and
  // before any lease or generated file, so an output claim and a
  // runtime-directory claim that overlap never both succeed. The lock lives
  // among the claims under the receipts, which are never task inputs, and so
  // do the directories it is retired to on release.
  let directory = path.join(root, CLAIMS);
  // The first directories this start created for the claims and for its
  // runtime directory, which a start that never began removes while empty.
  let created: string | undefined;
  let createdRuntime: string | undefined;
  const removeCreated = async () => { // Its runtime directories go before the attribution its claim published, then a claim it created.
    if (createdRuntime) await removeEmptyDirectories(ownDirectory, createdRuntime);
    if (claim) {
      const { pending: _stale, runtimeDirectory: _directory, ...base } = previous ?? claim;
      const kept: OutputClaim = { ...base, targets: previous?.targets ?? [], written: claim.written, recorded: claim.recorded, made: claim.made, replaced: claim.replaced, ...(claim.pending?.length ? { pending: claim.pending } : {}),
        ...(previous?.runtimeDirectory ? { runtimeDirectory: previous.runtimeDirectory } : {}) };
      if (hadPrevious || kept.written.length || kept.pending?.length) return await writeClaim(root, kept);
      await removeClaim(root, identity.instanceId);
    }
    // Nor does it leave DevFn state in a checkout that had none: only the
    // empty directories it created go, so a sibling's claim, lock or
    // receipt there keeps them.
    if (created) await removeEmptyDirectories(directory, created);
  };
  for (let attempt = 1; ; attempt += 1) {
    // Until the lock is held, a sibling's failed first start may remove the
    // empty claims directories it created while this start resolves or
    // creates them, or creates the lock in them; that is retried.
    let locked = false;
    try {
      directory = await claimDirectory(root);
      created = await mkdir(directory, { recursive: true, mode: 0o700 }) ?? created;
      await withFileLock(path.join(directory, CLAIMS_LOCK), async () => {
        locked = true;
        const targets = await selectedTargets(config, root, runtime, stateDir);
        await assertTargetsAvailable(config, root, identity, targets, await readClaims(root));
        const text = await readOwnClaim(root, identity.instanceId); [hadPrevious, previous] = [text !== undefined, text === undefined ? undefined : parseClaim(text, identity.instanceId)]; bound = { canonical: (await canonicalTarget(ownDirectory)).canonical, id: "" }; making = await missingDirectories(ownDirectory); await record(targets); // The claim records the runtime directory before any part of it is created (task-input attribution), then binds it.
        // The runtime directory exists as a real directory from the claim on,
        // and its identity is recorded: a symlink created at its path later
        // cannot redirect this start's writes into another runtime's state.
        createdRuntime = await makeDirectory(ownDirectory) ?? createdRuntime;
        bound = await directoryBinding(ownDirectory);
        await record(targets);
        await removeOrphanedStaging(targets, await readClaims(root), await checkoutReceipts(config, root));
      }, { timeoutMs: CLAIMS_LOCK_TIMEOUT_MS, staleMs: CLAIMS_LOCK_STALE_MS });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!locked && CLAIMS_SETUP_RACES.has(code ?? "") && attempt < CLAIMS_SETUP_ATTEMPTS) continue;
      // A refused start leaves no DevFn state in a checkout that had none.
      await removeCreated();
      throw error;
    }
  }
  const update = async (change: (current: OutputClaim) => OutputClaim) => {
    claim = change(claim);
    await writeClaim(root, claim);
  };
  /** Record the content about to be written before any byte of it can reach the file. */
  const intend = async (intent: WrittenOutput) =>
    await update((current) => ({ ...current, pending: [...(current.pending ?? []).filter((item) => pathKey(item.target) !== pathKey(intent.target)), intent] }));
  /** Clear the intent, recording the content as written when it landed. */
  const settle = async (intent: WrittenOutput, landed: boolean) => await update((current) => {
    const pending = (current.pending ?? []).filter((item) => pathKey(item.target) !== pathKey(intent.target));
    const { pending: _dropped, ...rest } = current;
    return { ...rest, ...(pending.length ? { pending } : {}), written: landed ? withWritten(current.written, intent) : current.written };
  });
  let committed = false;
  const assertRuntimeDirectory = async () => {
    const now = await directoryBinding(ownDirectory).catch(() => undefined);
    if (now && pathKey(now.canonical) === pathKey(bound.canonical) && now.id === bound.id) return;
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${runtime} keeps its logs and runtime.env in ${relativeName(root, ownDirectory)}, which ${now ? `now reaches ${now.canonical}` : "is gone or no longer a directory"}, not the directory ${bound.canonical} it claimed; a symlink or directory on its path changed during startup, and DevFn wrote nothing more there.`,
      { runtime, target: now?.canonical ?? ownDirectory, claimed: bound.canonical });
  };
  return {
    // Every start recorded a claim, also of no file, so a live receipt
    // without one is known to come from an earlier release.
    commit: async () => {
      committed = true;
    },
    assertRuntimeDirectory,
    runtimePath: async (relative) => {
      await assertRuntimeDirectory();
      const target = path.resolve(bound.canonical, relative);
      const boundKey = pathKey(bound.canonical);
      if (!within(pathKey(target), boundKey)) throw new Error(`${relative} is not inside the runtime directory`);
      // Each existing step is a real directory or file of the bound directory,
      // or a link that stays inside it: never one into another's state.
      let current = bound.canonical;
      for (const part of path.relative(bound.canonical, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!info) break;
        // A generated file with another name elsewhere (a hard link) loses
        // only this name, so its writer creates a new file and the other
        // links keep their content.
        if (current === target && info.isFile() && info.nlink > 1) await detach(current);
        if (!info.isSymbolicLink()) continue;
        const reached = await realpath(current).catch(() => undefined);
        if (reached === undefined || !within(pathKey(reached), boundKey)) {
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${runtime} would write ${relativeName(root, current)} in its runtime directory, but it is a symlink to ${reached ?? "a missing path"} outside that directory; DevFn wrote nothing there. Remove the symlink.`,
            { runtime, target: current, ...(reached ? { reached } : {}) });
        }
        // A link at the name itself that stays inside reaches a file a writer would write through; when that file has another name (a hard link, perhaps to another runtime's file) the link goes, as above.
        if (current === target) {
          const reachedInfo = await stat(reached).catch(() => undefined);
          if (reachedInfo?.isFile() && reachedInfo.nlink > 1) await detach(current);
        }
      }
      return target;
    },
    previousStopped: () => {
      if (!previous) return;
      const { runtimeDirectory: _released, ...rest } = previous;
      previous = { ...rest, targets: [] };
    },
    restore: async () => {
      if (committed) return;
      // A start that never began holds neither its outputs nor its runtime
      // directory; a claim it created is removed.
      await removeCreated();
    },
    write: async (target, content, mode) => {
      // Every runtime writes only the canonical file it claimed: a target a
      // changed symlink or directory now leads elsewhere is refused before any
      // byte changes, and the claimed path is written without following a
      // link at its name. (A directory swapped in the instant between the last
      // check and the open is not detected.)
      const named = isNamedRuntime(identity.runtime);
      const sha256 = digest(content);
      const claimedPath = async (): Promise<string> => {
        const resolved = await canonicalTarget(target);
        if (named && resolved.symlink) throw symlinkRefusal(root, runtime, target);
        const key = pathKey(resolved.canonical);
        const match = claim?.targets.find((item) => pathKey(item) === key);
        if (match === undefined) {
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} now resolves to ${resolved.canonical}, not the file it claimed; a symlink or directory on its path changed during startup, and DevFn left every file untouched.`,
            { runtime, target: resolved.canonical });
        }
        return match;
      };
      let canonical = await claimedPath();
      try {
        const parents = await missingDirectories(path.dirname(canonical)); if (parents.length) await update((current) => ({ ...current, made: [...new Set([...current.made ?? [], ...parents])] })); await mkdir(path.dirname(canonical), { recursive: true, mode: 0o700 }); // Recorded before created, as task-input provenance.
        canonical = await claimedPath();
        if (!named) {
          // The default runtime overwrites its claimed file in place as DevFn
          // v0.1 did, unless it is now a hard link to another runtime's file.
          const outcome = await overwriteInPlace(canonical, content, mode,
            async (id) => await holderOfIdentity(await otherHolders(config, root, identity, await readClaims(root)), id, true));
          if (outcome === "symlink") {
            throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} became a symlink after DevFn claimed it; DevFn left it untouched.`, { runtime, target: canonical });
          }
          if (outcome !== "written") throw await aliasRefusal(config, root, runtime, target, canonical, outcome.aliased);
          await update((current) => ({ ...current, written: withWritten(current.written, { target: canonical, sha256 }) }));
          return;
        }
        // A named runtime replaces only a regular file it wrote and nobody changed since, and creates only a file nothing else created in between.
        const intent: WrittenOutput = { target: canonical, sha256 };
        const own = claim.written.find((item) => pathKey(item.target) === pathKey(canonical));
        const stat = own ? await lstat(canonical).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }) : undefined;
        if (own && stat) {
          if (stat.isSymbolicLink()) throw symlinkRefusal(root, runtime, target);
          if (!stat.isFile()) {
            throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} is no longer a regular file; DevFn will not replace it.`, { runtime, target: canonical });
          }
          if (!(await holdsRecorded(own))) throw changedRefusal(root, runtime, target, canonical);
          // The new content is recorded before the rename can land, so an
          // interruption leaves the old or the new content, both its own.
          await intend(intent);
          await replaceRegular(canonical, content, mode);
          await settle(intent, true);
          return;
        }
        await intend(intent);
        const outcome = await createExclusive(canonical, content, mode);
        await settle(intent, outcome === "created");
        if (outcome === "exists") {
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} was created by someone else after DevFn claimed it; DevFn left it untouched. Move it away or rename the output.`,
            { runtime, target: canonical });
        }
      } catch (error) {
        if (error instanceof DevFnError) throw error;
        // Name the output, not only the staging file an I/O error reports.
        const failure = error as NodeJS.ErrnoException;
        throw Object.assign(new Error(`Could not write environment output ${relativeName(root, target)}: ${failure.message ?? String(error)}`, { cause: error }), failure.code ? { code: failure.code } : {});
      }
    },
  };
}

/** Remove one name of a file; a name already gone is fine. */ async function detach(name: string): Promise<void> { await unlink(name).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }

/**
 * Create a directory and its missing parents (0700), returning the first one
 * created; a parent a sibling's cleanup removed in between is created again.
 */
async function makeDirectory(target: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await mkdir(target, { recursive: true, mode: 0o700 }); }
    catch (error) {
      if (!CLAIMS_SETUP_RACES.has((error as NodeJS.ErrnoException).code ?? "") || attempt >= CLAIMS_SETUP_ATTEMPTS) throw error;
    }
  }
}

/** A directory's canonical path and identity (device and inode); it must be a directory. */
async function directoryBinding(target: string): Promise<{ canonical: string; id: string }> {
  const canonical = await realpath(target);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw Object.assign(new Error(`${target} is not a directory`), { code: "ENOTDIR" });
  return { canonical, id: `${info.dev}:${info.ino}` };
}

/** Remove directory and its parents up to and including top while each is empty. */
async function removeEmptyDirectories(directory: string, top: string): Promise<void> {
  if (directory !== top && !directory.startsWith(top + path.sep)) return;
  for (let current = directory; ; current = path.dirname(current)) {
    try { await rmdir(current); } catch { return; }
    if (current === top || path.dirname(current) === current) return;
  }
}

/** Release a stopped instance's claim and runtime directory; the files it wrote stay its own. */
export async function releaseEnvironmentOutputs(root: string, instanceId: string): Promise<void> {
  if (await readOwnClaim(root, instanceId) === undefined) return;
  // Under the claims lock, as every claim is checked and published, so a claim published meanwhile is never lost.
  await withFileLock(path.join(await claimDirectory(root), CLAIMS_LOCK), async () => {
    const text = await readOwnClaim(root, instanceId);
    const current = text === undefined ? undefined : parseClaim(text, instanceId);
    if (!current || (!current.targets.length && current.runtimeDirectory === undefined)) return;
    // Its runtime directory is free again too, even while the command that started it still runs.
    const { runtimeDirectory: _released, ...rest } = current;
    await writeClaim(root, { ...rest, targets: [] });
  }, { timeoutMs: CLAIMS_LOCK_TIMEOUT_MS, staleMs: CLAIMS_LOCK_STALE_MS });
}

/**
 * Hold an instance's checkout-wide lifecycle lock, beside the claims lock,
 * for a start or stop: its claim is the instance's in every state directory,
 * so one in another state directory waits rather than taking it over.
 * Directories created for the lock go again while empty.
 */
export async function withInstanceLifecycleLock<T>(root: string, instanceId: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    let [entered, directory, created] = [false, path.join(root, CLAIMS), undefined as string | undefined];
    try {
      directory = await claimDirectory(root);
      created = await makeDirectory(directory);
      return await withFileLock(path.join(directory, `lifecycle-${instanceId}.lock`), async () => { entered = true; return await action(); }, LIFECYCLE_LOCK);
    } catch (error) { // A sibling removing the empty directories before the lock is held is retried.
      if (entered || !CLAIMS_SETUP_RACES.has((error as NodeJS.ErrnoException).code ?? "") || attempt >= CLAIMS_SETUP_ATTEMPTS) throw error;
    } finally {
      if (created) await removeEmptyDirectories(directory, created);
    }
  }
}
