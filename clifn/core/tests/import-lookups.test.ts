import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Loading @clifn/core must not depend on the lookups behind the legacy Conduct defaults (os.homedir() for
// credentials, process.cwd() for project config): the app-keyed forms and resolveAppPaths work with absolute
// overrides even when those lookups fail, and the no-argument defaults keep their reference-commit destinations.

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "clifn-import-lookups-"));
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(tempRoot, { recursive: true, force: true });
});

const appEnv = (): Record<string, string> => ({ XDG_CONFIG_HOME: tempRoot, APPDATA: tempRoot });

describe("loading @clifn/core when a legacy default lookup fails", () => {
  it("loads the root entry while os.homedir() throws, and only the no-argument credential default needs it", async () => {
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      const failing = (): string => {
        throw new Error("homedir unavailable");
      };
      return { ...actual, homedir: failing, default: { ...actual, homedir: failing } };
    });
    const core = await import("../src/index.js");

    expect(core.createCredentialStore({ appName: "my-cli", env: appEnv() }).path).toBe(join(tempRoot, "my-cli", "credentials"));
    expect(
      core.resolveAppPaths("my-cli", { platform: "linux", env: { XDG_CONFIG_HOME: "/c", XDG_STATE_HOME: "/s", XDG_CACHE_HOME: "/k" } }),
    ).toEqual({ config: "/c/my-cli", state: "/s/my-cli", cache: "/k/my-cli" });
    expect(() => core.createCredentialStore()).toThrow("homedir unavailable");
  });

  it("loads the root entry while process.cwd() throws, and computes the config default at the first call", async () => {
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });
    const core = await import("../src/index.js");

    expect(core.createProjectConfig({ appName: "my-cli", env: appEnv() }).path).toBe(join(tempRoot, "my-cli", "config.json"));
    expect(() => core.createProjectConfig()).toThrow("cwd unavailable");

    cwd.mockReturnValue(tempRoot);
    expect(core.createProjectConfig().path).toBe(join(tempRoot, "conduct.config.json"));
  });

  it("keeps the defaults captured at import when the lookups work", async () => {
    const importCwd = process.cwd();
    const core = await import("../src/index.js");
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);

    expect(core.createCredentialStore().path).toBe(join(homedir(), ".conduct", "credentials"));
    expect(core.createProjectConfig().path).toBe(join(importCwd, "conduct.config.json"));
  });
});
