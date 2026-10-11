import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { link, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { processBirthSignature, processIdentityStatus } from "@devfn/processes";

import { PortRegistryError } from "./types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const heldRoutingLocks = new AsyncLocalStorage<ReadonlySet<string>>();

const ROUTING_LOCK_TIMEOUT_MS = 180_000;
// A verified-dead holder's lock is recovered well within a waiter's budget.
const ROUTING_LOCK_STALE_MS = 60_000;

/** Serialize lease and route mutations, including a replacement's teardown. */
export async function withRoutingLock<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Any spelling of the directory names the same lock for re-entry.
  const lockPath = path.join(await realpath(stateDir), "routing.lock");
  if (heldRoutingLocks.getStore()?.has(lockPath)) return await action();
  return await withFileLock(lockPath, async () =>
    await heldRoutingLocks.run(new Set([...(heldRoutingLocks.getStore() ?? []), lockPath]), action),
  { timeoutMs: ROUTING_LOCK_TIMEOUT_MS, staleMs: ROUTING_LOCK_STALE_MS });
}

// An ownerless lock may be one whose creator, of this or an earlier release,
// has not yet recorded itself. It is taken only after the 300 s earlier
// releases also wait; a creator stalled even longer cannot then publish
// itself over the next holder (publishOwner).
const OWNERLESS_LOCK_STALE_MS = 300_000;
// How long a release waits for a recoverer that moved its owner record aside
// to compare it with a dead one to put it back.
const RELEASE_RECHECK_MS = 1_000;

type LockOwner = { token?: string; pid?: number; birthSignature?: string; createdAt?: string };

/**
 * Hold a lock directory for the duration of action. Every release, this and
 * earlier ones, acquires it with mkdir, which never replaces a lock. The
 * owner record is then published with link, which never replaces one either,
 * so a creator that stalled past recovery cannot claim a lock another holder
 * already recorded. Recovery takes a stale lock over in place and never frees
 * its path (recoverLock), and only a lock recording this holder is removed.
 */
export async function withFileLock<T>(lockPath: string, action: () => Promise<T>, options: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 300_000;
  const token = randomUUID();
  const ownerRecord = JSON.stringify({ token, pid: process.pid, birthSignature: await processBirthSignature(process.pid), createdAt: new Date().toISOString() });
  const deadline = Date.now() + timeoutMs;
  while (!await claimLock(lockPath, token, ownerRecord)) {
    const observed = await readFile(`${lockPath}/owner.json`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const owner = observed === undefined ? undefined : JSON.parse(observed) as LockOwner;
    if (await recoverable(lockPath, owner, staleMs) && await recoverLock(lockPath, observed, token, ownerRecord)) break;
    if (Date.now() >= deadline) throw new PortRegistryError("DEVFN_REGISTRY_LOCK_TIMEOUT", `Timed out acquiring registry lock ${lockPath}.`);
    await delay(20 + Math.floor(Math.random() * 20));
  }
  try { return await action(); }
  finally { await releaseLock(lockPath, token); }
}

/** Create the lock and publish this owner in it; false when another holds or is creating it. */
async function claimLock(lockPath: string, token: string, ownerRecord: string): Promise<boolean> {
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { return await publishOwner(lockPath, token, ownerRecord); }
  catch (error) {
    // Unpublished, the directory is still empty unless another holder now
    // owns it, and rmdir removes only an empty one.
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }
}

/** Record this owner in an existing lock directory unless another owner is recorded there first. */
async function publishOwner(lockPath: string, token: string, ownerRecord: string): Promise<boolean> {
  const ownerTemp = `${lockPath}/owner.${token}.tmp`;
  try {
    await writeFile(ownerTemp, ownerRecord, { mode: 0o600, flag: "wx" });
    await link(ownerTemp, `${lockPath}/owner.json`);
    return true;
  } catch (error) {
    // Another owner was recorded first, or the lock was released meanwhile.
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    await rm(ownerTemp, { force: true }).catch(() => undefined);
  }
}

async function recoverable(lockPath: string, observed: LockOwner | undefined, staleMs: number): Promise<boolean> {
  if (!["linux", "darwin", "win32"].includes(process.platform)) return false;
  if (observed) {
    const owner = observed.pid ? await processIdentityStatus(observed.pid, observed.birthSignature, observed.createdAt) : "exited";
    return (owner === "exited" || owner === "identity-mismatch") && Boolean(observed.createdAt) && Date.now() - Date.parse(observed.createdAt!) > staleMs;
  }
  const mtime = await stat(lockPath).then((value) => value.mtimeMs, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Date.now();
    throw error;
  });
  return Date.now() - mtime > Math.max(staleMs, OWNERLESS_LOCK_STALE_MS);
}

/**
 * Take over a lock judged stale without ever freeing its path, so mkdir keeps
 * failing for every other claimant meanwhile. An ownerless lock is adopted by
 * publishing this owner, which fails if its creator publishes first. A dead
 * owner's record is moved aside and compared with the one judged: the same
 * record means the lock is still that owner's, and this owner is published in
 * its place. Any other record belongs to a holder that took the lock since,
 * and is put straight back; while it is aside the lock is not ownerless for
 * long enough to adopt, so nothing else can be published there, and a restore
 * that fails anyway is an error rather than a lost lock.
 */
async function recoverLock(lockPath: string, observed: string | undefined, token: string, ownerRecord: string): Promise<boolean> {
  if (observed === undefined) return await publishOwner(lockPath, token, ownerRecord);
  const aside = `${lockPath}/owner.stale.${token}.json`;
  try {
    await rename(`${lockPath}/owner.json`, aside);
    const moved = await readFile(aside, "utf8");
    if (moved === observed) return await publishOwner(lockPath, token, ownerRecord);
  } catch (error) {
    // Released or taken over meanwhile.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try { await link(aside, `${lockPath}/owner.json`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new PortRegistryError("DEVFN_REGISTRY_INVALID", `Could not restore the owner record of lock ${lockPath}: ${(error as Error).message}`);
  }
  await rm(aside, { force: true });
  return false;
}

/** Remove the lock only while it records this holder. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  const deadline = Date.now() + RELEASE_RECHECK_MS;
  try {
    let owner: LockOwner | undefined;
    while (!owner) {
      try { owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as LockOwner; }
      catch (error) {
        // A recoverer may have moved this holder's record aside to compare it.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) return;
        await stat(lockPath);
        await delay(10);
      }
    }
    if (owner.token !== token) return;
    // Moving the lock aside frees its path in one step.
    const released = `${lockPath}.released.${token}`;
    await rename(lockPath, released);
    await rm(released, { recursive: true, force: true });
  } catch { /* Never remove a lock whose ownership cannot be proven. */ }
}
