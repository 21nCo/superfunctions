import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAppDir,
  InvalidAppNameError,
  InvalidHomeDirectoryError,
  resolveAppPaths,
  type AppPathsOptions,
} from "../src/paths.js";
import { appDirResolver } from "../src/app-dirs.js";
import * as core from "../src/index.js";

const POSIX_HOME = "/home/ada";
const WIN_HOME = "C:\\Users\\ada";

type Row = readonly [label: string, options: AppPathsOptions, expected: { config: string; state: string; cache: string }];

const posixDefaults = {
  config: "/home/ada/.config/my-cli",
  state: "/home/ada/.local/state/my-cli",
  cache: "/home/ada/.cache/my-cli",
};

function posixRows(platform: "linux" | "darwin"): Row[] {
  const base = { platform, homedir: POSIX_HOME } as const;
  return [
    [`${platform}: no XDG variables`, { ...base, env: {} }, posixDefaults],
    [
      `${platform}: every XDG variable set`,
      { ...base, env: { XDG_CONFIG_HOME: "/x/config", XDG_STATE_HOME: "/x/state", XDG_CACHE_HOME: "/x/cache" } },
      { config: "/x/config/my-cli", state: "/x/state/my-cli", cache: "/x/cache/my-cli" },
    ],
    [`${platform}: only XDG_CONFIG_HOME`, { ...base, env: { XDG_CONFIG_HOME: "/x/config" } }, { ...posixDefaults, config: "/x/config/my-cli" }],
    [`${platform}: only XDG_STATE_HOME`, { ...base, env: { XDG_STATE_HOME: "/x/state" } }, { ...posixDefaults, state: "/x/state/my-cli" }],
    [`${platform}: only XDG_CACHE_HOME`, { ...base, env: { XDG_CACHE_HOME: "/x/cache" } }, { ...posixDefaults, cache: "/x/cache/my-cli" }],
    [
      `${platform}: relative XDG values fall back`,
      { ...base, env: { XDG_CONFIG_HOME: "rel/config", XDG_STATE_HOME: "./state", XDG_CACHE_HOME: "~/cache" } },
      posixDefaults,
    ],
    [
      `${platform}: empty XDG values fall back`,
      { ...base, env: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", XDG_CACHE_HOME: "" } },
      posixDefaults,
    ],
    [
      `${platform}: Windows variables are ignored`,
      { ...base, env: { APPDATA: "/x/appdata", LOCALAPPDATA: "/x/local" } },
      posixDefaults,
    ],
  ];
}

const winDefaults = {
  config: "C:\\Users\\ada\\AppData\\Roaming\\my-cli",
  state: "C:\\Users\\ada\\AppData\\Local\\my-cli\\State",
  cache: "C:\\Users\\ada\\AppData\\Local\\my-cli\\Cache",
};

const winRows: Row[] = [
  [
    "win32: APPDATA and LOCALAPPDATA set",
    { platform: "win32", homedir: WIN_HOME, env: { APPDATA: "D:\\Roam", LOCALAPPDATA: "D:\\Loc" } },
    { config: "D:\\Roam\\my-cli", state: "D:\\Loc\\my-cli\\State", cache: "D:\\Loc\\my-cli\\Cache" },
  ],
  ["win32: both missing", { platform: "win32", homedir: WIN_HOME, env: {} }, winDefaults],
  [
    "win32: APPDATA missing",
    { platform: "win32", homedir: WIN_HOME, env: { LOCALAPPDATA: "D:\\Loc" } },
    { config: winDefaults.config, state: "D:\\Loc\\my-cli\\State", cache: "D:\\Loc\\my-cli\\Cache" },
  ],
  [
    "win32: LOCALAPPDATA missing",
    { platform: "win32", homedir: WIN_HOME, env: { APPDATA: "D:\\Roam" } },
    { ...winDefaults, config: "D:\\Roam\\my-cli" },
  ],
  [
    "win32: relative and driveless values fall back",
    { platform: "win32", homedir: WIN_HOME, env: { APPDATA: "Roaming", LOCALAPPDATA: "\\Local" } },
    winDefaults,
  ],
  ["win32: empty values fall back", { platform: "win32", homedir: WIN_HOME, env: { APPDATA: "", LOCALAPPDATA: "" } }, winDefaults],
  [
    "win32: UNC values are absolute",
    { platform: "win32", homedir: WIN_HOME, env: { APPDATA: "\\\\srv\\share\\roam" } },
    { ...winDefaults, config: "\\\\srv\\share\\roam\\my-cli" },
  ],
  [
    "win32: a UNC value without a share falls back",
    { platform: "win32", homedir: WIN_HOME, env: { APPDATA: "\\\\srv", LOCALAPPDATA: "\\\\srv\\" } },
    winDefaults,
  ],
  [
    "win32: XDG variables are ignored",
    { platform: "win32", homedir: WIN_HOME, env: { XDG_CONFIG_HOME: "C:\\xdg", XDG_STATE_HOME: "C:\\xdg", XDG_CACHE_HOME: "C:\\xdg" } },
    winDefaults,
  ],
];

describe("resolveAppPaths", () => {
  it.each([...posixRows("linux"), ...posixRows("darwin"), ...winRows])("%s", (_label, options, expected) => {
    expect(resolveAppPaths("my-cli", options)).toEqual(expected);
  });

  it("defaults to the current process platform, environment and home directory", () => {
    const expected = resolveAppPaths("my-cli", { platform: process.platform, env: process.env });
    expect(resolveAppPaths("my-cli")).toEqual(expected);
  });

  it("reads the environment on every call, so a changed variable takes effect on the next run", () => {
    const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: "/first" };
    expect(resolveAppPaths("my-cli", { platform: "linux", homedir: POSIX_HOME, env }).config).toBe("/first/my-cli");
    env.XDG_CONFIG_HOME = "/second";
    expect(resolveAppPaths("my-cli", { platform: "linux", homedir: POSIX_HOME, env }).config).toBe("/second/my-cli");
  });

  it.each([
    ["linux", "relative/home"],
    ["linux", ""],
    ["win32", "Users\\ada"],
    ["win32", "\\Users\\ada"],
  ] as const)("rejects a non-absolute home directory on %s (%j)", (platform, homedir) => {
    expect(() => resolveAppPaths("my-cli", { platform, homedir, env: {} })).toThrow(InvalidHomeDirectoryError);
  });

  it.each([
    ["linux", { XDG_CONFIG_HOME: "/xdg/config", XDG_STATE_HOME: "/xdg/state", XDG_CACHE_HOME: "/xdg/cache" }],
    ["win32", { APPDATA: "D:\\Roam", LOCALAPPDATA: "D:\\Loc" }],
  ] as const)("does not need the home directory on %s when every variable is absolute", (platform, env) => {
    expect(() => resolveAppPaths("my-cli", { platform, homedir: "relative-home", env })).not.toThrow();
  });

  it.each([
    ["an extended-length UNC prefix whose share would be the app name", "\\\\?\\UNC\\srv"],
    ["an extended-length drive path", "\\\\?\\D:\\Roam"],
    ["a device namespace path", "\\\\.\\pipe"],
    ["a device drive path", "\\\\.\\D:\\Roam"],
    ["a dot-dot server", "\\\\..\\share"],
    ["a dot server", "\\\\.\\share"],
    ["a dot-dot share", "\\\\srv\\.."],
    ["an empty server", "\\\\\\share"],
    ["forward slashes without a share", "//srv"],
    ["a drive-relative path", "D:Roam"],
  ])("win32: an environment value that is %s falls back", (_label, value) => {
    expect(resolveAppPaths("my-cli", { platform: "win32", homedir: WIN_HOME, env: { APPDATA: value, LOCALAPPDATA: value } })).toEqual(
      winDefaults,
    );
  });

  it.each([
    ["\\\\srv\\share", "\\\\srv\\share\\my-cli"],
    ["//srv/share/roam", "\\\\srv\\share\\roam\\my-cli"],
    ["D:/Roam", "D:\\Roam\\my-cli"],
  ])("win32: %j is a usable APPDATA root", (value, config) => {
    expect(resolveAppPaths("my-cli", { platform: "win32", homedir: WIN_HOME, env: { APPDATA: value } }).config).toBe(config);
  });

  it.each([
    "\\\\?\\C:\\Users\\ada",
    "\\\\?\\UNC\\srv\\share",
    "\\\\.\\pipe\\ada",
    "\\\\..\\share\\ada",
    "\\\\srv",
    "C:Users\\ada",
  ])("win32: rejects the home directory %j by the same rule", (homedir) => {
    expect(() => resolveAppPaths("my-cli", { platform: "win32", homedir, env: {} })).toThrow(InvalidHomeDirectoryError);
  });

  it("win32: accepts a UNC home directory with a server and share", () => {
    expect(resolveAppPaths("my-cli", { platform: "win32", homedir: "\\\\srv\\share\\ada", env: {} }).config).toBe(
      "\\\\srv\\share\\ada\\AppData\\Roaming\\my-cli",
    );
  });

  it.each([
    ["linux", { XDG_CONFIG_HOME: "/xdg/config" }, "/xdg/config/my-cli"],
    ["win32", { APPDATA: "D:\\Roam" }, "D:\\Roam\\my-cli"],
  ] as const)("resolving only the config directory on %s does not need the home directory", (platform, env, config) => {
    expect(appDirResolver("my-cli", { platform, homedir: "relative-home", env })("config")).toBe(config);
    expect(() => resolveAppPaths("my-cli", { platform, homedir: "relative-home", env })).toThrow(InvalidHomeDirectoryError);
  });

  it("still rejects a non-absolute home directory when one default needs it", () => {
    const env = { XDG_CONFIG_HOME: "/xdg/config", XDG_STATE_HOME: "/xdg/state" };
    expect(() => resolveAppPaths("my-cli", { platform: "linux", homedir: "relative-home", env })).toThrow(InvalidHomeDirectoryError);
  });
});

