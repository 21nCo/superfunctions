import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createCredentialStore, InvalidStoreOptionsError } from "../src/credentials.js";
import { createProjectConfig } from "../src/config.js";
import { InvalidAppNameError } from "../src/paths.js";
import { joinStoreFile } from "../src/store-options.js";

// The defaults as they are defined at the reference commit (D2): these must never move.
const CONDUCT_CREDENTIALS_PATH = join(homedir(), ".conduct", "credentials");
const CONDUCT_CONFIG_PATH = join(process.cwd(), "conduct.config.json");

const PROFILE = { backend: "https://api.example.test", key: "test-api-key" };
const POSIX = process.platform !== "win32";
const FOREIGN_PLATFORM: NodeJS.Platform = POSIX ? "win32" : "linux";
const HOME = POSIX ? "/home/ada" : "C:\\Users\\ada";

/** An options object whose `own` keys are own enumerable properties and whose `inherited` keys come from its prototype. */
function withPrototype(inherited: object, own: object): object {
  return Object.assign(Object.create(inherited) as object, own);
}

/** Adds an own non-enumerable property, which Object.keys and object spread do not see. */
function withHidden(target: object, key: string, value: unknown): object {
  return Object.defineProperty(target, key, { value, enumerable: false });
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "clifn-app-stores-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("createCredentialStore", () => {
  it("keeps the Conduct default without an argument", () => {
    expect(createCredentialStore().path).toBe(CONDUCT_CREDENTIALS_PATH);
    expect(createCredentialStore(undefined).path).toBe(CONDUCT_CREDENTIALS_PATH);
  });

  it("uses a path string as given, and { path } the same way", () => {
    const filePath = join(tempRoot, "creds.ini");
    expect(createCredentialStore(filePath).path).toBe(filePath);
    expect(createCredentialStore({ path: filePath }).path).toBe(filePath);
    expect(createCredentialStore({ path: "relative/creds" }).path).toBe(createCredentialStore("relative/creds").path);
  });

  it.runIf(POSIX)("{ appName } writes <XDG_CONFIG_HOME>/<app>/credentials with a 0700 directory and 0600 file", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempRoot);
    const store = createCredentialStore({ appName: "my-cli" });
    const expected = join(tempRoot, "my-cli", "credentials");

    expect(store.path).toBe(expected);
    store.setProfile("default", PROFILE);

    expect(readFileSync(expected, "utf8")).toContain("[default]");
    expect(createCredentialStore({ appName: "my-cli" }).getProfile("default")).toEqual(PROFILE);
    expect(statSync(join(tempRoot, "my-cli")).mode & 0o777).toBe(0o700);
    expect(statSync(expected).mode & 0o777).toBe(0o600);
    expect(store.path).not.toContain(".conduct");
  });

  it.runIf(POSIX)("{ appName } passes env and homedir through to resolveAppPaths", () => {
    expect(createCredentialStore({ appName: "my-cli", homedir: "/home/ada", env: {} }).path).toBe(
      "/home/ada/.config/my-cli/credentials",
    );
    expect(createCredentialStore({ appName: "my-cli", homedir: "/home/ada", env: { XDG_CONFIG_HOME: "/xdg" } }).path).toBe(
      "/xdg/my-cli/credentials",
    );
  });

  it("accepts the current platform passed explicitly", () => {
    const options = { appName: "my-cli", homedir: HOME, env: {} };
    expect(createCredentialStore({ ...options, platform: process.platform } as never).path).toBe(
      createCredentialStore(options).path,
    );
  });

  it("rejects a foreign platform before any filesystem call", () => {
    const cwdMode = statSync(process.cwd()).mode;
    const options = { appName: "my-cli", platform: FOREIGN_PLATFORM, homedir: "C:\\Users\\ada", env: { APPDATA: "D:\\Roam" } };
    expect(() => createCredentialStore(options as never)).toThrow(InvalidStoreOptionsError);
    expect(() => createProjectConfig(options as never)).toThrow(InvalidStoreOptionsError);
    expect(statSync(process.cwd()).mode).toBe(cwdMode);
  });

  it("rejects an invalid app name", () => {
    expect(() => createCredentialStore({ appName: "../conduct" })).toThrow(InvalidAppNameError);
    expect(() => createCredentialStore({ appName: "" })).toThrow(InvalidAppNameError);
  });

  it.each([
    ["both appName and path", { appName: "my-cli", path: "/tmp/x" }],
    ["neither appName nor path", {}],
    ["appName set to undefined", { appName: undefined }],
    ["appName set to undefined beside a path", { appName: undefined, path: "/tmp/x" }],
    ["path set to undefined", { path: undefined }],
    ["a non-string appName", { appName: 42 }],
    ["a non-string path", { path: 42 }],
    ["homedir with path", { path: "/tmp/x", homedir: "/home/ada" }],
    ["homedir and platform with path", { path: "/tmp/x", homedir: "C:\\Users\\ada", platform: "win32" }],
    ["env with path", { path: "/tmp/x", env: {} }],
    ["fileName with appName", { appName: "my-cli", fileName: "other" }],
    ["cwd with appName", { appName: "my-cli", cwd: "/tmp" }],
    ["an unknown key", { appName: "my-cli", homeDir: "/home/ada" }],
    ["a non-string homedir", { appName: "my-cli", homedir: 42 }],
    ["a non-object env", { appName: "my-cli", env: "XDG_CONFIG_HOME=/xdg" }],
    ["only inherited selectors", Object.create({ appName: "my-cli", path: "/tmp/x" }) as object],
  ])("rejects options with %s instead of falling back to the Conduct default", (_label, options) => {
    expect(() => createCredentialStore(options as never)).toThrow(InvalidStoreOptionsError);
  });

  it("ignores an inherited selector beside an own one", () => {
    const options = Object.assign(Object.create({ path: "/tmp/inherited" }) as object, { path: "/tmp/own" });
    expect(createCredentialStore(options as never).path).toBe("/tmp/own");
  });

  it.each([
    ["appName set to undefined beside a path", () => withHidden({ path: "/expected" }, "appName", undefined)],
    ["appName beside a path", () => withHidden({ path: "/expected" }, "appName", "my-cli")],
    ["cwd beside appName", () => withHidden({ appName: "my-cli" }, "cwd", "/tmp")],
    ["an unknown key", () => withHidden({ appName: "my-cli" }, "homeDir", "/home/ada")],
  ])("rejects a non-enumerable own %s", (_label, build) => {
    expect(() => createCredentialStore(build() as never)).toThrow(InvalidStoreOptionsError);
  });

  it("selects the appName form from a non-enumerable own appName", () => {
    const options = withHidden({ env: { XDG_CONFIG_HOME: tempRoot } }, "appName", "my-cli");
    expect(createCredentialStore(options as never).path).toBe(join(tempRoot, "my-cli", "credentials"));
  });

  it.runIf(POSIX)("ignores inherited env, homedir and platform, so each takes its default", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempRoot);
    const inheritedEnv = withPrototype({ env: { XDG_CONFIG_HOME: "/unexpected" } }, { appName: "my-cli" });
    expect(createCredentialStore(inheritedEnv as never).path).toBe(join(tempRoot, "my-cli", "credentials"));

    const inheritedHome = withPrototype({ homedir: "/proto" }, { appName: "my-cli", env: {} });
    expect(createCredentialStore(inheritedHome as never).path).toBe(join(homedir(), ".config", "my-cli", "credentials"));

    const inheritedPlatform = withPrototype({ platform: FOREIGN_PLATFORM }, { appName: "my-cli" });
    expect(createCredentialStore(inheritedPlatform as never).path).toBe(join(tempRoot, "my-cli", "credentials"));
  });

  it.runIf(POSIX)("treats env and homedir set to undefined as absent in the appName form", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempRoot);
    expect(createCredentialStore({ appName: "my-cli", env: undefined, homedir: undefined }).path).toBe(
      join(tempRoot, "my-cli", "credentials"),
    );
  });

  it.runIf(POSIX)("resolves only the config directory, so a home directory it does not need is never validated", () => {
    const options = { appName: "my-cli", homedir: "relative-home", env: { XDG_CONFIG_HOME: "/xdg" } };
    expect(createCredentialStore(options).path).toBe("/xdg/my-cli/credentials");
    expect(createProjectConfig(options).path).toBe("/xdg/my-cli/config.json");
  });
});

