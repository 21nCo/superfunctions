import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore, InvalidStoreOptionsError } from "../src/credentials.js";
import { createProjectConfig } from "../src/config.js";
import { InvalidAppNameError } from "../src/paths.js";

// The defaults as they are defined at the reference commit (D2): these must never move.
const CONDUCT_CREDENTIALS_PATH = join(homedir(), ".conduct", "credentials");
const CONDUCT_CONFIG_PATH = join(process.cwd(), "conduct.config.json");

const PROFILE = { backend: "https://api.example.test", key: "test-api-key" };
const POSIX = process.platform !== "win32";

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

  it("{ appName } passes platform, env and homedir through to resolveAppPaths", () => {
    expect(createCredentialStore({ appName: "my-cli", platform: "linux", homedir: "/home/ada", env: {} }).path).toBe(
      "/home/ada/.config/my-cli/credentials",
    );
    expect(
      createCredentialStore({ appName: "my-cli", platform: "win32", homedir: "C:\\Users\\ada", env: { APPDATA: "D:\\Roam" } }).path,
    ).toBe("D:\\Roam\\my-cli\\credentials");
  });

  it("rejects an invalid app name", () => {
    expect(() => createCredentialStore({ appName: "../conduct" })).toThrow(InvalidAppNameError);
    expect(() => createCredentialStore({ appName: "" })).toThrow(InvalidAppNameError);
  });

  it.each([
    ["both appName and path", { appName: "my-cli", path: "/tmp/x" }],
    ["neither appName nor path", {}],
    ["appName and path undefined", { appName: undefined }],
    ["a non-string path", { path: 42 }],
  ])("rejects options with %s instead of falling back to the Conduct default", (_label, options) => {
    expect(() => createCredentialStore(options as never)).toThrow(InvalidStoreOptionsError);
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

  it("{ appName, fileName } uses the file name under the config directory", () => {
    const options = { appName: "my-cli", platform: "linux", homedir: "/home/ada", env: {} } as const;
    expect(createProjectConfig({ ...options, fileName: "settings.json" }).path).toBe("/home/ada/.config/my-cli/settings.json");
    expect(createProjectConfig({ ...options, fileName: "profiles/dev.json" }).path).toBe(
      "/home/ada/.config/my-cli/profiles/dev.json",
    );
    expect(
      createProjectConfig({ appName: "my-cli", platform: "win32", homedir: "C:\\Users\\ada", env: {}, fileName: "a/b.json" }).path,
    ).toBe("C:\\Users\\ada\\AppData\\Roaming\\my-cli\\a\\b.json");
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

  it("rejects a Windows parent escape when paths resolve for win32", () => {
    expect(() =>
      createProjectConfig({ appName: "my-cli", platform: "win32", homedir: "C:\\Users\\ada", env: {}, fileName: "..\\outside.json" }),
    ).toThrow(InvalidStoreOptionsError);
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
  ])("rejects options with %s", (_label, options) => {
    expect(() => createProjectConfig(options as never)).toThrow(InvalidStoreOptionsError);
  });

  it("rejects an invalid app name", () => {
    expect(() => createProjectConfig({ appName: "My-CLI" })).toThrow(InvalidAppNameError);
  });
});
