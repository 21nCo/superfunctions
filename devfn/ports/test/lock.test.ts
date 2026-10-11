import { access, link, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Stall the first lock-owner write until released, as a lock creator paused
// by the scheduler would; age ownerless locks and run a hook after a waiter
// reads that age; run a hook right before this release creates a lock; or run
// a hook right before a recoverer moves a stale lock or its record aside, and
// right before it reads what it moved.
const fsHooks = vi.hoisted(() => ({
  armed: false,
  stalled: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  agedPath: undefined as string | undefined,
  afterAgeCheck: undefined as (() => Promise<void>) | undefined,
  beforeClaim: undefined as ((lockPath: string) => Promise<void>) | undefined,
  beforeStaleMove: undefined as (() => Promise<void>) | undefined,
  beforeStaleRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const once = async (name: "afterAgeCheck" | "beforeStaleMove" | "beforeStaleRead") => {
    const hook = fsHooks[name];
    fsHooks[name] = undefined;
    await hook?.();
  };
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsHooks.armed && typeof args[0] === "string" && path.basename(args[0]).startsWith("owner")) {
        fsHooks.armed = false;
        fsHooks.stalled?.();
        await fsHooks.release;
      }
      return await actual.writeFile(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const hook = fsHooks.beforeClaim;
      if (hook && typeof args[0] === "string" && args[0].endsWith(".lock")) { fsHooks.beforeClaim = undefined; await hook(args[0]); }
      return await actual.mkdir(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      if (args[0] !== fsHooks.agedPath) return result;
      await once("afterAgeCheck");
      return Object.assign(result, { mtimeMs: 0 });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).includes(".stale.")) await once("beforeStaleMove");
      return await actual.rename(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).includes(".stale.")) await once("beforeStaleRead");
      return await actual.readFile(...args);
    },
  };
});

const { withFileLock } = await import("../src/index.js");

afterEach(() => { Object.assign(fsHooks, { armed: false, agedPath: undefined, afterAgeCheck: undefined, beforeClaim: undefined, beforeStaleMove: undefined, beforeStaleRead: undefined }); });

/** The v0.1 lock protocol: mkdir, then rename the owner record over owner.json; release by token. */
async function legacyAcquire(lockPath: string, token: string, beforePublish: Promise<void> = Promise.resolve()): Promise<boolean> {
  try { await mkdir(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  await beforePublish;
  const temp = `${lockPath}/owner.${token}.tmp`;
  await writeFile(temp, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), { flag: "wx" });
  await rename(temp, `${lockPath}/owner.json`);
  return true;
}

async function legacyRelease(lockPath: string, token: string): Promise<void> {
  const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as { token?: string };
  if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
}

function overlapDetector() {
  let holders = 0;
  let overlaps = 0;
  return {
    get overlaps() { return overlaps; },
    async hold(ms: number) {
      holders += 1;
      if (holders > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, ms));
      holders -= 1;
    },
  };
}

it("never lets a waiter take a lock whose creator is paused before recording its owner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-stall-"));
  const lockPath = path.join(dir, "routing.lock");
  let resume!: () => void;
  fsHooks.release = new Promise<void>((resolve) => { resume = resolve; });
  const paused = new Promise<void>((resolve) => { fsHooks.stalled = resolve; });
  fsHooks.armed = true;
  try {
    const creator = withFileLock(lockPath, async () => JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { token: string }, { staleMs: 1, timeoutMs: 10_000 });
    await paused;
    // Past the dead-owner stale age, the ownerless lock is still the creator's.
    await expect(withFileLock(lockPath, async () => "waiter", { staleMs: 1, timeoutMs: 300 })).rejects.toMatchObject({ code: "DEVFN_REGISTRY_LOCK_TIMEOUT" });
    // A waiter that gave up leaves nothing behind.
    expect(await readdir(dir)).toEqual(["routing.lock"]);
    resume();
    await expect(creator).resolves.toMatchObject({ token: expect.any(String) });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dir)).toEqual([]);
  } finally {
    resume?.();
    await rm(dir, { recursive: true, force: true });
  }
});

