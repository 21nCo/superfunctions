import { createHash, randomUUID } from "node:crypto";
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
// Successive takeovers of one dead holder's record, each started only after
// the previous taker was verified dead.
const MAX_TAKEOVER_GENERATIONS = 16;

type LockOwner = { token?: string; pid?: number; birthSignature?: string; createdAt?: string };

/**
 * Hold a lock directory for the duration of action. Every release, this and
 * earlier ones, acquires it with mkdir, which never replaces a lock. The
 * owner record is then published with link, which never replaces one either,
 * so a creator that stalled past recovery cannot claim a lock another holder
 * already recorded. Once recorded, owner.json is never absent until its holder
 * releases: recovery replaces a dead holder's record in place (recoverLock),
 * and only a lock recording this holder is removed.
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

async function ownerDead(owner: LockOwner): Promise<boolean> {
  const status = owner.pid ? await processIdentityStatus(owner.pid, owner.birthSignature, owner.createdAt) : "exited";
  return status === "exited" || status === "identity-mismatch";
}

async function recoverable(lockPath: string, observed: LockOwner | undefined, staleMs: number): Promise<boolean> {
  if (!["linux", "darwin", "win32"].includes(process.platform)) return false;
  if (observed) return Boolean(observed.createdAt) && Date.now() - Date.parse(observed.createdAt!) > staleMs && await ownerDead(observed);
  const mtime = await stat(lockPath).then((value) => value.mtimeMs, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Date.now();
    throw error;
  });
  return Date.now() - mtime > Math.max(staleMs, OWNERLESS_LOCK_STALE_MS);
}

/**
 * Take over a lock judged stale without ever freeing its path or leaving it
 * without an owner record, so neither mkdir nor a pending publish can succeed
 * meanwhile. An ownerless lock is adopted by publishing this owner, which
 * fails if its creator publishes first. For a dead holder's record, a marker
 * named after that record and created with link admits one taker; a taker
 * killed midway is superseded by the next generation once verified dead. The
 * taker links the current record aside without removing it and replaces it
 * only if it is still the record judged dead. Publishers never replace a
 * record, so nothing else can change it before the replace.
 */
async function recoverLock(lockPath: string, observed: string | undefined, token: string, ownerRecord: string): Promise<boolean> {
  if (observed === undefined) return await publishOwner(lockPath, token, ownerRecord);
  const record = createHash("sha256").update(observed).digest("hex").slice(0, 32);
  const ownerTemp = `${lockPath}/owner.${token}.tmp`;
  const snapshot = `${lockPath}/owner.snapshot.${token}`;
  const markers: string[] = [];
  let taken = false;
  try {
    await writeFile(ownerTemp, ownerRecord, { mode: 0o600, flag: "wx" });
    for (let generation = 0; !taken; generation += 1) {
      if (generation === MAX_TAKEOVER_GENERATIONS) return false;
      const marker = `${lockPath}/owner.takeover.${record}.${generation}`;
      markers.push(marker);
      try { await link(ownerTemp, marker); taken = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const taker = await readFile(marker, "utf8").then((value) => JSON.parse(value) as LockOwner, () => undefined);
        if (!taker || !await ownerDead(taker)) return false;
      }
    }
    await link(`${lockPath}/owner.json`, snapshot);
    if (await readFile(snapshot, "utf8") !== observed) return false;
    await rename(ownerTemp, `${lockPath}/owner.json`);
    return true;
  } catch (error) {
    // Released, or the record was never there to judge.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    // Markers go only once this taker has finished with the record: a later
    // taker of it then finds another record and stops.
    await Promise.all([ownerTemp, snapshot, ...(taken ? markers : [])].map(async (file) => await rm(file, { force: true }).catch(() => undefined)));
  }
}

/** Remove the lock only while it records this holder. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as LockOwner;
    if (owner.token !== token) return;
    // Moving the lock aside frees its path in one step.
    const released = `${lockPath}.released.${token}`;
    await rename(lockPath, released);
    await rm(released, { recursive: true, force: true });
  } catch { /* Never remove a lock whose ownership cannot be proven. */ }
}
