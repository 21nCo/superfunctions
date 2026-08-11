import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpFnRegistry,
  createManifest,
  structuredResult,
} from "@mcpfn/core";

import { loadManifestSource, runCli } from "../src/index.js";

describe("mcpfn CLI", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("validates and diffs manifests with stable exit codes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-"));
    roots.push(root);
    const make = (required: string[]) => {
      const registry = new McpFnRegistry().register({
        name: "tool",
        description: "A tool.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" }, label: { type: "string" } },
          required,
        },
        handler: async () => structuredResult({ ok: true }),
      });
      return createManifest({ name: "test", version: "1.0.0" }, registry);
    };
    await writeFile(path.join(root, "before.json"), JSON.stringify(make(["value"])));
    await writeFile(path.join(root, "after.json"), JSON.stringify(make(["value", "label"])));
    let output = "";
    expect(await runCli(["validate", "before.json"], { cwd: root, stdout: (value) => { output += value; } })).toBe(0);
    expect(output).toContain("Valid McpFn manifest");
    expect(await runCli(["diff", "before.json", "after.json", "--json"], { cwd: root, stdout: (value) => { output += value; } })).toBe(1);
    expect(JSON.parse(await readFile(path.join(root, "before.json"), "utf8")).formatVersion).toBe(1);
  });

  it("loads a server by public shape across package-instance boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-server-"));
    roots.push(root);
    const manifest = createManifest({ name: "foreign", version: "1.0.0" }, new McpFnRegistry());
    await writeFile(
      path.join(root, "server.mjs"),
      `export default {
        manifest() { return ${JSON.stringify(manifest)}; },
        async connect() {},
        async close() {}
      };`,
    );

    await expect(loadManifestSource("server.mjs", root)).resolves.toMatchObject({
      manifest: { server: { name: "foreign" } },
      server: expect.any(Object),
    });
  });
});
