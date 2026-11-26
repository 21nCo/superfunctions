import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "../src/paths.js";
import { runAction } from "../src/runner.js";
import { startUpdateCheck, type UpdateCheckFetch, type UpdateCheckOptions } from "../src/update-check.js";
import { settleCacheWrites } from "../src/update-check-cache.js";

// The file system as the update check sees it: reads of the cache file can be stalled, renames onto it held, and
// synchronous reads of it are counted (the hand-out must do none).
const fsHooks = vi.hoisted(() => ({
  cacheFile: "",
  syncReads: 0,
  /** Asynchronous reads of the cache file. */
  reads: 0,
  /** Reads of the cache file let through before a stall applies. */
  passReads: 0,
  stallReads: null as Promise<void> | null,
  holdRenames: null as Promise<void> | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (file === fsHooks.cacheFile) {
      fsHooks.syncReads += 1;
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (file: unknown, ...rest: unknown[]) => {
    if (file === fsHooks.cacheFile) {
      fsHooks.reads += 1;
    }
    if (file === fsHooks.cacheFile && fsHooks.stallReads) {
      if (fsHooks.passReads > 0) {
        fsHooks.passReads -= 1;
      } else {
        await fsHooks.stallReads;
      }
    }
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  }) as typeof actual.readFile;
  const rename = (async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
    if (to === fsHooks.cacheFile && fsHooks.holdRenames) {
      await fsHooks.holdRenames;
    }
    return actual.rename(from, to);
  }) as typeof actual.rename;
  return { ...actual, readFile, rename, default: { ...actual, readFile, rename } };
});

const tty = { isTTY: true };
const terminal = { stdin: tty, stdout: tty, stderr: tty };
const APP = "my-cli";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const NOTICE_1_3_0 = "Update available: 1.2.0 → 1.3.0 (npm i -g my-cli)";

let root: string;
let env: Record<string, string>;
let stateDir: string;
let releaseFs: () => void = () => undefined;

function gate(): Promise<void> {
  return new Promise<void>((resolve) => {
    const previous = releaseFs;
    releaseFs = () => {
      previous();
      resolve();
    };
  });
}

function releaseAll(): void {
  fsHooks.stallReads = null;
  fsHooks.holdRenames = null;
  releaseFs();
  releaseFs = () => undefined;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "clifn-update-delivery-"));
  env = { XDG_STATE_HOME: root, LOCALAPPDATA: root };
  stateDir = resolveAppPaths(APP, { env }).state;
  fsHooks.cacheFile = path.join(stateDir, "update-check.json");
  fsHooks.syncReads = 0;
  fsHooks.reads = 0;
  fsHooks.passReads = 0;
});

afterEach(async () => {
  releaseAll();
  await settleCacheWrites();
  await rm(root, { recursive: true, force: true });
});

function registry(latest = "1.3.0") {
  return vi.fn<UpdateCheckFetch>(async () => new Response(JSON.stringify({ latest }), { status: 200 }));
}

function check(overrides: Partial<UpdateCheckOptions> = {}) {
  return startUpdateCheck({
    name: "my-cli",
    currentVersion: "1.2.0",
    appName: APP,
    env,
    terminal,
    now: () => T0,
    fetch: registry(),
    ...overrides,
  });
}

async function writeCacheJson(value: unknown): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(fsHooks.cacheFile, `${JSON.stringify(value)}\n`);
}

/** Real time for the background check to settle (its reads are real file reads). */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The notice, or "hung" when it is not there within `ms`. */
async function noticeWithin(handle: { notice(): Promise<string | null> }, ms: number) {
  const started = performance.now();
  const hung = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms));
  const notice = await Promise.race([handle.notice(), hung]);
  return { notice, elapsed: performance.now() - started };
}

describe("delivery records", () => {
  it("keeps the later delivery when an earlier one is recorded behind a held refresh", async () => {
    let clock = T0 + 1000;
    const now = () => clock;
    // checkedAt in the future: the first handle refreshes; a later handle finds it fresh and uses it.
    await writeCacheJson({ checkedAt: T0 + 1025, latest: "1.3.0" });
    fsHooks.holdRenames = gate();

    const first = check({ now, intervalMs: 10, timeoutMs: 60_000 });
    await settle();
    clock = T0 + 1020;
    expect(await first.notice()).toBe(NOTICE_1_3_0);

    clock = T0 + 1031;
    const second = check({ now, intervalMs: 10, timeoutMs: 60_000, fetch: registry("9.9.9") });
    await settle();
    expect(await second.notice()).toBe(NOTICE_1_3_0);

    releaseAll();
    await settleCacheWrites();
    const file = JSON.parse(await readFile(fsHooks.cacheFile, "utf8")) as { notifiedAt?: number };
    expect(file.notifiedAt).toBe(T0 + 1031);

    clock = T0 + 1035;
    const fresh = check({ now, intervalMs: 10, timeoutMs: 60_000 });
    expect(await fresh.notice()).toBeNull();
  });
});

