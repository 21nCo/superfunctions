// One writeSdk run at a time per output directory, across async calls and OS
// processes: the lock file is held from reading the previous manifest to
// writing the final one.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { generateSdk, SDK_ARTIFACT_MANIFEST_FILE, SDK_OUTPUT_LOCK_FILE, writeSdk, type SdkGenerationResult, type WriteSdkResult } from "../src/index.js";
import { cleanupTemp, fixtureCatalog, generate, PACKAGE_DIR, tempDir } from "./helpers.js";

const pause = vi.hoisted(() => ({ target: null as string | null, reached: () => {}, resume: Promise.resolve(), onRead: null as { file: string; run: () => void } | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (file: string, ...rest: unknown[]) => {
      if (pause.onRead !== null && file === pause.onRead.file) {
        const { run } = pause.onRead;
        pause.onRead = null;
        run();
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.readFile,
    rename: async (from: string, to: string) => {
      if (pause.target !== null && to === pause.target) {
        pause.target = null;
        pause.reached();
        await pause.resume;
      }
      if (pause.target === "fail") throw Object.assign(new Error("simulated failure"), { code: "EIO" });
      return actual.rename(from, to);
    },
  };
});

afterAll(cleanupTemp);

const run = promisify(execFile);
const DIST_ENTRY = path.join(PACKAGE_DIR, "dist/index.js");

/** A second process running the built package, as two `apifn sdk generate` invocations would. */
async function writeInChild(dir: string, generationFile: string, delayMs = 0): Promise<WriteSdkResult> {
  const script = `
    const { writeSdk } = await import(process.argv[1]);
    const { readFileSync } = await import("node:fs");
    await new Promise((resolve) => setTimeout(resolve, Number(process.argv[4])));
    const result = await writeSdk(process.argv[2], JSON.parse(readFileSync(process.argv[3], "utf8")));
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(DIST_ENTRY).href, dir, generationFile, String(delayMs)]);
  return JSON.parse(stdout) as WriteSdkResult;
}

function saveGeneration(result: SdkGenerationResult): string {
  const file = path.join(tempDir("apifn-sdk-gen-"), "generation.json");
  writeFileSync(file, JSON.stringify(result));
  return file;
}

/** Generation B: tasks.get removed and an extra schema, so models.ts, client.ts and README.md differ from A. */
function generationB(): SdkGenerationResult {
  const catalog = fixtureCatalog();
  catalog.operations = catalog.operations.filter((operation: any) => operation.id !== "tasks.get");
  catalog.schemas.Extra = { type: "string" };
  return generate(catalog);
}

/** Generation A2: only the tasks.list summary changes, so models.ts stays as in A. */
function generationA2(): SdkGenerationResult {
  const catalog = fixtureCatalog();
  catalog.operations.find((operation: any) => operation.id === "tasks.list").summary = "List tasks (v2)";
  return generate(catalog);
}

const sha256 = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");

/** Every file the final manifest lists has its recorded digest on disk, and no run is left holding or pending. */
function expectConsistent(dir: string): void {
  const manifest = JSON.parse(readFileSync(path.join(dir, SDK_ARTIFACT_MANIFEST_FILE), "utf8"));
  expect(manifest.pendingFiles).toBeUndefined();
  const mismatched = manifest.files.filter((entry: { path: string; sha256: string }) => sha256(readFileSync(path.join(dir, entry.path))) !== entry.sha256.replace(/^sha256:/, ""));
  expect(mismatched).toEqual([]);
  expect(existsSync(path.join(dir, SDK_OUTPUT_LOCK_FILE))).toBe(false);
}

function expectLockConflict(result: WriteSdkResult): void {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SDK_OUTPUT_CONFLICT", severity: "error", pointer: SDK_OUTPUT_LOCK_FILE })]);
  expect(result.written).toEqual([]);
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = sha256(readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

describe("the output directory lock", () => {
  it("built package is present for the cross-process tests", () => {
    expect(existsSync(DIST_ENTRY), "run the @apifn/sdk build before its tests").toBe(true);
  });

  it("keeps a second process out while a run is between planning and its final manifest", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    const reached = new Promise<void>((resolve) => (pause.reached = resolve));
    let resume!: () => void;
    pause.resume = new Promise<void>((resolve) => (resume = resolve));
    pause.target = path.join(dir, "README.md");

    // This process has planned A2 against A and stops before its first file lands.
    const first = writeSdk(dir, generationA2());
    await reached;
    const second = await writeInChild(dir, saveGeneration(generationB()));
    resume();
    expect((await first).ok).toBe(true);

    // Without the lock the child writes B's models.ts, which A2 planned as unchanged: a final A2 manifest over B's file.
    expectLockConflict(second);
    expect(second.diagnostics[0]!.message).toContain(`process ${process.pid} on `);
    expectConsistent(dir);
    expect(JSON.parse(readFileSync(path.join(dir, SDK_ARTIFACT_MANIFEST_FILE), "utf8"))).toEqual(generationA2().manifest);
  });

  it("leaves a consistent directory when two processes write different generations at once", async () => {
    const dir = tempDir();
    const files = [saveGeneration(generate()), saveGeneration(generationB())];
    for (let iteration = 0; iteration < 30; iteration++) {
      const results = await Promise.all([writeInChild(dir, files[iteration % 2]!), writeInChild(dir, files[(iteration + 1) % 2]!, iteration % 10)]);
      for (const result of results) {
        if (!result.ok) {
          expectLockConflict(result);
        }
      }
      expect(results.some((result) => result.ok)).toBe(true);
      expectConsistent(dir);
    }
  }, 120_000);

  it("gives overlapping calls in one process the same guarantee", async () => {
    const dir = tempDir();
    const results = await Promise.all([writeSdk(dir, generate()), writeSdk(dir, generationB())]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expectLockConflict(results.find((result) => !result.ok)!);
    expectConsistent(dir);
    expect(readdirSync(path.join(dir, "src")).filter((name) => name.includes(".apifn-tmp-"))).toEqual([]);
  });

  it("never takes over a lock another run left, and changes nothing", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    const lock = path.join(dir, SDK_OUTPUT_LOCK_FILE);
    const held = `${JSON.stringify({ pid: 4242, hostname: "build-host", startedAt: "2026-10-22T00:00:00.000Z", nonce: "other" })}\n`;
    writeFileSync(lock, held);
    const before = tree(dir);
    for (const options of [{}, { dryRun: true }]) {
      const result = await writeSdk(dir, generationB(), options);
      expectLockConflict(result);
      expect(result.diagnostics[0]!.message).toContain("process 4242 on build-host since 2026-10-22T00:00:00.000Z");
      expect(result.diagnostics[0]!.message).toContain("remove it and rerun");
      expect(tree(dir)).toEqual(before);
    }
    // An empty or unreadable lock (a holder that has not written it yet) is held all the same.
    writeFileSync(lock, "");
    expectLockConflict(await writeSdk(dir, generationB()));

    // Removing it by hand recovers.
    rmSync(lock);
    expect((await writeSdk(dir, generationB())).ok).toBe(true);
    expectConsistent(dir);
  });

  // Permission bits do not restrict root, and Windows ignores them.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is not needed by a dry run, which works on a read-only directory", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    const before = tree(dir);
    const directories = [dir, ...Object.keys(tree(dir)).map((file) => path.join(dir, path.dirname(file)))].filter((directory, index, all) => all.indexOf(directory) === index);
    for (const directory of directories) chmodSync(directory, 0o555);
    try {
      const upToDate = await writeSdk(dir, generate(), { dryRun: true });
      expect(upToDate).toMatchObject({ ok: true, written: [], deleted: [], seeded: [], diagnostics: [] });
      const stale = await writeSdk(dir, generationB(), { dryRun: true });
      expect(stale.ok).toBe(true);
      expect([...stale.written].sort()).toEqual([SDK_ARTIFACT_MANIFEST_FILE, "README.md", "src/client.ts", "src/models.ts"].sort());
      expect(tree(dir)).toEqual(before);
    } finally {
      for (const directory of directories) chmodSync(directory, 0o755);
    }
  });

  it("makes a dry run report a lock taken while it plans", async () => {
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    const lock = path.join(dir, SDK_OUTPUT_LOCK_FILE);
    const held = `${JSON.stringify({ pid: 4242, hostname: "build-host", startedAt: "2026-10-22T00:00:00.000Z", nonce: "other" })}\n`;
    pause.onRead = { file: path.join(dir, "src/models.ts"), run: () => writeFileSync(lock, held) };
    const result = await writeSdk(dir, generationB(), { dryRun: true });
    expect(pause.onRead).toBeNull();
    expectLockConflict(result);
    expect(result.diagnostics[0]!.message).toContain("process 4242 on build-host");
    expect(readFileSync(lock, "utf8")).toBe(held);
  });

  it("is released after a planning conflict, a dry run and a failed write", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src/client.ts"), "// hand-written\n");
    const conflict = await writeSdk(dir, generate());
    expect(conflict.diagnostics.map((diagnostic) => diagnostic.pointer)).toEqual(["src/client.ts"]);
    expect(existsSync(path.join(dir, SDK_OUTPUT_LOCK_FILE))).toBe(false);

    const clean = tempDir();
    expect((await writeSdk(clean, generate(), { dryRun: true })).ok).toBe(true);
    expect(readdirSync(clean)).toEqual([]);
    expect((await writeSdk(clean, generate())).ok).toBe(true);
    pause.target = "fail";
    await expect(writeSdk(clean, generationB())).rejects.toThrow("simulated failure");
    pause.target = null;
    expect(existsSync(path.join(clean, SDK_OUTPUT_LOCK_FILE))).toBe(false);
    expect((await writeSdk(clean, generationB())).ok).toBe(true);
    expectConsistent(clean);
  });

  it("is reserved: a target cannot generate it and a manifest cannot claim it", async () => {
    const target = {
      id: "list",
      version: "1.0.0",
      customCodeRoot: "custom/",
      resolveOptions: (input: unknown) => ({ options: input as { package: { name: string; version: string } }, diagnostics: [] }),
      packageOf: (options: { package: { name: string; version: string } }) => options.package,
      unsupportedReasons: () => [],
      emit: () => ({ files: [{ path: ".APIFN-SDK.lock", contents: "x\n", ownership: "generated" as const }], diagnostics: [] }),
    };
    const result = generateSdk({ catalog: fixtureCatalog(), config: { target: "list", options: { package: { name: "list-sdk", version: "1.0.0" } } }, targets: [target] });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SDK_OUTPUT_CONFLICT", pointer: ".APIFN-SDK.lock" }));

    // A previous manifest that lists the lock never gets it deleted as a stale owned file.
    const dir = tempDir();
    expect((await writeSdk(dir, generate())).ok).toBe(true);
    const manifestPath = path.join(dir, SDK_ARTIFACT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push({ path: SDK_OUTPUT_LOCK_FILE, sha256: "0".repeat(64) });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const rewritten = await writeSdk(dir, generate());
    expect(rewritten.ok).toBe(true);
    expect(rewritten.deleted).toEqual([]);
  });
});