it("never lets a creator paused beyond the ownerless bound publish itself over the next holder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-stall-"));
  const lockPath = path.join(dir, "routing.lock");
  let resume!: () => void;
  fsHooks.release = new Promise<void>((resolve) => { resume = resolve; });
  const paused = new Promise<void>((resolve) => { fsHooks.stalled = resolve; });
  fsHooks.armed = true;
  const detector = overlapDetector();
  try {
    const creator = withFileLock(lockPath, async () => { await detector.hold(10); return "creator"; }, { staleMs: 1, timeoutMs: 10_000 });
    await paused;
    fsHooks.agedPath = lockPath;
    let waiterHolds!: () => void;
    const waiterHolding = new Promise<void>((resolve) => { waiterHolds = resolve; });
    const waiter = withFileLock(lockPath, async () => {
      fsHooks.agedPath = undefined;
      const owner = await readFile(path.join(lockPath, "owner.json"), "utf8");
      waiterHolds();
      await detector.hold(200);
      // The lock still records this holder when its work ends.
      expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(owner);
      return "waiter";
    }, { staleMs: 1, timeoutMs: 10_000 });
    await waiterHolding;
    resume();
    await expect(Promise.all([creator, waiter])).resolves.toEqual(["creator", "waiter"]);
    expect(detector.overlaps).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    resume?.();
    await rm(dir, { recursive: true, force: true });
  }
});

it("never claims a lock an earlier release creates just before this release's mkdir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-legacy-"));
  const lockPath = path.join(dir, "routing.lock");
  let legacyHolding = false;
  let legacyStarted!: (legacy: { acquired: Promise<boolean> }) => void;
  const legacy = new Promise<{ acquired: Promise<boolean> }>((resolve) => { legacyStarted = resolve; });
  // The earlier release creates the directory now and records its owner a
  // moment later, as its own mkdir-then-rename protocol does.
  fsHooks.beforeClaim = async (target) => {
    legacyStarted({ acquired: legacyAcquire(target, "legacy", new Promise((resolve) => setTimeout(resolve, 30))).then((held) => { legacyHolding = held; return held; }) });
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    const current = withFileLock(lockPath, async () => {
      const overlapped = legacyHolding;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { overlapped: overlapped || legacyHolding, owner: JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { token: string } };
    }, { staleMs: 1, timeoutMs: 10_000 });
    await expect((await legacy).acquired).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    legacyHolding = false;
    await legacyRelease(lockPath, "legacy");
    const entered = await current;
    expect(entered.overlapped).toBe(false);
    expect(entered.owner.token).not.toBe("legacy");
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps one holder at a time across concurrent holders of this and the earlier release", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-mixed-"));
  const lockPath = path.join(dir, "routing.lock");
  const detector = overlapDetector();
  const legacy = async (index: number) => {
    const token = `legacy-${index}`;
    const deadline = Date.now() + 20_000;
    while (!await legacyAcquire(lockPath, token)) {
      if (Date.now() > deadline) throw new Error("legacy holder timed out");
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    }
    try { await detector.hold(Math.random() * 3); }
    finally { await legacyRelease(lockPath, token); }
  };
  try {
    await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      for (let round = 0; round < 4; round += 1) {
        if (index % 2) await legacy(index * 10 + round);
        else await withFileLock(lockPath, async () => await detector.hold(Math.random() * 3), { timeoutMs: 20_000 });
      }
    }));
    expect(detector.overlaps).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

/** A lock left by a holder that recorded itself an hour ago and has since died. */
async function deadHolderLock(lockPath: string): Promise<void> {
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "dead", createdAt: new Date(Date.now() - 3_600_000).toISOString() }));
}

/** Resolves once action has started holding the lock. */
function startHolding<T>(start: (entered: () => void) => Promise<T>): { result: Promise<T>; entered: Promise<void> } {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return { result: start(entered), entered: started };
}

