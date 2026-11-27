import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "../src/paths.js";
import {
  startUpdateCheck,
  updateCheckOptOutVariable,
  type UpdateCheckFetch,
  type UpdateCheckOptions,
  type UpdateCheckRequestInit,
} from "../src/update-check.js";
import { recordDeliveryQuietly, settleCacheWrites } from "../src/update-check-cache.js";

// Reads of the cache file that have finished: a check goes on from a finished read in microtasks only, so once the
// next macrotask runs after its last read, it has settled. Every other file operation is passed through unchanged.
const cacheReads = vi.hoisted(() => ({ file: "", done: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (file: unknown, ...rest: unknown[]) => {
    try {
      return await (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    } finally {
      if (file === cacheReads.file) {
        cacheReads.done += 1;
      }
    }
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const tty = { isTTY: true };
const pipe = { isTTY: false };
const terminal = { stdin: tty, stdout: tty, stderr: tty };
const APP = "my-cli";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const NOTICE_1_3_0 = "Update available: 1.2.0 → 1.3.0 (npm i -g my-cli)";

let root: string;
let env: Record<string, string>;
let stateDir: string;
let cacheFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "clifn-update-check-"));
  // XDG_STATE_HOME places the state directory on POSIX, LOCALAPPDATA on Windows.
  env = { XDG_STATE_HOME: root, LOCALAPPDATA: root };
  stateDir = resolveAppPaths(APP, { env }).state;
  cacheFile = path.join(stateDir, "update-check.json");
  cacheReads.file = cacheFile;
  cacheReads.done = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await settleCacheWrites();
  await rm(root, { recursive: true, force: true });
});

function registry(body: unknown, status = 200) {
  return vi.fn<UpdateCheckFetch>(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  );
}

function check(overrides: Partial<UpdateCheckOptions> = {}) {
  return startUpdateCheck({
    name: "my-cli",
    currentVersion: "1.2.0",
    appName: APP,
    env,
    terminal,
    now: () => T0,
    fetch: registry({ latest: "1.3.0" }),
    ...overrides,
  });
}

/** One run: the notice, once every cache write it started has finished. */
async function run(overrides: Partial<UpdateCheckOptions> = {}): Promise<string | null> {
  const notice = await check(overrides).notice();
  await settleCacheWrites();
  return notice;
}

async function writeCacheText(text: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(cacheFile, text);
}

/** The cache file once every write started so far has finished. */
async function readCacheJson(): Promise<unknown> {
  await settleCacheWrites();
  return JSON.parse(await readFile(cacheFile, "utf8"));
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  );
}

/**
 * A timeout that cannot run down on a fixed injected clock: `notice()` then resolves only once the check has settled
 * (never by its deadline within a test), so a `null` it gives is the settled check's answer.
 */
const SETTLE_ONLY_MS = 60_000;