describe("hand-out without blocking", () => {
  it("drops the notice when the hand-out read stalls, within the timeout", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ timeoutMs: 200 });
    await settle();
    fsHooks.stallReads = gate();

    const { notice, elapsed } = await noticeWithin(handle, 2_000);

    expect(notice).toBeNull();
    expect(elapsed).toBeLessThan(200 + 150);
    expect(fsHooks.syncReads).toBe(0);
  });

  it("keeps runAction's exit code and its timeout when the hand-out read stalls", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const updateCheck = check({ timeoutMs: 200 });
    await settle();
    fsHooks.stallReads = gate();
    const events: string[] = [];

    const started = performance.now();
    const exitCode = await runAction(() => ({ exitCode: 3 }), undefined, {
      color: false,
      stdout: (text) => events.push(`out:${text}`),
      stderr: (text) => events.push(`err:${text}`),
      updateCheck,
    });

    expect(exitCode).toBe(3);
    expect(performance.now() - started).toBeLessThan(200 + 150);
    expect(events.filter((event) => event.startsWith("err:"))).toEqual([]);
  });

  it("hands out a ready notice after an action longer than the timeout without reading the file", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ now: () => clock, timeoutMs: 100 });
    await settle();
    clock = T0 + 5_000;
    // Any read of the cache file at hand-out would now stall.
    fsHooks.stallReads = gate();

    const { notice } = await noticeWithin(handle, 1_000);

    expect(notice).toBe(NOTICE_1_3_0);
    expect(fsHooks.syncReads).toBe(0);
  });

  it("gives no notice when another run recorded a delivery before this check settled", async () => {
    let clock = T0;
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const handle = check({ now: () => clock, timeoutMs: 1_000, fetch, intervalMs: DAY });
    await settle(20);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Another run delivers the notice while this one waits on the registry.
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
    answer();
    await settle();
    clock = T0 + 5_000;

    const { notice } = await noticeWithin(handle, 1_000);

    expect(notice).toBeNull();
    expect(fsHooks.syncReads).toBe(0);
  });

  it("discards a hand-out read that finishes after the deadline", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ now: () => clock, timeoutMs: 1_000 });
    await settle();
    fsHooks.stallReads = gate();

    const pending = handle.notice();
    await settle(20);
    clock = T0 + 5_000;
    releaseAll();

    expect(await pending).toBeNull();
    await settleCacheWrites();
    const file = JSON.parse(await readFile(fsHooks.cacheFile, "utf8")) as { notifiedAt?: number };
    expect(file.notifiedAt).toBeUndefined();
  });

  it("drops the notice when another run records a delivery while the hand-out read is in flight", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ now: () => clock, timeoutMs: 60_000 });
    await settle();
    fsHooks.stallReads = gate();

    const pending = handle.notice();
    await settle(20);
    // Another run delivers one millisecond after this hand-out began.
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 1 });
    clock = T0 + 1;
    releaseAll();

    expect(await pending).toBeNull();
  });

  it("lets a second handle give the notice when the first one's hand-out read times out", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const first = check({ timeoutMs: 100 });
    const second = check({ timeoutMs: 5_000 });
    await settle();
    fsHooks.stallReads = gate();

    const firstNotice = first.notice();
    const secondNotice = second.notice();
    expect(await firstNotice).toBeNull();
    releaseAll();

    expect(await secondNotice).toBe(NOTICE_1_3_0);
  });

  it("lets a waiting handle with a zero interval give the notice after another handle delivered", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const first = check();
    const second = check({ intervalMs: 0 });
    await settle();
    fsHooks.stallReads = gate();

    const firstNotice = first.notice();
    const secondNotice = second.notice();
    await settle(20);
    releaseAll();

    expect(await firstNotice).toBe(NOTICE_1_3_0);
    expect(await secondNotice).toBe(NOTICE_1_3_0);
  });

  it("weighs a delivery seen when a refresh settled at hand-out time", async () => {
    let clock = T0;
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const handle = check({ now: () => clock, timeoutMs: 60_000, intervalMs: 10, fetch });
    await settle(20);
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 95 });
    clock = T0 + 101;
    answer();
    await settle();
    clock = T0 + 106;

    expect(await handle.notice()).toBe(NOTICE_1_3_0);
  });

  it("shares one budget between waiting for the result and the hand-out read under a fixed clock", async () => {
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const handle = check({ timeoutMs: 200, fetch });
    const started = performance.now();
    const pending = handle.notice();
    await settle(150);
    // The refresh's settle read and its write's merge read finish; the hand-out read stalls.
    fsHooks.passReads = 2;
    fsHooks.stallReads = gate();
    answer();

    const notice = await pending;

    expect(notice).toBeNull();
    expect(performance.now() - started).toBeLessThan(200 + 80);
  });
});