it("never frees a lock another recoverer took over and a new holder claimed while this recoverer was judging it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-recoverers-"));
  const lockPath = path.join(dir, "routing.lock");
  const detector = overlapDetector();
  const later: Promise<unknown>[] = [];
  await deadHolderLock(lockPath);
  // This recoverer judged the dead holder stale. Before it acts, another
  // recovers and releases the lock and a new holder claims it.
  fsHooks.beforeStaleMove = async () => {
    await withFileLock(lockPath, async () => await detector.hold(5), { staleMs: 1 });
    const holder = startHolding((entered) => withFileLock(lockPath, async () => { entered(); await detector.hold(800); }, { staleMs: 1 }));
    later.push(holder.result);
    await holder.entered;
    // While this recoverer inspects what it moved, a claimant tries the path.
    fsHooks.beforeStaleRead = async () => {
      const claimant = startHolding((entered) => withFileLock(lockPath, async () => { entered(); await detector.hold(50); }, { staleMs: 1 }));
      later.push(claimant.result);
      await Promise.race([claimant.entered, new Promise((resolve) => setTimeout(resolve, 300))]);
    };
  };
  try {
    await withFileLock(lockPath, async () => await detector.hold(5), { staleMs: 1 });
    await Promise.all(later);
    expect(detector.overlaps).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("never frees an ownerless lock whose creator records itself after a waiter judged it stale", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-resumed-"));
  const lockPath = path.join(dir, "routing.lock");
  let resume!: () => void;
  fsHooks.release = new Promise<void>((resolve) => { resume = resolve; });
  const paused = new Promise<void>((resolve) => { fsHooks.stalled = resolve; });
  fsHooks.armed = true;
  const detector = overlapDetector();
  const later: Promise<unknown>[] = [];
  try {
    const creator = startHolding((entered) => withFileLock(lockPath, async () => { entered(); await detector.hold(500); }, { staleMs: 1 }));
    await paused;
    fsHooks.agedPath = lockPath;
    // The waiter finds the lock ownerless past the bound; then the creator
    // resumes, records itself and starts its work.
    fsHooks.afterAgeCheck = async () => {
      fsHooks.agedPath = undefined;
      resume();
      await creator.entered;
      fsHooks.beforeStaleRead = async () => {
        const claimant = startHolding((entered) => withFileLock(lockPath, async () => { entered(); await detector.hold(50); }, { staleMs: 1 }));
        later.push(claimant.result);
        await Promise.race([claimant.entered, new Promise((resolve) => setTimeout(resolve, 300))]);
      };
    };
    await withFileLock(lockPath, async () => await detector.hold(5), { staleMs: 1 });
    await Promise.all([creator.result, ...later]);
    expect(detector.overlaps).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    resume?.();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps one holder at a time when several waiters recover the same dead holder's lock at once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-dead-"));
  let overlaps = 0;
  try {
    // 8 independent lanes of 25 rounds: 200 dead-holder locks, each recovered
    // by three concurrent waiters.
    await Promise.all(Array.from({ length: 8 }, async (_, lane) => {
      const lockPath = path.join(dir, `lane-${lane}.lock`);
      const lanes = overlapDetector();
      for (let round = 0; round < 25; round += 1) {
        await deadHolderLock(lockPath);
        await Promise.all(Array.from({ length: 3 }, async () => await withFileLock(lockPath, async () => await lanes.hold(Math.random() * 2), { staleMs: 1 })));
      }
      overlaps += lanes.overlaps;
    }));
    expect(overlaps).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

it("releases its lock after a recoverer that moved its record aside to compare it puts it back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-release-"));
  const lockPath = path.join(dir, "routing.lock");
  let restored: Promise<void> | undefined;
  try {
    await withFileLock(lockPath, async () => {
      const aside = path.join(lockPath, "owner.stale.other.json");
      await rename(path.join(lockPath, "owner.json"), aside);
      restored = new Promise((resolve) => setTimeout(resolve, 100)).then(async () => {
        await link(aside, path.join(lockPath, "owner.json"));
        await rm(aside);
      });
    });
    await restored;
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
