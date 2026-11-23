// Packed-package acceptance: `npm pack` must ship both public exports, and
// each must resolve from an installed tarball (ESM and CommonJS), outside the
// workspace source tree.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const stdioFixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

function findInstalledPackage(name: string): string {
  for (let dir = packageRoot; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`Cannot find installed ${name}`);
  }
}

const consumerScript = `
import { createRequire } from "node:module";
import * as remote from "@mcpfn/client";
import * as stdio from "@mcpfn/client/stdio";

const require = createRequire(import.meta.url);
const remoteCjs = require("@mcpfn/client");
const stdioCjs = require("@mcpfn/client/stdio");
const [fixture] = process.argv.slice(2);

async function roundTrip(target, value) {
  const client = remote.createMcpFnClient({ target });
  try {
    await client.connect();
    return (await client.tools.call("echo", { value })).structuredContent;
  } finally {
    await client.close();
  }
}

const options = { command: process.execPath, args: [fixture] };
process.stdout.write(JSON.stringify({
  resolved: {
    esm: import.meta.resolve("@mcpfn/client"),
    esmStdio: import.meta.resolve("@mcpfn/client/stdio"),
    cjs: require.resolve("@mcpfn/client"),
    cjsStdio: require.resolve("@mcpfn/client/stdio"),
  },
  remoteExports: Object.keys(remote).sort(),
  stdioExports: Object.keys(stdio).sort(),
  cjsRemoteHasClient: typeof remoteCjs.createMcpFnClient,
  cjsStdioTarget: typeof stdioCjs.stdioTarget,
  subpath: await roundTrip(stdio.stdioTarget(options), "subpath"),
  cjsSubpath: await roundTrip(stdioCjs.stdioTarget(options), "cjs-subpath"),
  deprecatedMainEntry: await roundTrip(remote.stdioTarget(options), "compat"),
}));
`;

describe("packed @mcpfn/client", () => {
  let workDir: string;
  let installDir: string;
  let packedFiles: string[];

  beforeAll(async () => {
    if (!existsSync(path.join(packageRoot, "dist", "index.js"))) {
      throw new Error("Build @mcpfn/client (npm run build) before the packed-package test");
    }
    workDir = await mkdtemp(path.join(tmpdir(), "mcpfn-client-pack-"));
    const { stdout } = await run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--json", "--pack-destination", workDir],
      { cwd: packageRoot },
    );
    const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    packedFiles = packed!.files.map((file) => file.path).sort();

    const nodeModules = path.join(workDir, "consumer", "node_modules");
    installDir = path.join(nodeModules, "@mcpfn", "client");
    await mkdir(installDir, { recursive: true });
    await run("tar", ["-xzf", path.join(workDir, packed!.filename), "-C", installDir, "--strip-components=1"]);
    // Link only the package's own runtime dependencies into the consumer.
    for (const name of ["@modelcontextprotocol/sdk", "@cfworker/json-schema"]) {
      const target = path.join(nodeModules, name);
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(findInstalledPackage(name), target, "junction");
    }
    await writeFile(path.join(workDir, "consumer", "consumer.mjs"), consumerScript);
  }, 60_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("ships both exports and the stdio stub, without sources or tests", () => {
    expect(packedFiles).toEqual(expect.arrayContaining([
      "CHANGELOG.md",
      "README.md",
      "package.json",
      "dist/index.js",
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/index.d.cts",
      "dist/stdio.js",
      "dist/stdio.cjs",
      "dist/stdio.d.ts",
      "dist/stdio.d.cts",
      "dist/stdio-unavailable.js",
      "dist/stdio-unavailable.cjs",
    ]));
    expect(packedFiles.filter((file) => /^(src|tests)\//.test(file))).toEqual([]);
  });

  it("resolves the main and stdio exports from the installed tarball", async () => {
    const { stdout } = await run(process.execPath, ["consumer.mjs", stdioFixture], {
      cwd: path.join(workDir, "consumer"),
      timeout: 30_000,
    });
    const result = JSON.parse(stdout) as {
      resolved: Record<string, string>;
      remoteExports: string[];
      stdioExports: string[];
    } & Record<string, unknown>;
    const installedDist = path.join(await realpath(installDir), "dist");
    expect({
      esm: fileURLToPath(result.resolved.esm!),
      esmStdio: fileURLToPath(result.resolved.esmStdio!),
      cjs: result.resolved.cjs,
      cjsStdio: result.resolved.cjsStdio,
    }).toEqual({
      esm: path.join(installedDist, "index.js"),
      esmStdio: path.join(installedDist, "stdio.js"),
      cjs: path.join(installedDist, "index.cjs"),
      cjsStdio: path.join(installedDist, "stdio.cjs"),
    });
    expect(result.remoteExports).toEqual(expect.arrayContaining([
      "createMcpFnClient", "customTarget", "stdioTarget", "streamableHttpTarget", "transportTarget",
    ]));
    expect(result.stdioExports).toEqual(["stdioTarget"]);
    expect(result).toMatchObject({
      cjsRemoteHasClient: "function",
      cjsStdioTarget: "function",
      subpath: { value: "subpath" },
      cjsSubpath: { value: "cjs-subpath" },
      deprecatedMainEntry: { value: "compat" },
    });
  }, 60_000);
});
