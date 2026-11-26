import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
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
  /** Asynchronous reads of the cache file that have finished (resolved or rejected). */
  readsDone: 0,
  /** Reads of the cache file let through before a stall applies. */
  passReads: 0,
  stallReads: null as Promise<void> | null,
  /** When set, only the read of the cache file with this ordinal (counting `reads`) stalls. */
  stallOnly: null as number | null,
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
      if (fsHooks.stallOnly !== null) {
        if (fsHooks.reads === fsHooks.stallOnly) {
          await fsHooks.stallReads;
        }
      } else if (fsHooks.passReads > 0) {
        fsHooks.passReads -= 1;
      } else {
        await fsHooks.stallReads;
      }
    }
    try {
      return await (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    } finally {
      if (file === fsHooks.cacheFile) {
        fsHooks.readsDone += 1;
      }
    }
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
  fsHooks.readsDone = 0;
  fsHooks.passReads = 0;
  fsHooks.stallOnly = null;
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

/** Real time passing (an observation window or an action's length), never a wait for a check to settle. */
function elapse(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WAIT = { timeout: 5_000, interval: 5 };

/**
 * Waits until `count` reads of the cache file have finished. A check goes on from a finished read in microtasks
 * only (to its claim, or its next read or request), so once the next macrotask runs, a check whose last read was one
 * of them has settled.
 */
async function untilReadsDone(count: number): Promise<void> {
  await vi.waitFor(() => expect(fsHooks.readsDone).toBeGreaterThanOrEqual(count), WAIT);
  await new Promise((resolve) => setImmediate(resolve));
}

/** Waits until the cache file records the delivery `notifiedAt` (a claim is on disk). */
async function untilNotifiedAt(notifiedAt: number): Promise<void> {
  await vi.waitFor(async () => expect(await cachedNotifiedAt()).toBe(notifiedAt), WAIT);
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
    // Settled at T0 + 1000: its first read, then its claim read and its refresh write's read (the rename is held).
    await untilReadsDone(3);
    clock = T0 + 1005;
    expect(await first.notice()).toBe(NOTICE_1_3_0);

    clock = T0 + 1031;
    const second = check({ now, intervalMs: 10, timeoutMs: 60_000, fetch: registry("9.9.9") });
    // A cache hit: settled once its one read has finished.
    await untilReadsDone(4);
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

/** Busy-waits, so the event loop runs nothing (no timer, no I/O callback) for `ms`, as `execSync` would. */
function blockSynchronously(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Blocking on purpose.
  }
}

/** Transpiles `src` into `directory` as ES modules that plain node loads (no loader, no build output). */
async function transpiledSources(directory: string): Promise<string> {
  const sources = fileURLToPath(new URL("../src/", import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  for (const name of (await readdir(sources)).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
    const { outputText } = ts.transpileModule(await readFile(path.join(sources, name), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    await writeFile(path.join(directory, name.replace(/\.ts$/, ".js")), outputText);
  }
  return directory;
}

async function cachedNotifiedAt(): Promise<number | undefined> {
  await settleCacheWrites();
  return (JSON.parse(await readFile(fsHooks.cacheFile, "utf8")) as { notifiedAt?: number }).notifiedAt;
}

describe("claim at settle", () => {
  it("writes the notice after an action that blocks synchronously past the timeout, then no run gives it again", async () => {
    await writeCacheJson({ checkedAt: Date.now(), latest: "1.3.0" });
    const updateCheck = check({ now: Date.now, timeoutMs: 1_000 });
    const events: string[] = [];

    const exitCode = await runAction(
      async () => {
        // The check settles first (a cache hit; its claim is on disk), then the action blocks the event loop past the
        // timeout.
        await vi.waitFor(async () => expect(await cachedNotifiedAt()).toEqual(expect.any(Number)), WAIT);
        blockSynchronously(1_200);
        return { exitCode: 3 };
      },
      undefined,
      {
        color: false,
        stdout: (text) => events.push(`out:${text}`),
        stderr: (text) => events.push(`err:${text}`),
        updateCheck,
      }
    );

    expect(exitCode).toBe(3);
    expect(events).toEqual([`err:${NOTICE_1_3_0}\n`]);
    expect(await cachedNotifiedAt()).toEqual(expect.any(Number));
    // Another handle in this process, and a fresh instance of the module (as another process would load it).
    expect(await check({ now: Date.now, timeoutMs: 1_000 }).notice()).toBeNull();
    vi.resetModules();
    const fresh = await import("../src/update-check.js");
    const other = fresh.startUpdateCheck({
      name: "my-cli",
      currentVersion: "1.2.0",
      appName: APP,
      env,
      terminal,
      timeoutMs: 1_000,
      fetch: registry(),
    });
    expect(await other.notice()).toBeNull();
  });

  it("reads the cache file no more after the check settled, and hands the notice out with no file access", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    let clock = T0;
    const handle = check({ now: () => clock, timeoutMs: 100 });
    await untilNotifiedAt(T0);
    const reads = fsHooks.reads;
    // Any read of the cache file would now stall.
    fsHooks.stallReads = gate();
    await elapse(1_200);
    clock = T0 + 5_000;

    const { notice } = await noticeWithin(handle, 1_000);

    expect(notice).toBe(NOTICE_1_3_0);
    expect(fsHooks.reads).toBe(reads);
    expect(fsHooks.syncReads).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "lets the process exit on its own when the cache file can no longer be read after the check settled",
    async () => {
      // A child process (pullfrog's method): once the check settled, the cache file becomes a FIFO nobody writes, so
      // any later read of it would never finish and would keep the child alive.
      // Plain node with no loader: the sources are transpiled with the declared `typescript` devDependency.
      const modules = await transpiledSources(path.join(root, "modules"));
      const moduleUrl = (name: string) => pathToFileURL(path.join(modules, name)).href;
      const script = String.raw`
        const [checkUrl, runnerUrl, pathsUrl, dir] = process.argv.slice(1);
        const { startUpdateCheck } = await import(checkUrl);
        const { resolveAppPaths } = await import(pathsUrl);
        const { runAction } = await import(runnerUrl);
        const { execFileSync } = await import("node:child_process");
        const { mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const env = { XDG_STATE_HOME: dir, LOCALAPPDATA: dir };
        const tty = { isTTY: true };
        const options = (appName) => ({ name: "my-cli", currentVersion: "1.2.0", appName, env,
          timeoutMs: 2_000, terminal: { stdin: tty, stdout: tty, stderr: tty },
          fetch: async () => { throw new Error("offline"); } });
        const results = [];
        for (const [appName, quiet] of [["shown-cli", false], ["quiet-cli", true], ["unasked-cli", null]]) {
          const state = resolveAppPaths(appName, { env }).state;
          await mkdir(state, { recursive: true });
          const file = path.join(state, "update-check.json");
          await writeFile(file, JSON.stringify({ checkedAt: Date.now(), latest: "1.3.0" }));
          const handle = startUpdateCheck(options(appName));
          // The check has settled once its claim is on disk (every handle claims; a quiet run discards later).
          const deadline = Date.now() + 5_000;
          while (JSON.parse(await readFile(file, "utf8")).notifiedAt === undefined) {
            if (Date.now() > deadline) throw new Error(appName + ": no claim");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await rm(file);
          execFileSync("mkfifo", [file]);
          if (quiet !== null) {
            const errors = [];
            await runAction(async () => ({ exitCode: 0 }),
              undefined, { color: false, quiet, stdout: () => undefined, stderr: (text) => errors.push(text), updateCheck: handle });
            results.push(appName + ":" + errors.length);
          } else {
            results.push(appName + ":unasked");
          }
        }
        process.stdout.write(results.join(","));
      `;
      const started = performance.now();
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script, moduleUrl("update-check.js"), moduleUrl("runner.js"), moduleUrl("paths.js"), root],
        { encoding: "utf8", timeout: 15_000 }
      );

      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("shown-cli:1,quiet-cli:0,unasked-cli:unasked");
      expect(performance.now() - started).toBeLessThan(10_000);
    },
    20_000
  );

  it.each([
    ["quiet", { quiet: true }],
    ["JSON", { mode: "json" as const }],
  ])("claims nothing for a %s run, so a later text run within the interval gives the notice", async (_label, mode) => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const events: string[] = [];
    // On its fixed clock the timeout cannot run down: notice() resolves only once the check has settled.
    const updateCheck = check({ now: () => T0 + 1, timeoutMs: 60_000 });
    const exitCode = await runAction(() => ({ exitCode: 0 }), undefined, {
      color: false,
      ...mode,
      stdout: () => undefined,
      stderr: (text) => events.push(text),
      updateCheck,
    });
    expect(exitCode).toBe(0);
    expect(events).toEqual([]);
    expect(await updateCheck.notice()).toBeNull();
    expect(await cachedNotifiedAt()).toBeUndefined();

    await runAction(() => ({ exitCode: 0 }), undefined, {
      color: false,
      stdout: () => undefined,
      stderr: (text) => events.push(text),
      updateCheck: check({ now: () => T0 + 2 }),
    });
    expect(events).toEqual([`${NOTICE_1_3_0}\n`]);
    expect(await cachedNotifiedAt()).toBe(T0 + 2);
  });

  it("keeps a claim made before discard() and gives no notice after it", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const handle = check({ now: () => T0 + 1 });
    await untilNotifiedAt(T0 + 1);
    handle.discard?.();

    expect(await handle.notice()).toBeNull();
    expect(await cachedNotifiedAt()).toBe(T0 + 1);
    expect(await check({ now: () => T0 + 2 }).notice()).toBeNull();
  });

  it("gives the claim to the handle whose check settled first, whichever handle asks first", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    const first = check({ now: () => T0 + 1 });
    await untilNotifiedAt(T0 + 1);
    // On its fixed clock, second.notice() resolves only once second's check has settled.
    const second = check({ now: () => T0 + 2, timeoutMs: 60_000 });

    expect(await second.notice()).toBeNull();
    expect(await first.notice()).toBe(NOTICE_1_3_0);
    expect(await cachedNotifiedAt()).toBe(T0 + 1);
  });

  it("drops a claim that is intervalMs old by hand-out, once another handle has claimed the next interval", async () => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0" });
    let clock = T0;
    const first = check({ now: () => clock, intervalMs: 500 });
    await untilNotifiedAt(T0);
    clock = T0 + 600;
    const second = check({ now: () => clock, intervalMs: 500 });
    await untilNotifiedAt(T0 + 600);

    expect(await second.notice()).toBe(NOTICE_1_3_0);
    expect(await first.notice()).toBeNull();
    expect(await cachedNotifiedAt()).toBe(T0 + 600);
  });

  it("gives each handle its notice once with a zero interval, after any action length", async () => {
    await writeCacheJson({ checkedAt: T0 - 1, latest: "1.3.0" });
    let clock = T0;
    const handles = [check({ now: () => clock, intervalMs: 0 }), check({ now: () => clock, intervalMs: 0 })];
    // Both claimed at T0: two first reads, then per handle its claim read, its refresh write's read and the read its
    // claim record merges with (which starts only after the claim).
    await untilReadsDone(8);
    clock = T0 + DAY;

    expect(await handles[0].notice()).toBe(NOTICE_1_3_0);
    expect(await handles[1].notice()).toBe(NOTICE_1_3_0);
    expect(await handles[0].notice()).toBeNull();
  });

  it("caches the registry's answer while the claim read stalls", async () => {
    await writeCacheJson({ checkedAt: T0 - 2 * DAY, latest: "1.3.0" });
    // Read 1 is the first cache read; read 2 is the claim read after the registry answered.
    fsHooks.stallOnly = 2;
    fsHooks.stallReads = gate();
    const handle = check({ fetch: registry("1.4.0"), timeoutMs: 60_000 });
    // Its first read and its refresh write's read have finished (the claim read stalls); the refresh write was queued
    // before the claim read started, so it is among the writes to settle.
    await untilReadsDone(2);
    await settleCacheWrites();

    expect(JSON.parse(await readFile(fsHooks.cacheFile, "utf8"))).toEqual({ checkedAt: T0, latest: "1.4.0" });
    releaseAll();
    expect(await handle.notice()).toBe("Update available: 1.2.0 → 1.4.0 (npm i -g my-cli)");
  });

  it("keeps the exit code when a quiet run's discard() rejects", async () => {
    const updateCheck = {
      notice: async () => null,
      discard: async () => {
        throw new Error("discard failed");
      },
    };
    const exitCode = await runAction(() => ({ exitCode: 4 }), undefined, {
      quiet: true,
      stdout: () => undefined,
      stderr: () => undefined,
      updateCheck,
    });
    // An unhandled rejection would fail this test run.
    await elapse(20);
    expect(exitCode).toBe(4);
  });

  it("gives no notice when another run recorded a delivery before this check's refresh settled", async () => {
    let clock = T0;
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const handle = check({ now: () => clock, timeoutMs: 1_000, fetch, intervalMs: DAY });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1), WAIT);
    // Another run delivers the notice while this one waits on the registry.
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
    answer();
    // Settled at T0: its first read, then its claim read and its refresh write's read.
    await untilReadsDone(3);
    clock = T0 + 5_000;

    const { notice } = await noticeWithin(handle, 1_000);

    expect(notice).toBeNull();
    expect(await cachedNotifiedAt()).toBe(T0);
  });

  it("decides the interval on the clock when the check settles", async () => {
    let clock = T0;
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const late = check({ now: () => clock, timeoutMs: 60_000, intervalMs: 10, fetch });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1), WAIT);
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 95 });
    // Still within the interval when the refresh settles: no claim, even though it has expired by hand-out time.
    clock = T0 + 101;
    answer();
    // Settled at T0 + 101: its first read, then its claim read and its refresh write's read; the refresh write lands
    // before the file is rewritten below.
    await untilReadsDone(3);
    await settleCacheWrites();
    clock = T0 + 200;
    expect(await late.notice()).toBeNull();

    // A delivery that expired by the time the check settles does not hold the notice back.
    await writeCacheJson({ checkedAt: T0 + 200, latest: "1.3.0", notifiedAt: T0 + 150 });
    const due = check({ now: () => clock, intervalMs: 10 });
    await untilNotifiedAt(T0 + 200);
    expect(await due.notice()).toBe(NOTICE_1_3_0);
    expect(await cachedNotifiedAt()).toBe(T0 + 200);
  });

  it("gives no notice and records no claim when the claim read does not finish by the timeout", async () => {
    let answer: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 }));
        })
    );
    const updateCheck = check({ now: Date.now, timeoutMs: 200, fetch });
    const events: string[] = [];
    const started = performance.now();
    const action = runAction(
      async () => {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1), WAIT);
        // The refresh's claim read stalls.
        fsHooks.stallReads = gate();
        answer();
        return { exitCode: 3 };
      },
      undefined,
      { color: false, stdout: () => undefined, stderr: (text) => events.push(text), updateCheck }
    );

    expect(await action).toBe(3);
    expect(performance.now() - started).toBeLessThan(200 + 80);
    expect(events).toEqual([]);
    releaseAll();
    // Settled (past its deadline): its first read, then its claim read and its refresh write's read.
    await untilReadsDone(3);
    expect(await cachedNotifiedAt()).toBeUndefined();
    expect(await updateCheck.notice()).toBeNull();
  });

  it.each([
    ["is not a number", () => Number.NaN],
    [
      "throws",
      () => {
        throw new Error("clock");
      },
    ],
  ])("claims nothing when the clock at settle %s", async (_label, broken) => {
    await writeCacheJson({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 - DAY - 10 });
    let clock: () => number = () => T0;
    const handle = check({ now: () => clock(), timeoutMs: 60_000 });
    // Asked before the clock breaks, notice() resolves only once the check has settled (on the broken clock).
    const asked = handle.notice();
    clock = broken;
    expect(await asked).toBeNull();
    clock = () => T0;

    expect(await handle.notice()).toBeNull();
    // Nothing was claimed: the next run gives the notice.
    expect(await check({ now: () => T0 + 1 }).notice()).toBe(NOTICE_1_3_0);
  });

  it.each([
    ["a cache hit", { checkedAt: T0, latest: "1.3.0", notifiedAt: T0 - DAY - 10 }, 1],
    ["a refresh", { checkedAt: T0 - 2 * DAY, latest: "1.3.0" }, 2],
  ])("records the claim time on %s when the clock stops telling the time while it is written", async (_label, cached, pass) => {
    let clock: () => number = () => T0 + 20;
    await writeCacheJson(cached);
    // The claim read passes; the read the write merges with stalls until the clock has stopped.
    fsHooks.passReads = pass;
    fsHooks.stallReads = gate();
    const handle = check({ now: () => clock(), timeoutMs: 60_000 });
    // Settled (and claimed at T0 + 20) once the reads let through have finished; the claim read is the last of them.
    await untilReadsDone(pass);
    clock = () => Number.NaN;
    releaseAll();
    await settleCacheWrites();
    clock = () => T0 + 20;

    expect(await handle.notice()).toBe(NOTICE_1_3_0);
    expect(await cachedNotifiedAt()).toBe(T0 + 20);
  });
});
