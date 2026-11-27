import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigLoaderError, defineConfig, loadConfig, type ConfigLoaderOptions } from "../src/config-loader.js";

describe("loadConfig", () => {
  it("loads a TypeScript config deterministically and applies validation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "clifn-config-loader-"));

    try {
      await writeFile(
        path.join(cwd, "tool.config.ts"),
        'export const config = { source: "ts", count: 2 };\n',
        "utf8"
      );
      await writeFile(
        path.join(cwd, "tool.config.js"),
        'export default { source: "js" };\n',
        "utf8"
      );

      const loaded = await loadConfig({
        cwd,
        candidates: ["tool.config.ts", "tool.config.js"],
        exportNames: ["config"],
        validate(value, resolvedPath) {
          const config = value as { source: string; count: number };
          return defineConfig({
            ...config,
            loadedFrom: path.basename(resolvedPath),
          });
        },
      });

      expect(path.basename(loaded.path)).toBe("tool.config.ts");
      expect(loaded.config).toEqual({
        source: "ts",
        count: 2,
        loadedFrom: "tool.config.ts",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads JSON configs through explicit configPath", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "clifn-config-loader-"));

    try {
      const configPath = path.join(cwd, "tool.config.json");
      await writeFile(configPath, JSON.stringify({ source: "json", ok: true }), "utf8");

      const loaded = await loadConfig({
        cwd,
        configPath,
      });

      expect(loaded.path).toBe(configPath);
      expect(loaded.config).toEqual({ source: "json", ok: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves plain json objects that happen to contain a default key", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "clifn-config-loader-"));

    try {
      const configPath = path.join(cwd, "tool.config.json");
      await writeFile(configPath, JSON.stringify({ default: "kept", ok: true }), "utf8");

      const loaded = await loadConfig({
        cwd,
        configPath,
      });

      expect(loaded.config).toEqual({ default: "kept", ok: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails deterministically for remote explicit config paths", async () => {
    await expect(
      loadConfig({
        configPath: "https://example.com/tool.config.ts",
      })
    ).rejects.toMatchObject({
      code: "CLIFN_CONFIG_NOT_FOUND",
      message: "Remote config URLs are not supported.",
    });
  });

  it("fails deterministically for missing explicit config paths", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "clifn-config-loader-"));

    try {
      await expect(
        loadConfig({
          cwd,
          configPath: "missing.config.ts",
        })
      ).rejects.toMatchObject({
        code: "CLIFN_CONFIG_NOT_FOUND",
        message: "Config file not found: missing.config.ts",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("normalizes runtime loader failures into typed config errors", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "clifn-config-loader-"));

    try {
      const configPath = path.join(cwd, "tool.config.js");
      await writeFile(configPath, 'throw new Error("boom");\n', "utf8");

      await expect(
        loadConfig({
          cwd,
          configPath,
        })
      ).rejects.toMatchObject({
        code: "CLIFN_CONFIG_INVALID",
        message: "boom",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

const EXECUTABLE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;
type ExecutableExtension = (typeof EXECUTABLE_EXTENSIONS)[number];

/**
 * An inert import observer: the config writes `<name>.ran` next to itself when it is evaluated and exports a value
 * naming its extension, so a test can tell whether the loader ran it without the config doing anything else.
 */
function observerSource(extension: ExecutableExtension, marker: string): string {
  const markerLiteral = JSON.stringify(marker);
  const value = JSON.stringify({ source: extension.slice(1) });
  if (extension === ".cjs") {
    return `require("node:fs").writeFileSync(${markerLiteral}, "ran");\nmodule.exports = ${value};\n`;
  }
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${markerLiteral}, "ran");\nexport default ${value};\n`;
}

async function writeObserver(dir: string, fileName: string, extension: ExecutableExtension): Promise<string> {
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, observerSource(extension, `${filePath}.ran`), "utf8");
  return filePath;
}

async function ranMarkers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => entry.endsWith(".ran")).sort();
}

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "clifn-config-policy-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function loadError(options: ConfigLoaderOptions<unknown>): Promise<ConfigLoaderError> {
  try {
    await loadConfig(options);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigLoaderError);
    return error as ConfigLoaderError;
  }
  throw new Error("expected loadConfig to reject");
}

describe("loadConfig data-only policy", () => {
  it("keeps the executable default: discovery still runs config.ts ahead of config.json", async () => {
    await withWorkspace(async (cwd) => {
      await writeObserver(cwd, "config.ts", ".ts");
      await writeFile(path.join(cwd, "config.json"), JSON.stringify({ source: "json" }), "utf8");

      const loaded = await loadConfig({ cwd });

      expect(path.basename(loaded.path)).toBe("config.ts");
      expect(loaded.config).toEqual({ source: "ts" });
      expect(await ranMarkers(cwd)).toEqual(["config.ts.ran"]);
    });
  });

  it("loads config.json in discovery and never imports the executable candidates ahead of it", async () => {
    await withWorkspace(async (cwd) => {
      for (const extension of EXECUTABLE_EXTENSIONS) {
        await writeObserver(cwd, `config${extension}`, extension);
      }
      await writeFile(path.join(cwd, "config.json"), JSON.stringify({ source: "json" }), "utf8");

      const loaded = await loadConfig({ cwd, policy: "data-only", trustExecutableConfig: true });

      expect(loaded).toEqual({ config: { source: "json" }, path: path.join(cwd, "config.json") });
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });

  it("applies JSON-only discovery to custom candidates too", async () => {
    await withWorkspace(async (cwd) => {
      await writeObserver(cwd, "tool.config.mjs", ".mjs");
      await writeFile(path.join(cwd, "tool.config.json"), JSON.stringify({ source: "json" }), "utf8");

      const loaded = await loadConfig({
        cwd,
        policy: "data-only",
        candidates: ["tool.config.mjs", "tool.config.json"],
      });

      expect(path.basename(loaded.path)).toBe("tool.config.json");
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });

  it.each(EXECUTABLE_EXTENSIONS)(
    "reports a discovered %s config as untrusted without importing it, even when trust is given",
    async (extension) => {
      await withWorkspace(async (cwd) => {
        await writeObserver(cwd, `config${extension}`, extension);

        for (const trustExecutableConfig of [undefined, true]) {
          const error = await loadError({ cwd, policy: "data-only", trustExecutableConfig });
          expect(error.code).toBe("CLIFN_CONFIG_UNTRUSTED");
          expect(error.message).toBe(
            `Found executable config config${extension} but the data-only config policy loads JSON only. ` +
              "Convert it to a .json config, or pass it as the explicit config path with the CLI's explicit trust option."
          );
        }
        expect(await ranMarkers(cwd)).toEqual([]);
      });
    }
  );

  it("lists only the JSON candidates when nothing is found", async () => {
    await withWorkspace(async (cwd) => {
      const error = await loadError({ cwd, policy: "data-only" });
      expect(error.code).toBe("CLIFN_CONFIG_NOT_FOUND");
      expect(error.message).toBe("Config file not found. Checked: config.json");

      await writeFile(path.join(cwd, "tool.config.yaml"), "source: yaml\n", "utf8");
      const none = await loadError({ cwd, policy: "data-only", candidates: ["tool.config.ts", "tool.config.yaml"] });
      expect(none.code).toBe("CLIFN_CONFIG_NOT_FOUND");
      expect(none.message).toBe(
        "Config file not found. The data-only config policy checks only .json candidates, and none were given."
      );
    });
  });

  it.each(EXECUTABLE_EXTENSIONS)(
    "rejects an explicit %s path before importing it unless trust is given",
    async (extension) => {
      await withWorkspace(async (cwd) => {
        const configPath = await writeObserver(cwd, `tool.config${extension}`, extension);

        for (const trustExecutableConfig of [undefined, false, "true" as unknown as boolean]) {
          const error = await loadError({ cwd, configPath, policy: "data-only", trustExecutableConfig });
          expect(error.code).toBe("CLIFN_CONFIG_UNTRUSTED");
          expect(error.message).toBe(
            `Refusing to run executable config ${configPath}: the data-only config policy loads JSON only. ` +
              "Use a .json config, or rerun with the CLI's explicit trust option to run this file."
          );
        }
        expect(await ranMarkers(cwd)).toEqual([]);

        const loaded = await loadConfig({ cwd, configPath, policy: "data-only", trustExecutableConfig: true });
        expect(loaded).toEqual({ config: { source: extension.slice(1) }, path: configPath });
        expect(await ranMarkers(cwd)).toEqual([`tool.config${extension}.ran`]);
      });
    }
  );

  it("decides trust from the extension alone: a missing or upper-case executable path is still untrusted", async () => {
    await withWorkspace(async (cwd) => {
      const missing = await loadError({ cwd, configPath: "missing.config.ts", policy: "data-only" });
      expect(missing.code).toBe("CLIFN_CONFIG_UNTRUSTED");

      const upper = await writeObserver(cwd, "TOOL.CONFIG.MJS", ".mjs");
      const error = await loadError({ cwd, configPath: upper, policy: "data-only" });
      expect(error.code).toBe("CLIFN_CONFIG_UNTRUSTED");
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });

  it("loads an explicit JSON path without trust", async () => {
    await withWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "tool.config.json"), JSON.stringify({ source: "json" }), "utf8");

      const loaded = await loadConfig({ cwd, configPath: "tool.config.json", policy: "data-only" });

      expect(loaded).toEqual({ config: { source: "json" }, path: path.join(cwd, "tool.config.json") });
    });
  });

  it("rejects an unknown policy before reading or importing anything", async () => {
    await withWorkspace(async (cwd) => {
      await writeObserver(cwd, "config.ts", ".ts");

      for (const policy of ["data_only", "", null, true]) {
        const error = await loadError({ cwd, policy: policy as unknown as "data-only" });
        expect(error.code).toBe("CLIFN_CONFIG_INVALID");
        expect(error.message).toBe('Unknown config loader policy. Use "executable" or "data-only".');
      }
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });

  it("reads configPath and the trust signal once, so a getter cannot swap the path that was checked", async () => {
    await withWorkspace(async (cwd) => {
      const jsonPath = path.join(cwd, "tool.config.json");
      await writeFile(jsonPath, JSON.stringify({ source: "json" }), "utf8");
      const scriptPath = await writeObserver(cwd, "tool.config.js", ".js");

      let reads = 0;
      const options = {
        cwd,
        policy: "data-only" as const,
        get configPath() {
          reads += 1;
          return reads === 1 ? jsonPath : scriptPath;
        },
      };

      const loaded = await loadConfig(options);
      expect(loaded.path).toBe(jsonPath);
      expect(reads).toBe(1);
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });
});

const fixtureCli = fileURLToPath(new URL("./fixtures/config-cli/cli.mjs", import.meta.url));

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the fixture CLI with its stdin left open and never written to, so a prompt would hang until the timeout
 * instead of passing.
 */
function runCli(cwd: string, args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureCli, ...args], {
      cwd,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture CLI did not exit (waiting on input?): ${stderr}`));
    }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("data-only config in a CLI command", () => {
  beforeAll(() => {
    expect(existsSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)))).toBe(true);
  });

  it("loads config.json from the workspace and never runs config.ts beside it", async () => {
    await withWorkspace(async (cwd) => {
      await writeObserver(cwd, "config.ts", ".ts");
      await writeFile(path.join(cwd, "config.json"), JSON.stringify({ source: "json" }), "utf8");

      const run = await runCli(cwd, ["show", "--json"]);

      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        ok: true,
        data: { path: await realWorkspacePath(cwd, "config.json"), config: { source: "json" } },
      });
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });

  it.each(EXECUTABLE_EXTENSIONS)(
    "fails --config with a %s file without prompting or running it, and runs it with --trust-config",
    async (extension) => {
      await withWorkspace(async (cwd) => {
        const fileName = `tool.config${extension}`;
        await writeObserver(cwd, fileName, extension);

        const refused = await runCli(cwd, ["show", "--config", fileName, "--json"]);
        expect(refused.code).toBe(1);
        expect(JSON.parse(refused.stdout)).toEqual({
          ok: false,
          error: {
            code: "CLIFN_CONFIG_UNTRUSTED",
            message:
              `Refusing to run executable config ${fileName}: the data-only config policy loads JSON only. ` +
              "Use a .json config, or rerun with the CLI's explicit trust option to run this file.",
          },
        });
        expect(await ranMarkers(cwd)).toEqual([]);

        const trusted = await runCli(cwd, ["show", "--config", fileName, "--trust-config", "--json"]);
        expect(trusted.code).toBe(0);
        expect(JSON.parse(trusted.stdout)).toMatchObject({ ok: true, data: { config: { source: extension.slice(1) } } });
        expect(await ranMarkers(cwd)).toEqual([`${fileName}.ran`]);
      });
    }
  );

  it("reports a discovered executable config in text mode on stderr, with no output on stdout", async () => {
    await withWorkspace(async (cwd) => {
      await writeObserver(cwd, "config.mjs", ".mjs");

      const run = await runCli(cwd, ["show", "--trust-config"]);

      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(
        "[x] Found executable config config.mjs but the data-only config policy loads JSON only. " +
          "Convert it to a .json config, or pass it as the explicit config path with the CLI's explicit trust option.\n"
      );
      expect(await ranMarkers(cwd)).toEqual([]);
    });
  });
});

async function realWorkspacePath(cwd: string, fileName: string): Promise<string> {
  // The child's process.cwd() is the real path (macOS tmpdir sits behind a /var -> /private/var symlink).
  const { realpath } = await import("node:fs/promises");
  return path.join(await realpath(cwd), fileName);
}
