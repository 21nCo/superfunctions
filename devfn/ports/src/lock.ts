import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { link, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
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

type LockOwner = { token: string; pid: number; birthSignature?: string; createdAt: string };

/**
 * An owner record as this and earlier releases write it, or undefined for
 * anything else. Only such a record can show its owner dead.
 */
function parseOwnerRecord(text: string): LockOwner | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { token, pid, birthSignature, createdAt } = value as Record<string, unknown>;
  if (typeof token !== "string" || token === "" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return undefined;
  if (birthSignature !== undefined && typeof birthSignature !== "string") return undefined;
  return { token, pid, birthSignature, createdAt };
}

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
    if (await recoverable(lockPath, observed, staleMs) && await recoverLock(lockPath, observed, token, ownerRecord, deadline)) break;
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
  const status = await processIdentityStatus(owner.pid, owner.birthSignature, owner.createdAt);
  return status === "exited" || status === "identity-mismatch";
}

/** Only a well-formed record of a holder verified dead, or no record for long enough, is recovered. */
async function recoverable(lockPath: string, observed: string | undefined, staleMs: number): Promise<boolean> {
  if (!["linux", "darwin", "win32"].includes(process.platform)) return false;
  if (observed !== undefined) {
    const owner = parseOwnerRecord(observed);
    return owner !== undefined && Date.now() - Date.parse(owner.createdAt) > staleMs && await ownerDead(owner);
  }
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
 * fails if its creator publishes first.
 *
 * A dead holder's record is taken over under these rules:
 * - Safety: at most one holder; only the record judged dead is replaced. A
 *   marker named after that record and created with link admits one taker
 *   per generation, and generation n+1 is linked only after the taker of n
 *   was verified dead, so only the newest taker may be live. The taker links
 *   the current record aside without removing it and replaces it only if it
 *   is still the record judged; publishers never replace a record, so
 *   nothing else can change it before the replace.
 * - Liveness: if the holder and every taker are verified dead, a waiter
 *   recovers the lock before its deadline however many takers died.
 * - Exclusion: only a live taker, or one whose marker cannot be read or is
 *   not a well-formed owner record, or whose identity cannot be read, blocks;
 *   such a marker needs manual removal once its taker is gone. The same rule
 *   keeps an ill-formed holder record from being recovered at all.
 * While the record may still be current, a taker removes only its own
 * marker, the newest, so the markers stay a gapless run no waiter can pass a
 * live taker in. Once the record is replaced, its markers are inert and all
 * of them are removed.
 */
async function recoverLock(lockPath: string, observed: string | undefined, token: string, ownerRecord: string, deadline: number): Promise<boolean> {
  if (observed === undefined) return await publishOwner(lockPath, token, ownerRecord);
  const record = `owner.takeover.${createHash("sha256").update(observed).digest("hex").slice(0, 32)}.`;
  const ownerTemp = `${lockPath}/owner.${token}.tmp`;
  const snapshot = `${lockPath}/owner.snapshot.${token}`;
  let marker: string | undefined;
  let replaced = false;
  try {
    await writeFile(ownerTemp, ownerRecord, { mode: 0o600, flag: "wx" });
    for (let generation = 0; marker === undefined; generation += 1) {
      if (Date.now() >= deadline) return false;
      const candidate = `${lockPath}/${record}${generation}`;
      try { await link(ownerTemp, candidate); marker = candidate; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!await takerDead(candidate)) return false;
      }
    }
    await link(`${lockPath}/owner.json`, snapshot);
    replaced = await readFile(snapshot, "utf8") !== observed;
    if (replaced) return false;
    await rename(ownerTemp, `${lockPath}/owner.json`);
    replaced = true;
    return true;
  } catch (error) {
    // Released, or the record was never there to judge.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    const markers = replaced
      ? (await readdir(lockPath).catch(() => [])).filter((name) => name.startsWith(record)).map((name) => `${lockPath}/${name}`)
      : marker ? [marker] : [];
    await Promise.all([ownerTemp, snapshot, ...markers].map(async (file) => await rm(file, { force: true }).catch(() => undefined)));
  }
}

/** A taker whose marker cannot be read or is ill-formed may still be live. */
async function takerDead(marker: string): Promise<boolean> {
  try {
    const owner = parseOwnerRecord(await readFile(marker, "utf8"));
    return owner !== undefined && await ownerDead(owner);
  } catch { return false; }
}

/** Remove the lock only while it records this holder. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if (parseOwnerRecord(await readFile(`${lockPath}/owner.json`, "utf8"))?.token !== token) return;
    // Moving the lock aside frees its path in one step. Released locks are
    // never used again, so those of holders killed before removing theirs go
    // too.
    const prefix = `${path.basename(lockPath)}.released.`;
    await rename(lockPath, `${lockPath}.released.${token}`);
    const released = (await readdir(path.dirname(lockPath))).filter((name) => name.startsWith(prefix));
    await Promise.all(released.map(async (name) => await rm(path.join(path.dirname(lockPath), name), { recursive: true, force: true }).catch(() => undefined)));
  } catch { /* Never remove a lock whose ownership cannot be proven. */ }
}