describe("createProjectConfig", () => {
  it("keeps the Conduct default without an argument", () => {
    expect(createProjectConfig().path).toBe(CONDUCT_CONFIG_PATH);
    expect(createProjectConfig(undefined).path).toBe(CONDUCT_CONFIG_PATH);
  });

  it("uses a path string as given, and { path } the same way", () => {
    const filePath = join(tempRoot, "conf.json");
    expect(createProjectConfig(filePath).path).toBe(filePath);
    expect(createProjectConfig({ path: filePath }).path).toBe(filePath);
  });

  it.runIf(POSIX)("{ appName } writes <XDG_CONFIG_HOME>/<app>/config.json", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempRoot);
    const store = createProjectConfig({ appName: "my-cli" });
    const expected = join(tempRoot, "my-cli", "config.json");

    expect(store.path).toBe(expected);
    store.set("region", "eu");

    expect(JSON.parse(readFileSync(expected, "utf8"))).toEqual({ region: "eu" });
    if (POSIX) {
      expect(statSync(join(tempRoot, "my-cli")).mode & 0o777).toBe(0o700);
    }
  });

  it.runIf(POSIX)("{ appName, fileName } uses the file name under the config directory", () => {
    const options = { appName: "my-cli", homedir: "/home/ada", env: {} } as const;
    expect(createProjectConfig({ ...options, fileName: "settings.json" }).path).toBe("/home/ada/.config/my-cli/settings.json");
    expect(createProjectConfig({ ...options, fileName: "profiles/dev.json" }).path).toBe(
      "/home/ada/.config/my-cli/profiles/dev.json",
    );
  });

  it("{ cwd, fileName } resolves a project-local file", () => {
    const store = createProjectConfig({ cwd: tempRoot, fileName: ".my-cli/config.json" });
    expect(store.path).toBe(join(tempRoot, ".my-cli", "config.json"));
    store.write({ ok: true });
    expect(createProjectConfig({ cwd: tempRoot, fileName: ".my-cli/config.json" }).read()).toEqual({ ok: true });
  });

  it("{ fileName } without cwd resolves against the working directory at call time", () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    try {
      expect(createProjectConfig({ fileName: "my-cli.json" }).path).toBe(join(tempRoot, "my-cli.json"));
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["parent escape", "../outside.json"],
    ["nested parent escape", "a/../../outside.json"],
    ["absolute path", "/etc/outside.json"],
    ["drive-qualified path", "C:outside.json"],
    ["the directory itself", "."],
    ["a directory", "dir/"],
    ["empty", ""],
  ])("rejects a fileName that is a %s", (_label, fileName) => {
    expect(() => createProjectConfig({ appName: "my-cli", fileName })).toThrow(InvalidStoreOptionsError);
    expect(() => createProjectConfig({ cwd: tempRoot, fileName })).toThrow(InvalidStoreOptionsError);
  });

  it("joins and contains Windows file names with Windows separators", () => {
    const base = "C:\\Users\\ada\\AppData\\Roaming\\my-cli";
    expect(joinStoreFile(base, "a/b.json", win32)).toBe(`${base}\\a\\b.json`);
    expect(() => joinStoreFile(base, "..\\outside.json", win32)).toThrow(InvalidStoreOptionsError);
    expect(() => joinStoreFile(base, "D:\\outside.json", win32)).toThrow(InvalidStoreOptionsError);
  });

  it.each([
    ["both appName and path", { appName: "my-cli", path: "/tmp/x" }],
    ["cwd with appName", { appName: "my-cli", cwd: "/tmp" }],
    ["cwd with path", { path: "/tmp/x", cwd: "/tmp" }],
    ["fileName with path", { path: "/tmp/x", fileName: "a.json" }],
    ["cwd without fileName", { cwd: "/tmp" }],
    ["an empty object", {}],
    ["an empty cwd", { cwd: "", fileName: "a.json" }],
    ["a non-string path", { path: 42 }],
    ["appName set to undefined beside the Conduct file name", { appName: undefined, fileName: "conduct.config.json" }],
    ["path set to undefined beside a fileName", { path: undefined, fileName: "a.json" }],
    ["fileName set to undefined", { fileName: undefined }],
    ["fileName set to undefined beside cwd", { cwd: "/x", fileName: undefined }],
    ["an empty appName form fileName", { appName: "my-cli", fileName: "" }],
    ["a non-string cwd", { cwd: 42, fileName: "a.json" }],
    ["a non-string appName", { appName: 42 }],
    ["a non-string fileName", { fileName: 42 }],
    ["env with a project-local file", { fileName: "a.json", env: {} }],
    ["homedir with a project-local file", { fileName: "a.json", homedir: "/home/ada" }],
    ["platform with path", { path: "/tmp/x", platform: process.platform }],
    ["an unknown key", { appName: "my-cli", filename: "a.json" }],
    ["only inherited selectors", Object.create({ appName: "my-cli", fileName: "a.json" }) as object],
  ])("rejects options with %s", (_label, options) => {
    expect(() => createProjectConfig(options as never)).toThrow(InvalidStoreOptionsError);
  });

  it("rejects an invalid app name", () => {
    expect(() => createProjectConfig({ appName: "My-CLI" })).toThrow(InvalidAppNameError);
  });

  it("treats an optional fileName or cwd set to undefined as absent", () => {
    const options = { appName: "my-cli", env: { XDG_CONFIG_HOME: tempRoot } };
    expect(createProjectConfig({ ...options, fileName: undefined }).path).toBe(join(tempRoot, "my-cli", "config.json"));

    const spy = vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    try {
      expect(createProjectConfig({ cwd: undefined, fileName: "a.json" }).path).toBe(join(tempRoot, "a.json"));
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["appName set to undefined beside the Conduct file name", () => withHidden({ fileName: "conduct.config.json" }, "appName", undefined)],
    ["appName set to undefined beside a path", () => withHidden({ path: "/expected" }, "appName", undefined)],
    ["cwd beside appName", () => withHidden({ appName: "my-cli" }, "cwd", "/tmp")],
    ["fileName beside a path", () => withHidden({ path: "/expected" }, "fileName", "a.json")],
  ])("rejects a non-enumerable own %s", (_label, build) => {
    expect(() => createProjectConfig(build() as never)).toThrow(InvalidStoreOptionsError);
  });

  it("reads a non-enumerable own cwd", () => {
    const options = withHidden({ fileName: "settings.json" }, "cwd", tempRoot);
    expect(createProjectConfig(options as never).path).toBe(join(tempRoot, "settings.json"));
  });

  it("ignores an inherited cwd, so the file resolves against the working directory", () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    try {
      const options = withPrototype({ cwd: "/unexpected" }, { fileName: "settings.json" });
      expect(createProjectConfig(options as never).path).toBe(join(tempRoot, "settings.json"));
    } finally {
      spy.mockRestore();
    }
  });

  it.runIf(POSIX)("ignores inherited env, homedir, platform and fileName, so each takes its default", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempRoot);
    const inheritedEnv = withPrototype({ env: { XDG_CONFIG_HOME: "/unexpected" } }, { appName: "my-cli" });
    expect(createProjectConfig(inheritedEnv as never).path).toBe(join(tempRoot, "my-cli", "config.json"));

    const inheritedHome = withPrototype({ homedir: "/proto" }, { appName: "my-cli", env: {} });
    expect(createProjectConfig(inheritedHome as never).path).toBe(join(homedir(), ".config", "my-cli", "config.json"));

    const inheritedPlatform = withPrototype({ platform: FOREIGN_PLATFORM }, { appName: "my-cli" });
    expect(createProjectConfig(inheritedPlatform as never).path).toBe(join(tempRoot, "my-cli", "config.json"));

    const inheritedFileName = withPrototype({ fileName: "../escape.json" }, { appName: "my-cli" });
    expect(createProjectConfig(inheritedFileName as never).path).toBe(join(tempRoot, "my-cli", "config.json"));
  });
});
