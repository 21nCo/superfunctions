// The update check's cache file (CLI-14). Internal: not in the package's exports.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureAppDir } from "./paths.js";
import { parseVersion } from "./version.js";

/**
 * What the cache file holds. `notifiedAt` is when a notice was last delivered, on either shape: an error refresh keeps
 * it, so a delivery is not forgotten. Older files have none.
 */
export type LatestEntry = { checkedAt: number; latest: string; notifiedAt?: number };
export type ErrorEntry = { checkedAt: number; error: true; notifiedAt?: number };
export type CacheEntry = LatestEntry | ErrorEntry;

export const UPDATE_CHECK_FILE = "update-check.json";
/** Temporary files a write leaves behind are removed by a later write once they are this old. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
const TEMPORARY_FILE = /^update-check\.json\.[0-9A-Za-z-]+\.tmp$/;

/** Cache writes still running in this process; see `settleCacheWrites`. */
const pending = new Set<Promise<void>>();

/** Tracks a background write until it settles. The promise must never reject. */
export function trackCacheWrite(write: Promise<void>): Promise<void> {
  pending.add(write);
  void write.finally(() => pending.delete(write));
  return write;
}

/** Resolves once every cache write started in this process, including ones started meanwhile, has settled. */
export async function settleCacheWrites(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

/**
 * A cache entry from file text; anything else (missing, unreadable, malformed) is never checked. A `notifiedAt` that is
 * not a finite number is ignored, as if no notice had been delivered.
 */
export function parseCacheEntry(text: string): CacheEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const checkedAt = record.checkedAt;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) {
    return null;
  }
  let entry: CacheEntry;
  if (record.error === true) {
    entry = { checkedAt, error: true };
  } else if (typeof record.latest === "string" && parseVersion(record.latest)) {
    entry = { checkedAt, latest: record.latest };
  } else {
    return null;
  }
  return withNotifiedAt(entry, record.notifiedAt);
}

/** The entry with `notifiedAt` set when it is a finite number, else without one. */
function withNotifiedAt(entry: CacheEntry, notifiedAt: unknown): CacheEntry {
  const base: CacheEntry =
    "latest" in entry ? { checkedAt: entry.checkedAt, latest: entry.latest } : { checkedAt: entry.checkedAt, error: true };
  return typeof notifiedAt === "number" && Number.isFinite(notifiedAt) ? { ...base, notifiedAt } : base;
}

/** The later of two delivery times; undefined when neither records one. */
function laterDelivery(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.max(a, b);
}

export async function readCache(file: string): Promise<CacheEntry | null> {
  try {
    return parseCacheEntry(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The cache entry, read synchronously: the hand-out check reads the small cache file without awaiting, so `notice()`
 * never waits on it. Null for a missing, unreadable or malformed file.
 */
export function readCacheSync(file: string): CacheEntry | null {
  try {
    return parseCacheEntry(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Removes temporary files of interrupted writes that are older than one hour. Best effort. */
async function removeStaleTemporaryFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMPORARY_MS;
  await Promise.all(
    names
      .filter((name) => TEMPORARY_FILE.test(name))
      .map(async (name) => {
        const file = join(dir, name);
        try {
          const info = await lstat(file);
          if (info.isFile() && info.mtimeMs < cutoff) {
            await rm(file, { force: true });
          }
        } catch {
          // Another instance removed it first, or it cannot be read; either way it is not ours to report.
        }
      })
  );
}

/** Writes the entry to a unique temporary file in `dir` and renames it over the cache file. */
async function writeCache(dir: string, entry: CacheEntry): Promise<void> {
  await ensureAppDir(dir);
  await removeStaleTemporaryFiles(dir);
  const temporary = join(dir, `${UPDATE_CHECK_FILE}.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(dir, UPDATE_CHECK_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Writes the entry, keeping the later `notifiedAt` of the entry and of the file as it is right before the write, so a
 * refresh never drops a delivery another run recorded during its request. Two writes racing inside that read-then-rename
 * window are the last-rename-wins boundary.
 */
async function writeCacheMerged(dir: string, entry: CacheEntry): Promise<void> {
  const current = await readCache(join(dir, UPDATE_CHECK_FILE));
  await writeCache(dir, withNotifiedAt(entry, laterDelivery(entry.notifiedAt, current?.notifiedAt)));
}

/** Writes the entry (see `writeCacheMerged`), never rejecting: an unwritable cache means the next run checks again. */
export function writeCacheQuietly(dir: string, entry: CacheEntry): Promise<void> {
  return trackCacheWrite(writeCacheMerged(dir, entry).catch(() => undefined));
}

/**
 * Records that a notice was delivered at `notifiedAt`, once `after` (this run's own write) has settled. It re-reads the
 * cache and adds the delivery to whatever entry is there, newer of the file and `entry` by `checkedAt`: an error entry
 * or an entry for another version another run wrote meanwhile keeps its content and gains `notifiedAt`, so the
 * delivery is neither rolled back nor forgotten. A later `notifiedAt` already in the file is kept. Never rejects.
 */
export function recordDeliveryQuietly(
  dir: string,
  entry: LatestEntry,
  notifiedAt: number,
  after: Promise<void>
): Promise<void> {
  const record = async (): Promise<void> => {
    await after;
    const current = await readCache(join(dir, UPDATE_CHECK_FILE));
    const base: CacheEntry = current !== null && current.checkedAt >= entry.checkedAt ? current : entry;
    const delivered = laterDelivery(laterDelivery(current?.notifiedAt, base.notifiedAt), notifiedAt);
    await writeCache(dir, withNotifiedAt(base, delivered));
  };
  return trackCacheWrite(record().catch(() => undefined));
}
