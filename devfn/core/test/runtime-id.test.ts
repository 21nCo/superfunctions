import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFileLock } from "@devfn/ports";
import { afterEach, describe, expect, it, vi } from "vitest";

const linkControl = vi.hoisted(() => ({ code: undefined as string | undefined, gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (existing: string, target: string) => {
      if (linkControl.code) throw Object.assign(new Error(`${linkControl.code}: link`), { code: linkControl.code });
      if (linkControl.gate && path.basename(target) === "runtime-id") {
        linkControl.entered?.();
        await linkControl.gate;
      }
      return await actual.link(existing, target);
    },
  };
});

const { readRuntimeId, recordRuntimeId } = await import("../src/runtime.js");

async function withStateDir(action: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-id-"));
  try { await action(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
}

describe("runtime identity publication", () => {
  afterEach(() => { Object.assign(linkControl, { code: undefined, gate: undefined, entered: undefined }); });

  it("never shows a reader a partial identity while a first record is in flight", async () => {
    await withStateDir(async (stateDir) => {
      let release!: () => void;
      linkControl.gate = new Promise((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { linkControl.entered = resolve; });
      const first = recordRuntimeId(stateDir, "a".repeat(32));
      await entered;
      // The identity is fully written, but not yet in place.
      expect(await readRuntimeId(stateDir)).toBeUndefined();
      linkControl.gate = undefined;
      const concurrent = recordRuntimeId(stateDir, "b".repeat(32));
      release();
      const recorded = await Promise.all([first, concurrent]);
      expect(new Set(recorded).size).toBe(1);
      expect(await readRuntimeId(stateDir)).toBe(recorded[0]);
      expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  it("fails actionably, recording nothing, where the state directory has no hard links like its locks", async () => {
    await withStateDir(async (stateDir) => {
      for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
        linkControl.code = code;
        await expect(recordRuntimeId(stateDir, "c".repeat(32)), code).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("--state-dir") });
        expect(await readdir(stateDir), code).toEqual([]);
        // The lifecycle lock taken right after the record could not be held there either.
        await expect(withFileLock(path.join(stateDir, "lifecycle.lock"), async () => "held"), code).rejects.toMatchObject({ code });
      }
      linkControl.code = "EIO";
      await expect(recordRuntimeId(stateDir, "d".repeat(32))).rejects.toMatchObject({ code: "EIO" });
      expect(await readRuntimeId(stateDir)).toBeUndefined();
    });
  });

  it("reports an identity truncated outside DevFn without calling it a partial write", async () => {
    await withStateDir(async (stateDir) => {
      await writeFile(path.join(stateDir, "runtime-id"), "");
      await expect(readRuntimeId(stateDir)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("truncated outside DevFn") });
      await writeFile(path.join(stateDir, "runtime-id"), "abc\n");
      await expect(readRuntimeId(stateDir)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("malformed") });
      expect(await readFile(path.join(stateDir, "runtime-id"), "utf8")).toBe("abc\n");
    });
  });
});