/** Waits (real timers) until the cache file satisfies `condition`, failing after five seconds. */
async function untilCached(condition: (cached: Record<string, unknown>) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition(((await readCacheJson().catch(() => ({}))) ?? {}) as Record<string, unknown>)) {
    if (Date.now() > deadline) {
      throw new Error("the cache file never reached the expected state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until `count` reads of the cache file have finished, then one macrotask more (see `cacheReads`). */
async function untilReadsDone(count: number): Promise<void> {
  await until(() => cacheReads.done >= count);
  await new Promise((resolve) => setImmediate(resolve));
}

/** Lets real I/O progress while fake timers hold `setTimeout`, failing after five seconds of real time. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!(await condition())) {
    if (performance.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("startUpdateCheck: request and notice", () => {
  it("gives a notice for a newer stable release and caches it", async () => {
    const fetch = registry({ latest: "1.3.0", next: "2.0.0-rc.1" });

    await expect(check({ fetch }).notice()).resolves.toBe(NOTICE_1_3_0);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://registry.npmjs.org/-/package/my-cli/dist-tags");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Resolving with the notice records its delivery.
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
    expect(await readdir(stateDir)).toEqual(["update-check.json"]);
  });

  it.each([
    ["an equal version", "1.2.0"],
    ["an older version", "1.1.9"],
    ["a newer prerelease", "1.3.0-beta.1"],
    ["a prerelease of the current version", "1.2.0-rc.1"],
  ])("gives no notice for %s and caches it", async (_label, latest) => {
    await expect(check({ fetch: registry({ latest }) }).notice()).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest });
  });

  it("compares by SemVer precedence, not text", async () => {
    await expect(check({ currentVersion: "1.9.0", fetch: registry({ latest: "1.10.0" }) }).notice()).resolves.toBe(
      "Update available: 1.9.0 → 1.10.0 (npm i -g my-cli)"
    );
  });

  it("tells a prerelease user about the release", async () => {
    await expect(check({ currentVersion: "1.3.0-beta.2", fetch: registry({ latest: "1.3.0" }) }).notice()).resolves.toBe(
      "Update available: 1.3.0-beta.2 → 1.3.0 (npm i -g my-cli)"
    );
  });

  it.each<[string, () => ReturnType<typeof registry>]>([
    ["a 500", () => registry({ latest: "9.0.0" }, 500)],
    ["a 404", () => registry({ error: "not found" }, 404)],
    ["a 204", () => registry("", 204)],
    ["invalid JSON", () => registry("{")],
    ["an HTML page", () => registry("<html>proxy login</html>")],
    ["a missing latest", () => registry({ next: "2.0.0" })],
    ["a non-string latest", () => registry({ latest: 2 })],
    ["a latest outside the grammar", () => registry({ latest: "v2.0.0" })],
    ["a latest with control characters", () => registry({ latest: "2.0.0-\u001b[31m" })],
    ["an array body", () => registry(["2.0.0"])],
    ["a JSON null body", () => registry("null")],
    ["a body over 64 KiB", () => registry({ latest: "2.0.0", padding: "x".repeat(70_000) })],
    [
      // About 41 K characters but 82 KiB of UTF-8: the limit counts bytes, also without a body stream.
      "a text-only body over 64 KiB in bytes but not in characters",
      () =>
        vi.fn<UpdateCheckFetch>(async () => ({
          status: 200,
          body: null,
          text: async () => JSON.stringify({ latest: "2.0.0", padding: "é".repeat(40 * 1024) }),
        })),
    ],
    [
      "a 500 whose body cancel never settles",
      () =>
        vi.fn<UpdateCheckFetch>(async () => ({
          status: 500,
          body: { cancel: () => new Promise<void>(() => undefined) } as unknown as ReadableStream<Uint8Array>,
          text: () => new Promise<string>(() => undefined),
        })),
    ],
    [
      "a 500 whose body cancel throws",
      () =>
        vi.fn<UpdateCheckFetch>(async () => ({
          status: 500,
          body: {
            cancel: () => {
              throw new Error("locked");
            },
          } as unknown as ReadableStream<Uint8Array>,
          text: () => Promise.resolve(""),
        })),
    ],
    [
      "a network error",
      () =>
        vi.fn<UpdateCheckFetch>(async () => {
          throw new TypeError("fetch failed");
        }),
    ],
    [
      "a fetch that throws synchronously",
      () =>
        vi.fn<UpdateCheckFetch>(() => {
          throw new Error("boom");
        }),
    ],
    [
      "a body that fails while it is read",
      () =>
        vi.fn<UpdateCheckFetch>(async () => ({
          status: 200,
          body: null,
          text: () => Promise.reject(new Error("socket hang up")),
        })),
    ],
  ])("gives no notice for %s and caches an error", async (_label, makeFetch) => {
    const fetch = makeFetch();
    await expect(check({ fetch }).notice()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, error: true });
  });

  it.each([
    ["one that honours its signal", true],
    ["one that ignores its signal", false],
  ])("drops a request that outlives the timeout (%s) and caches an error", async (_label, honoursSignal) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = T0;
    let seen: UpdateCheckRequestInit | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          seen = init;
          if (honoursSignal) {
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }
        })
    );

    const handle = check({ fetch, now: () => clock, timeoutMs: 1_500 });
    const notice = handle.notice();
    await until(() => fetch.mock.calls.length === 1);

    clock += 1_499;
    await vi.advanceTimersByTimeAsync(1_499);
    expect(seen?.signal.aborted).toBe(false);
    clock += 1;
    await vi.advanceTimersByTimeAsync(1);

    await expect(notice).resolves.toBeNull();
    expect(seen?.signal.aborted).toBe(true);
    await until(() => exists(cacheFile));
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + 1_500, error: true });
  });

  it("drops a notice that is not ready when the timeout has already passed", async () => {
    let clock = T0;
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(() => new Promise((resolve) => (respond = resolve)));
    const handle = check({ fetch, now: () => clock, timeoutMs: 1_500 });
    await until(() => fetch.mock.calls.length === 1);

    clock += 1_500;
    const started = Date.now();
    await expect(handle.notice()).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    respond?.(new Response(JSON.stringify({ latest: "1.3.0" })));
    // The late result is still cached for the next run.
    await until(() => exists(cacheFile));
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + 1_500, latest: "1.3.0" });
  });

  it("drops a result that arrives after the deadline, even when notice() is first called later", async () => {
    let clock = T0;
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(() => new Promise((resolve) => (respond = resolve)));
    // The deadline passes on the injected clock only: the request's real abort timer cannot fire during the test.
    const handle = check({ fetch, now: () => clock, timeoutMs: SETTLE_ONLY_MS });
    await until(() => fetch.mock.calls.length === 1);

    clock += SETTLE_ONLY_MS + 1;
    respond?.(new Response(JSON.stringify({ latest: "1.3.0" })));
    // Settled past the deadline before notice() is first called: its first read, then its claim read and its refresh
    // write's read have finished.
    await untilReadsDone(3);

    await expect(handle.notice()).resolves.toBeNull();
    await expect(handle.notice()).resolves.toBeNull();
    const cached = (await readCacheJson()) as Record<string, unknown>;
    expect(cached).toMatchObject({ latest: "1.3.0" });
    expect(cached).not.toHaveProperty("notifiedAt");
  });

  it("keeps a notice dropped by the timeout dropped and does not count it as delivered", async () => {
    let clock = T0;
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(() => new Promise((resolve) => (respond = resolve)));
    // The deadline passes on the injected clock only: the request's real abort timer cannot fire during the test.
    const handle = check({ fetch, now: () => clock, timeoutMs: SETTLE_ONLY_MS });
    await until(() => fetch.mock.calls.length === 1);

    clock += SETTLE_ONLY_MS;
    await expect(handle.notice()).resolves.toBeNull();
    respond?.(new Response(JSON.stringify({ latest: "1.3.0" })));
    // Settled after the deadline expired it: its first read, then its claim read and its refresh write's read.
    await untilReadsDone(3);
    // The result settled after the deadline: a later call does not return it either.
    await expect(handle.notice()).resolves.toBeNull();
    const cached = (await readCacheJson()) as Record<string, unknown>;
    expect(cached).toMatchObject({ latest: "1.3.0" });
    expect(cached).not.toHaveProperty("notifiedAt");

    // The next run within the interval gives the notice from the cache, without a request.
    const next = registry({ latest: "1.3.0" });
    await expect(run({ fetch: next, now: () => (cached.checkedAt as number) + 1 })).resolves.toBe(NOTICE_1_3_0);
    expect(next).not.toHaveBeenCalled();
  });

  it("waits for a slow registry only within the timeout and gives the notice to the first call only", async () => {
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(() => new Promise((resolve) => (respond = resolve)));
    const handle = check({ fetch, now: () => Date.now(), timeoutMs: 5_000 });
    const first = handle.notice();
    const second = handle.notice();
    await until(() => fetch.mock.calls.length === 1);
    respond?.(new Response(JSON.stringify({ latest: "1.3.0" })));

    await expect(first).resolves.toBe(NOTICE_1_3_0);
    await expect(second).resolves.toBeNull();
    await expect(handle.notice()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives a ready notice to one notice() call per handle", async () => {
    const handle = check();
    // Ready: the claim made when the check settled is on disk.
    await untilCached((cached) => cached.notifiedAt === T0);
    await expect(handle.notice()).resolves.toBe(NOTICE_1_3_0);
    await expect(handle.notice()).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
  });

  it("measures the timeout on the monotonic clock when no clock is injected", async () => {
    let wallClock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(() => new Promise((resolve) => (respond = resolve)));
    const handle = startUpdateCheck({
      name: "my-cli",
      currentVersion: "1.2.0",
      appName: APP,
      env,
      terminal,
      fetch,
      timeoutMs: 5_000,
    });
    await until(() => fetch.mock.calls.length === 1);
    // The wall clock jumps an hour ahead; the timeout has not passed.
    wallClock = T0 + 60 * 60 * 1000;
    respond?.(new Response(JSON.stringify({ latest: "1.3.0" })));

    await expect(handle.notice()).resolves.toBe(NOTICE_1_3_0);
  });

});

describe("startUpdateCheck: registry and name encoding", () => {
  it.each<[string, Partial<UpdateCheckOptions>, string]>([
    ["a scoped name", { name: "@scope/my-cli" }, "https://registry.npmjs.org/-/package/@scope%2Fmy-cli/dist-tags"],
    [
      "an https npm_config_registry with a path",
      { env: { npm_config_registry: "https://registry.example.test/npm/" } },
      "https://registry.example.test/npm/-/package/my-cli/dist-tags",
    ],
    [
      "an https NPM_CONFIG_REGISTRY",
      { env: { NPM_CONFIG_REGISTRY: "https://upper.example.test" } },
      "https://upper.example.test/-/package/my-cli/dist-tags",
    ],
    [
      "npm_config_registry before NPM_CONFIG_REGISTRY",
      { env: { npm_config_registry: "https://lower.example.test/", NPM_CONFIG_REGISTRY: "https://upper.example.test/" } },
      "https://lower.example.test/-/package/my-cli/dist-tags",
    ],
    [
      "an http npm_config_registry (ignored)",
      { env: { npm_config_registry: "http://plain.example.test/" } },
      "https://registry.npmjs.org/-/package/my-cli/dist-tags",
    ],
    [
      "a malformed npm_config_registry (ignored)",
      { env: { npm_config_registry: "not a url" } },
      "https://registry.npmjs.org/-/package/my-cli/dist-tags",
    ],
    [
      "the registryUrl option before the environment",
      { registryUrl: "https://option.example.test/base//", env: { npm_config_registry: "https://lower.example.test/" } },
      "https://option.example.test/base/-/package/my-cli/dist-tags",
    ],
  ])("requests %s", async (_label, overrides, expected) => {
    const fetch = registry({ latest: "1.3.0" });
    await check({ fetch, ...overrides, env: { ...env, ...overrides.env } }).notice();
    expect(fetch.mock.calls[0]?.[0]).toBe(expected);
  });
});

describe("startUpdateCheck: skip rules (D10)", () => {
  it.each<[string, Partial<UpdateCheckOptions>]>([
    ["JSON mode", { terminal: { ...terminal, json: true } }],
    ["a non-TTY stdin", { terminal: { ...terminal, stdin: pipe } }],
    ["a non-TTY stderr", { terminal: { ...terminal, stderr: pipe } }],
    ["CI set", { env: { CI: "true" } }],
    ["CI=false (set)", { env: { CI: "false" } }],
    ["NO_UPDATE_NOTIFIER set", { env: { NO_UPDATE_NOTIFIER: "1" } }],
    ["<APP>_NO_UPDATE_CHECK set", { env: { MY_CLI_NO_UPDATE_CHECK: "1" } }],
    ["a currentVersion of 1.2", { currentVersion: "1.2" }],
    ["a currentVersion of v1.2.0", { currentVersion: "v1.2.0" }],
    ["a currentVersion of 1.2.0.1", { currentVersion: "1.2.0.1" }],
  ])("skips for %s without a request or cache access", async (_label, overrides) => {
    const fetch = registry({ latest: "9.0.0" });
    const handle = check({ fetch, ...overrides, env: { ...env, ...overrides.env } });
    await expect(handle.notice()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await exists(stateDir)).toBe(false);
  });

  it("names the opt-out variable after the app name with - and . as _", async () => {
    expect(updateCheckOptOutVariable("my.cli-tool")).toBe("MY_CLI_TOOL_NO_UPDATE_CHECK");
    const fetch = registry({ latest: "9.0.0" });
    const handle = check({ fetch, appName: "my.cli-tool", env: { ...env, MY_CLI_TOOL_NO_UPDATE_CHECK: "yes" } });
    await expect(handle.notice()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not skip for empty variables or another app's opt-out", async () => {
    const fetch = registry({ latest: "1.3.0" });
    const handle = check({
      fetch,
      env: { ...env, CI: "", NO_UPDATE_NOTIFIER: "", MY_CLI_NO_UPDATE_CHECK: "", OTHER_NO_UPDATE_CHECK: "1" },
    });
    await expect(handle.notice()).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("startUpdateCheck: cache interval", () => {
  it("uses the cached result within the interval without a second notice and requests again after it", async () => {
    await expect(run()).resolves.toBe(NOTICE_1_3_0);

    const fetch = registry({ latest: "1.4.0" });
    await expect(run({ fetch, now: () => T0 + DAY - 1 })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    await expect(run({ fetch, now: () => T0 + DAY })).resolves.toBe(
      "Update available: 1.2.0 → 1.4.0 (npm i -g my-cli)"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + DAY, latest: "1.4.0", notifiedAt: T0 + DAY });
  });

  it("gives the notice at most once per interval, also across a refresh, and reads older cache files", async () => {
    // A cache file without notifiedAt: an older file, or one whose notice was never delivered.
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0" }));
    const fetch = registry({ latest: "1.3.0" });
    const hour = 60 * 60 * 1000;

    await expect(run({ fetch, now: () => T0 + hour })).resolves.toBe(NOTICE_1_3_0);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + hour });
    await expect(run({ fetch, now: () => T0 + 2 * hour })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    // The cached result is stale, so the registry is asked again, but the last notice was less than a day ago.
    await expect(run({ fetch, now: () => T0 + DAY })).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + DAY, latest: "1.3.0", notifiedAt: T0 + hour });

    await expect(run({ fetch, now: () => T0 + DAY + hour })).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "a newer error entry",
      { checkedAt: T0 + 10, error: true },
      { checkedAt: T0 + 10, error: true, notifiedAt: T0 + 20 },
    ],
    [
      "a newer entry for another version",
      { checkedAt: T0 + 10, latest: "1.4.0" },
      { checkedAt: T0 + 10, latest: "1.4.0", notifiedAt: T0 + 20 },
    ],
    [
      "an error entry stamped earlier (a clock set back)",
      { checkedAt: T0 - 10, error: true },
      { checkedAt: T0 - 10, error: true, notifiedAt: T0 + 20 },
    ],
    [
      "a newer entry for the same version",
      { checkedAt: T0 + 10, latest: "1.3.0" },
      { checkedAt: T0 + 10, latest: "1.3.0", notifiedAt: T0 + 20 },
    ],
  ])("records a claim on %s another run wrote meanwhile, without rolling it back", async (_label, newer, expected) => {
    // The claim's read-merge-write reads the file as it is when the write runs.
    await writeCacheText(JSON.stringify(newer));
    await recordDeliveryQuietly(stateDir, { checkedAt: T0, latest: "1.3.0" }, T0 + 20, () => T0 + 20);
    await expect(readCacheJson()).resolves.toEqual(expected);
  });

  it("gives no notice from a handle that settled before another run's delivery was recorded", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0" }));
    const fetch = registry({ latest: "1.3.0" });
    const first = check({ fetch, now: () => T0 + 1 });
    // `first` must settle (and claim) before `second` starts: the two reads finish in no fixed order otherwise.
    await untilCached((cached) => cached.notifiedAt === T0 + 1);
    // On its fixed clock, second.notice() resolves only once second's check has settled.
    const second = check({ fetch, now: () => T0 + 2, timeoutMs: SETTLE_ONLY_MS });

    await expect(first.notice()).resolves.toBe(NOTICE_1_3_0);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 1 });
    await expect(second.notice()).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives the notice to one of several handles asking in the same turn", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0" }));
    const fetch = registry({ latest: "1.3.0" });
    const handles = [0, 1, 2].map(() => check({ fetch, timeoutMs: SETTLE_ONLY_MS }));
    // One check has claimed; notice() waits for the others to settle (their timeouts cannot run down on this clock).
    await untilCached((cached) => cached.notifiedAt === T0);

    // Whichever handle's check settles first claims it; the reads finish in no fixed order.
    const notices = await Promise.all(handles.map((handle) => handle.notice()));
    expect(notices.filter((notice) => notice !== null)).toEqual([NOTICE_1_3_0]);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
    await expect(run({ fetch, now: () => T0 + 1 })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces a notifiedAt in the future with the delivery, so the next run gives no notice", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + DAY }));
    const fetch = registry({ latest: "1.3.0" });
    await expect(run({ fetch, now: () => T0 + 1 })).resolves.toBe(NOTICE_1_3_0);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 1 });
    await expect(run({ fetch, now: () => T0 + 2 })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not carry a notifiedAt in the future over to a refreshed entry", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0 - DAY, latest: "1.3.0", notifiedAt: T0 + DAY }));
    await expect(run({ fetch: registry({ latest: "1.3.0" }) })).resolves.toBe(NOTICE_1_3_0);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 });
  });

  it("never loses a delivery to a refresh written by the same process at the same time", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0 - DAY + 1, latest: "1.3.0" }));
    // The refresh reads the entry before the delivery lands, and fails only after the delivery is on disk.
    let fail: () => void = () => undefined;
    const fetch = vi.fn<UpdateCheckFetch>(
      () => new Promise((resolve) => (fail = () => resolve(new Response("down", { status: 500 }))))
    );
    const refreshing = check({ fetch, now: () => T0 + 1, intervalMs: DAY - 2, timeoutMs: SETTLE_ONLY_MS });
    await until(() => fetch.mock.calls.length === 1);
    const delivering = check({ now: () => T0 });
    await untilCached((cached) => cached.notifiedAt === T0);
    fail();

    await expect(delivering.notice()).resolves.toBe(NOTICE_1_3_0);
    // On its fixed clock, refreshing.notice() resolves only once the refresh has settled (its write is queued by then).
    await expect(refreshing.notice()).resolves.toBeNull();
    const cached = (await readCacheJson()) as Record<string, unknown>;
    expect(cached.notifiedAt).toBe(T0);
    expect(cached).toEqual({ checkedAt: T0 + 1, error: true, notifiedAt: T0 });
  });

  it.each<[string, Record<string, unknown>]>([
    ["the same version", { checkedAt: T0 + 1, latest: "1.3.0", notifiedAt: T0 + 1 }],
    ["another version", { checkedAt: T0 + 1, latest: "1.4.0", notifiedAt: T0 + 1 }],
    ["an error entry", { checkedAt: T0 + 1, error: true, notifiedAt: T0 + 1 }],
  ])("gives no notice once another run recorded a delivery on %s before this check settled", async (_label, other) => {
    await writeCacheText(JSON.stringify(other));
    const fetch = registry({ latest: "1.3.0" });
    // On its fixed clock, notice() resolves only once the check has settled: the null is its answer.
    const handle = check({ fetch, now: () => T0 + 2, timeoutMs: SETTLE_ONLY_MS });

    await expect(handle.notice()).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual(other);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands out a claim made when the check settled even when another run writes the file later", async () => {
    // The window from one run's claim read to its claim rename is the last-rename-wins boundary; after the claim, the
    // handle no longer reads the file.
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0" }));
    const handle = check({ now: () => T0 + 2 });
    await untilCached((cached) => cached.notifiedAt === T0 + 2);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 2 });

    await writeCacheText(JSON.stringify({ checkedAt: T0 + 1, latest: "1.3.0", notifiedAt: T0 + 1 }));
    await expect(handle.notice()).resolves.toBe(NOTICE_1_3_0);
  });

  it("keeps a claim across an error refresh and gives the notice again only after the interval", async () => {
    const hour = 60 * 60 * 1000;
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0" }));
    const delivering = check({ now: () => T0 + hour });
    await untilCached((cached) => cached.notifiedAt === T0 + hour);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + hour });

    // An overlapping run refreshes the stale entry and the registry fails; it lands between the claim and hand-out.
    await expect(
      run({ fetch: registry("down", 500), now: () => T0 + DAY + 1, intervalMs: DAY - 2 * hour })
    ).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + DAY + 1, error: true, notifiedAt: T0 + hour });
    await expect(delivering.notice()).resolves.toBe(NOTICE_1_3_0);

    // The cached error holds requests back for its interval; after it, the claim has expired and the notice is due.
    const fetch = registry({ latest: "1.3.0" });
    await expect(run({ fetch, now: () => T0 + DAY + hour })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await expect(run({ fetch, now: () => T0 + 2 * DAY + 2 })).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({
      checkedAt: T0 + 2 * DAY + 2,
      latest: "1.3.0",
      notifiedAt: T0 + 2 * DAY + 2,
    });
  });

  it("carries a delivery over to an error entry when a refresh fails", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0", notifiedAt: T0 + 5 }));
    await expect(run({ fetch: registry("down", 500), now: () => T0 + DAY })).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + DAY, error: true, notifiedAt: T0 + 5 });
    // A cached error with a delivery is still a valid entry: no request within the interval.
    const fetch = registry({ latest: "1.3.0" });
    await expect(run({ fetch, now: () => T0 + DAY + 1 })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a delivery another run recorded while this run's request was in flight", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0 - DAY, latest: "1.3.0" }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<UpdateCheckFetch>(async () => {
      await gate;
      return new Response(JSON.stringify({ latest: "1.3.0" }), { status: 200 });
    });
    const refreshing = check({ fetch, now: () => T0 + 2, timeoutMs: 60_000 });
    await until(() => fetch.mock.calls.length === 1);

    await writeCacheText(JSON.stringify({ checkedAt: T0 - DAY, latest: "1.3.0", notifiedAt: T0 + 1 }));
    release();
    await expect(refreshing.notice()).resolves.toBeNull();
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + 2, latest: "1.3.0", notifiedAt: T0 + 1 });
  });

  it.each([
    ["a notifiedAt that is not a number", "yesterday"],
    ["a notifiedAt in the future", T0 + DAY],
  ])("treats %s as no notice delivered", async (_label, notifiedAt) => {
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0", notifiedAt }));
    const fetch = registry({ latest: "1.3.0" });
    await expect(run({ fetch, now: () => T0 + 1 })).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a cached error within the interval without a request", async () => {
    await run({ fetch: registry({}, 500) });
    const fetch = registry({ latest: "1.3.0" });
    await expect(check({ fetch, now: () => T0 + DAY - 1 }).notice()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("compares a cached latest with the version now running", async () => {
    await writeCacheText(JSON.stringify({ checkedAt: T0, latest: "1.3.0" }));
    const fetch = registry({ latest: "1.3.0" });
    await expect(run({ fetch, currentVersion: "1.3.0", now: () => T0 + 1 })).resolves.toBeNull();
    await expect(run({ fetch, currentVersion: "1.2.5", now: () => T0 + 2 })).resolves.toBe(
      "Update available: 1.2.5 → 1.3.0 (npm i -g my-cli)"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honours intervalMs", async () => {
    await run({ intervalMs: 1_000 });
    const fetch = registry({ latest: "1.3.0" });
    await run({ fetch, intervalMs: 1_000, now: () => T0 + 999 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(run({ fetch, intervalMs: 1_000, now: () => T0 + 1_000 })).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a checkedAt in the future as stale", async () => {
    await run({ now: () => T0 + DAY });
    const fetch = registry({ latest: "1.3.0" });
    await expect(run({ fetch, now: () => T0 })).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["{", "{"],
    ["an empty file", ""],
    ["an array", "[]"],
    ["a string checkedAt", JSON.stringify({ checkedAt: String(T0), latest: "1.3.0" })],
    ["no result", JSON.stringify({ checkedAt: T0 })],
    ["a latest outside the grammar", JSON.stringify({ checkedAt: T0, latest: "v9" })],
    ["error not true", JSON.stringify({ checkedAt: T0, error: "yes" })],
  ])("treats a cache file holding %s as never checked", async (_label, text) => {
    await writeCacheText(text);
    const fetch = registry({ latest: "1.3.0" });
    await expect(check({ fetch, now: () => T0 + 1 }).notice()).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + 1, latest: "1.3.0", notifiedAt: T0 + 1 });
  });

  it("treats an unreadable cache (a directory) as never checked and still gives the notice", async () => {
    await mkdir(cacheFile, { recursive: true });
    const fetch = registry({ latest: "1.3.0" });
    await expect(check({ fetch }).notice()).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still gives the notice when the state directory cannot be created", async () => {
    await mkdir(path.dirname(stateDir), { recursive: true });
    await writeFile(stateDir, "not a directory");
    await expect(check().notice()).resolves.toBe(NOTICE_1_3_0);
  });

  it("resolves only the state directory, so an unusable home directory does not stop the check", async () => {
    // XDG_STATE_HOME / LOCALAPPDATA place the state directory; the config and cache directories would need a home.
    vi.stubEnv("HOME", "relative-home");
    vi.stubEnv("USERPROFILE", "relative-home");
    await expect(check().notice()).resolves.toBe(NOTICE_1_3_0);
    await expect(readCacheJson()).resolves.toMatchObject({ latest: "1.3.0" });
  });
});

describe("startUpdateCheck: atomic cache writes", () => {
  it("leaves one valid JSON file when several checks write at once", async () => {
    const versions = ["1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0"];
    const notices = await Promise.all(
      versions.map((latest) => check({ fetch: registry({ latest }) }).notice())
    );

    // Within one process only one handle gives the notice, whichever settles first; the cache keeps the last rename.
    const given = notices.filter((notice) => notice !== null);
    expect(given).toHaveLength(1);
    expect(versions.map((latest) => `Update available: 1.2.0 → ${latest} (npm i -g my-cli)`)).toContain(given[0]);
    const cached = (await readCacheJson()) as { checkedAt: number; latest: string; notifiedAt: number };
    expect(await readdir(stateDir)).toEqual(["update-check.json"]);
    expect(cached.checkedAt).toBe(T0);
    expect(versions).toContain(cached.latest);
    // Once a delivery is written, no later run within the interval gives the notice.
    expect(cached.notifiedAt).toBe(T0);
    await expect(run({ fetch: registry({ latest: "1.9.0" }), now: () => T0 + 1 })).resolves.toBeNull();
  });

  it("removes temporary files older than one hour on the next write and keeps the rest", async () => {
    await mkdir(stateDir, { recursive: true });
    const old = path.join(stateDir, "update-check.json.123-interrupted.tmp");
    const fresh = path.join(stateDir, "update-check.json.456-in-progress.tmp");
    const unrelated = path.join(stateDir, "other.json.789.tmp");
    await Promise.all([writeFile(old, "{"), writeFile(fresh, "{"), writeFile(unrelated, "{")]);
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await utimes(unrelated, twoHoursAgo, twoHoursAgo);

    await expect(run()).resolves.toBe(NOTICE_1_3_0);

    expect((await readdir(stateDir)).sort()).toEqual(
      ["other.json.789.tmp", "update-check.json", "update-check.json.456-in-progress.tmp"].sort()
    );
  });

  it.skipIf(process.platform === "win32")("creates the cache file with mode 0600", async () => {
    await run();
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
  });
});

describe("startUpdateCheck: never throws", () => {
  it.each<[string, (fetch: UpdateCheckFetch) => UpdateCheckOptions]>([
    [
      "an options getter that throws",
      (fetch) =>
        Object.defineProperty({ currentVersion: "1.2.0", appName: APP, env, terminal, fetch }, "name", {
          get() {
            throw new Error("getter");
          },
          enumerable: true,
        }) as UpdateCheckOptions,
    ],
    ["an invalid app name", (fetch) => ({ name: "my-cli", currentVersion: "1.2.0", appName: "My App", env, terminal, fetch })],
    ["an empty package name", (fetch) => ({ name: "", currentVersion: "1.2.0", appName: APP, env, terminal, fetch })],
    [
      "a registryUrl that is not a URL",
      (fetch) => ({ name: "my-cli", currentVersion: "1.2.0", appName: APP, env, terminal, fetch, registryUrl: "registry" }),
    ],
    [
      "a clock that throws",
      (fetch) => ({
        name: "my-cli",
        currentVersion: "1.2.0",
        appName: APP,
        env,
        terminal,
        fetch,
        now: () => {
          throw new Error("clock");
        },
      }),
    ],
  ])("resolves null for %s", async (_label, makeOptions) => {
    const fetch = registry({ latest: "9.0.0" });
    let handle: ReturnType<typeof startUpdateCheck> | undefined;
    expect(() => {
      handle = startUpdateCheck(makeOptions(fetch));
    }).not.toThrow();
    await expect(handle!.notice()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
