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
});

afterEach(async () => {
  vi.useRealTimers();
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

async function readCacheJson(): Promise<unknown> {
  return JSON.parse(await readFile(cacheFile, "utf8"));
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false
  );
}

/** Lets real I/O progress while fake timers hold `setTimeout`. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
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
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0, latest: "1.3.0" });
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

  it("waits for a slow registry only within the timeout and then returns the same notice each time", async () => {
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn<UpdateCheckFetch>(() => new Promise((resolve) => (respond = resolve)));
    const handle = check({ fetch, now: () => Date.now(), timeoutMs: 5_000 });
    const first = handle.notice();
    await until(() => fetch.mock.calls.length === 1);
    respond?.(new Response(JSON.stringify({ latest: "1.3.0" })));

    await expect(first).resolves.toBe(NOTICE_1_3_0);
    await expect(handle.notice()).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
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
  it("uses the cached result within the interval and requests again after it", async () => {
    await expect(check().notice()).resolves.toBe(NOTICE_1_3_0);

    const fetch = registry({ latest: "1.4.0" });
    await expect(check({ fetch, now: () => T0 + DAY - 1 }).notice()).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).not.toHaveBeenCalled();

    await expect(check({ fetch, now: () => T0 + DAY }).notice()).resolves.toBe(
      "Update available: 1.2.0 → 1.4.0 (npm i -g my-cli)"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + DAY, latest: "1.4.0" });
  });

  it("uses a cached error within the interval without a request", async () => {
    await check({ fetch: registry({}, 500) }).notice();
    const fetch = registry({ latest: "1.3.0" });
    await expect(check({ fetch, now: () => T0 + DAY - 1 }).notice()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("compares a cached latest with the version now running", async () => {
    await check().notice();
    const fetch = registry({ latest: "1.3.0" });
    await expect(check({ fetch, currentVersion: "1.3.0", now: () => T0 + 1 }).notice()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honours intervalMs", async () => {
    await check({ intervalMs: 1_000 }).notice();
    const fetch = registry({ latest: "1.3.0" });
    await check({ fetch, intervalMs: 1_000, now: () => T0 + 999 }).notice();
    expect(fetch).not.toHaveBeenCalled();
    await check({ fetch, intervalMs: 1_000, now: () => T0 + 1_000 }).notice();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a checkedAt in the future as stale", async () => {
    await check({ now: () => T0 + DAY }).notice();
    const fetch = registry({ latest: "1.3.0" });
    await check({ fetch, now: () => T0 }).notice();
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
    await mkdir(stateDir, { recursive: true });
    await writeFile(cacheFile, text);
    const fetch = registry({ latest: "1.3.0" });
    await expect(check({ fetch, now: () => T0 + 1 }).notice()).resolves.toBe(NOTICE_1_3_0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readCacheJson()).resolves.toEqual({ checkedAt: T0 + 1, latest: "1.3.0" });
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
});

describe("startUpdateCheck: atomic cache writes", () => {
  it("leaves one valid JSON file when several checks write at once", async () => {
    const versions = ["1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0"];
    const notices = await Promise.all(
      versions.map((latest) => check({ fetch: registry({ latest }) }).notice())
    );

    expect(notices).toEqual(versions.map((latest) => `Update available: 1.2.0 → ${latest} (npm i -g my-cli)`));
    expect(await readdir(stateDir)).toEqual(["update-check.json"]);
    const cached = (await readCacheJson()) as { checkedAt: number; latest: string };
    expect(cached.checkedAt).toBe(T0);
    expect(versions).toContain(cached.latest);
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

    await expect(check().notice()).resolves.toBe(NOTICE_1_3_0);

    expect((await readdir(stateDir)).sort()).toEqual(
      ["other.json.789.tmp", "update-check.json", "update-check.json.456-in-progress.tmp"].sort()
    );
  });

  it.skipIf(process.platform === "win32")("creates the cache file with mode 0600", async () => {
    await check().notice();
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