describe("app name grammar", () => {
  const options: AppPathsOptions = { platform: "linux", homedir: POSIX_HOME, env: {} };

  it.each([
    ["starts with a lowercase letter or digit", "a"],
    ["digit first", "9lives"],
    ["dots, underscores and hyphens after the first character", "my.cli_tool-2"],
    ["64 characters", "a".repeat(64)],
  ])("accepts: %s", (_rule, name) => {
    expect(resolveAppPaths(name, options).config).toBe(`/home/ada/.config/${name}`);
  });

  it.each([
    ["empty", ""],
    ["uppercase", "My-cli"],
    ["dot-dot", ".."],
    ["leading dot", ".cli"],
    ["leading hyphen", "-cli"],
    ["slash", "my/cli"],
    ["backslash", "my\\cli"],
    ["65 characters", "a".repeat(65)],
    ["whitespace", "my cli"],
    ["trailing newline", "my-cli\n"],
  ])("rejects: %s", (_rule, name) => {
    let caught: unknown;
    try {
      resolveAppPaths(name, options);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidAppNameError);
    expect(caught).toMatchObject({ code: "CLIFN_INVALID_APP_NAME", appName: name });
  });

  it.each([undefined, null, 42, {}])("rejects a non-string app name (%j)", (name) => {
    expect(() => resolveAppPaths(name as unknown as string, options)).toThrow(InvalidAppNameError);
  });
});

describe("ensureAppDir", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "clifn-paths-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates a missing directory and its parents and returns it", async () => {
    const dir = join(tempRoot, "config", "my-cli");
    await expect(ensureAppDir(dir)).resolves.toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o077).toBe(0);
    }
  });

  it("leaves an existing directory as it is", async () => {
    const dir = join(tempRoot, "existing");
    await ensureAppDir(dir);
    await expect(ensureAppDir(dir)).resolves.toBe(dir);
  });

  it("resolves for two concurrent calls on the same path", async () => {
    const dir = join(tempRoot, "a", "b", "my-cli");
    await expect(Promise.all([ensureAppDir(dir), ensureAppDir(dir)])).resolves.toEqual([dir, dir]);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("rejects when a file occupies the path", async () => {
    const file = join(tempRoot, "occupied");
    writeFileSync(file, "x");
    await expect(ensureAppDir(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("root exports", () => {
  it("exposes the paths API from @clifn/core", () => {
    expect(core.resolveAppPaths).toBe(resolveAppPaths);
    expect(core.ensureAppDir).toBe(ensureAppDir);
    expect(core.InvalidAppNameError).toBe(InvalidAppNameError);
  });
});