describe("claim kept current after the check settles", () => {
  it("gives no notice after a long action when another run recorded a delivery after a cache hit settled", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ now: () => clock, timeoutMs: 100 });
    await settle();
    clock = T0 + 30;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 30 });
    await settle(500);
    clock = T0 + 300;

    expect(await handle.notice()).toBeNull();
  });

  it("gives no notice after a long action when another run recorded a delivery after a refresh settled", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0 - 2 * DAY, latest: "1.3.0" });
    const fetch = registry();
    const handle = check({ now: () => clock, timeoutMs: 100, fetch });
    await settle();
    await settleCacheWrites();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = T0 + 30;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 30 });
    await settle(500);
    clock = T0 + 300;

    expect(await handle.notice()).toBeNull();
  });

  it("keeps a delivery seen when the check settled when the hand-out read finds no valid cache", async () => {
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const handle = check({ timeoutMs: 60_000, fetch });
    await settle(20);
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
    answer();
    await settle();
    await settleCacheWrites();
    await writeFile(fsHooks.cacheFile, "{");

    expect(await handle.notice()).toBeNull();
  });

  it("weighs a delivery time that was in the future when the check settled at hand-out time", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 50 });
    const handle = check({ now: () => clock, timeoutMs: 10 });
    await settle();
    fsHooks.stallReads = gate();
    clock = T0 + 60;

    expect(await handle.notice()).toBeNull();
  });

  it("gives the notice when the delivery seen when the check settled has expired by hand-out time", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 - DAY + 10 });
    const handle = check({ now: () => clock, timeoutMs: 60_000 });
    await settle();
    clock = T0 + 20;

    expect(await handle.notice()).toBe(NOTICE_1_3_0);
  });

  it.each([
    ["is not a number", () => Number.NaN],
    [
      "throws",
      () => {
        throw new Error("clock");
      },
    ],
  ])("gives no notice and records none when the clock at hand-out %s", async (_label, broken) => {
    let clock: () => number = () => T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 - 10 });
    const handle = check({ now: () => clock(), timeoutMs: 60_000 });
    await settle();
    clock = broken;

    expect(await handle.notice()).toBeNull();
    await settleCacheWrites();
    const file = JSON.parse(await readFile(fsHooks.cacheFile, "utf8")) as { notifiedAt?: number };
    expect(file.notifiedAt).toBe(T0 - 10);
  });

  it("still gives the notice after an asynchronous action longer than the timeout", async () => {
    await writeCacheJson({ checkedAt: Date.now(), latest: "1.3.0" });
    const updateCheck = check({ now: Date.now, timeoutMs: 100 });
    const events: string[] = [];

    const exitCode = await runAction(
      async () => {
        await settle(600);
        return { exitCode: 0 };
      },
      undefined,
      {
        color: false,
        stdout: (text) => events.push(`out:${text}`),
        stderr: (text) => events.push(`err:${text}`),
        updateCheck,
      }
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual([`err:${NOTICE_1_3_0}\n`]);
  });

  it("gives no notice after the timeout when the last completed read is stale", async () => {
    let clock = T0;
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ now: () => clock, timeoutMs: 100 });
    await settle();
    fsHooks.stallReads = gate();
    await settle(1_300);
    clock = T0 + 2_000;

    expect(await handle.notice()).toBeNull();
  });

  it("rereads in the background without keeping the process alive, and stops after the hand-out", async () => {
    // The documented reread period is 250 ms; every timer of that period the check starts must be unref'd.
    const realSetTimeout = globalThis.setTimeout;
    const rereadTimers: Array<ReturnType<typeof setTimeout>> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(callback, ms, ...args);
      if (ms === 250) {
        rereadTimers.push(timer);
      }
      return timer;
    }) as typeof setTimeout);
    try {
      await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
      const handle = check({ timeoutMs: 60_000 });
      await settle(600);

      expect(fsHooks.reads).toBeGreaterThan(1);
      expect(rereadTimers.length).toBeGreaterThan(0);
      expect(rereadTimers.filter((timer) => timer.hasRef())).toEqual([]);

      expect(await handle.notice()).toBe(NOTICE_1_3_0);
      await settleCacheWrites();
      const reads = fsHooks.reads;
      await settle(600);
      expect(fsHooks.reads).toBe(reads);
    } finally {
      spy.mockRestore();
    }
  });
});
