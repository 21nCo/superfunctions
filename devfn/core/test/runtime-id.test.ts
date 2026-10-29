import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const linkFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (existing: string, target: string) => {
      if (linkFailure.code) throw Object.assign(new Error(`${linkFailure.code}: link`), { code: linkFailure.code });
      return await actual.link(existing, target);
    },
  };
});

const { readRuntimeId, recordRuntimeId } = await import("../src/runtime.js");

describe("runtime identity on filesystems without hard links", () => {
  afterEach(() => { linkFailure.code = undefined; });

  it("records one identity with an exclusive create when link is unsupported", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-id-nolink-"));
    try {
      for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
        linkFailure.code = code;
        await rm(path.join(stateDir, "runtime-id"), { force: true });
        const recorded = await Promise.all(["a", "b", "c"].map((digit) => recordRuntimeId(stateDir, digit.repeat(32))));
        expect(new Set(recorded).size, code).toBe(1);
        expect(await readRuntimeId(stateDir), code).toBe(recorded[0]);
        expect((await readFile(path.join(stateDir, "runtime-id"), "utf8")).trim()).toBe(recorded[0]);
        expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp")), code).toEqual([]);
      }
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("still fails on other link errors", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "devfn-runtime-id-nolink-"));
    try {
      linkFailure.code = "EIO";
      await expect(recordRuntimeId(stateDir, "d".repeat(32))).rejects.toMatchObject({ code: "EIO" });
      expect(await readRuntimeId(stateDir)).toBeUndefined();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
