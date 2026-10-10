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
// itself over the next holder (claimLock).
const OWNERLESS_LOCK_STALE_MS = 300_000;

type LockOwner = { token?: string; pid?: number; birthSignature?: string; createdAt?: string };

/**
 * Hold a lock directory for the duration of action. Every release, this and
 * earlier ones, acquires it with mkdir, which never replaces a lock. The
 * owner record is then published with link, which never replaces one either,
 * so a creator that stalled past recovery cannot claim a lock another holder
 * already recorded. Only a lock recording this holder is ever removed.
 */
export async function withFileLock<T>(lockPath: string, action: () => Promise<T>, options: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 300_000;
  const token = randomUUID();
  const ownerRecord = JSON.stringify({ token, pid: process.pid, birthSignature: await processBirthSignature(process.pid), createdAt: new Date().toISOString() });
  const deadline = Date.now() + timeoutMs;
  while (!await claimLock(lockPath, token, ownerRecord)) {
    let observed: LockOwner | undefined;
    try { observed = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as LockOwner; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (await recoverable(lockPath, observed, staleMs)) await recoverLock(lockPath, observed?.token ?? "ownerless");
    if (Date.now() >= deadline) throw new PortRegistryError("DEVFN_REGISTRY_LOCK_TIMEOUT", `Timed out acquiring registry lock ${lockPath}.`);
    await delay(20 + Math.floor(Math.random() * 20));
  }
  try { return await action(); }
  finally {
    try {
      const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as LockOwner;
      if (owner.token === token) {
        // Moving the lock aside frees its path in one step.
        const released = `${lockPath}.released.${token}`;
        await rename(lockPath, released);
        await rm(released, { recursive: true, force: true });
      }
    } catch { /* Never remove a lock whose ownership cannot be proven. */ }
  }
}

/** Create the lock and publish this owner in it; false when another holds or is creating it. */
async function claimLock(lockPath: string, token: string, ownerRecord: string): Promise<boolean> {
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  // The directory may have been recovered and recreated by another holder
  // while this creator stalled; publishing fails then, never replacing it.
  const ownerTemp = `${lockPath}/owner.${token}.tmp`;
  try {
    await writeFile(ownerTemp, ownerRecord, { mode: 0o600, flag: "wx" });
    await link(ownerTemp, `${lockPath}/owner.json`);
    return true;
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    // Unpublished, the directory is still empty unless another holder now
    // owns it, and rmdir removes only an empty one.
    await rm(ownerTemp, { force: true }).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
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

/** Move a stale lock aside, putting it back if its creator recorded itself meanwhile. */
async function recoverLock(lockPath: string, observedToken: string): Promise<void> {
  const quarantine = `${lockPath}.stale.${observedToken}.${randomUUID()}`;
  try { await rename(lockPath, quarantine); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const owner = await readFile(`${quarantine}/owner.json`, "utf8").then((text) => (JSON.parse(text) as LockOwner).token ?? "ownerless", () => "ownerless");
  if (owner === observedToken) { await rm(quarantine, { recursive: true, force: true }); return; }
  // A lock is never deleted for a holder it was not judged by. Its holder
  // still releases by token; one that cannot be restored is left in place.
  await rename(quarantine, lockPath).catch(() => undefined);
}
