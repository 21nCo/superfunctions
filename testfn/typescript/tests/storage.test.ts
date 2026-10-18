import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { TestStorage, getArtifactId } from "../src/storage/test-storage.js";
import { AnalyticsEngine } from "../src/analytics/analytics-engine.js";
import type { TestRun, StorageConfig } from "../src/types.js";
const run = (
  id: string,
  timestamp: number,
  status: "passed" | "failed" = "passed",
): TestRun => ({
  id,
  timestamp,
  summary: {
    total: 1,
    passed: status === "passed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    skipped: 0,
    duration: 1,
  },
  results: [
    {
      id: "same-test",
      status,
      duration: 1,
      artifacts: [{ type: "log", path: "log.txt", buffer: Buffer.from(id) }],
    },
  ],
  environment: { platform: "test", nodeVersion: process.version, ci: false },
});
for (const type of ["indexeddb", "file", "db"] as const)
  describe(`${type} persistence`, () => {
    it("orders history by timestamp, retains repeated IDs and cleans associated artifacts", async () => {
      const dir = await mkdtemp(join(tmpdir(), "testfn-store-"));
      const config: StorageConfig = {
        type,
        dbName: type === "file" ? dir : randomUUID(),
        adapter: type === "db" ? memoryAdapter() : undefined,
        retentionDays: 1,
      };
      const storage = new TestStorage(config);
      try {
        await storage.open();
        await storage.saveRun(
          run("z-old", Date.now() - 3 * 86400000, "failed"),
        );
        await storage.saveRun(run("a-new", Date.now()));
        expect((await storage.getRecentRuns(1))[0].id).toBe("a-new");
        expect(
          (await storage.getTestHistory("same-test", 2)).map((r) => r.status),
        ).toEqual(["passed", "failed"]);
        expect(
          await storage.getArtifact(getArtifactId("z-old", "same-test", "log")),
        ).not.toBeNull();
        await storage.cleanup();
        expect(await storage.getRun("z-old")).toBeNull();
        expect(
          await storage.getArtifact(getArtifactId("z-old", "same-test", "log")),
        ).toBeNull();
        expect(await storage.getTestHistory("same-test", 10)).toHaveLength(1);
        expect(await storage.getRecentRuns(0)).toEqual([]);
        await expect(storage.getRecentRuns(-1)).rejects.toThrow("limit");
      } finally {
        await storage.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
it("file backend persists across independent storage instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testfn-reopen-"));
  try {
    const first = new TestStorage({ type: "file", dbName: dir });
    await first.open();
    await first.saveRun(run("../../id", 1));
    await first.close();
    const second = new TestStorage({ type: "file", dbName: dir });
    await second.open();
    expect((await second.getRun("../../id"))?.id).toBe("../../id");
    expect(
      (
        await second.getArtifact(getArtifactId("../../id", "same-test", "log"))
      )?.buffer?.toString(),
    ).toBe("../../id");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("empty analytics remain finite and skipped results do not create flakiness", async () => {
  const storage = new TestStorage({ type: "indexeddb", dbName: randomUUID() });
  await storage.open();
  try {
    await storage.saveRun({
      ...run("empty", 1),
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 },
    });
    const analytics = new AnalyticsEngine(storage);
    expect(await analytics.computeMetrics("empty")).toMatchObject({
      successRate: 0,
      avgDuration: 0,
      p95Duration: 0,
    });
  } finally {
    await storage.close();
  }
});
it("artifact identities cannot collide across ambiguous run/test separators", async () => {
  const storage = new TestStorage({ type: "indexeddb", dbName: randomUUID() });
  await storage.open();
  try {
    const first = run("a-b", 1),
      second = run("a", 2);
    first.results[0].id = "c";
    second.results[0].id = "b-c";
    await storage.saveRun(first);
    await storage.saveRun(second);
    const a = getArtifactId("a-b", "c", "log"),
      b = getArtifactId("a", "b-c", "log");
    expect(a).not.toBe(b);
    expect(await storage.getArtifact(a)).not.toBeNull();
    expect(await storage.getArtifact(b)).not.toBeNull();
    expect((await storage.getRun("a-b"))?.artifacts?.[0].id).toBe(a);
  } finally {
    await storage.close();
  }
});
for (const type of ["indexeddb", "file", "db"] as const)
  it(`${type} streams and decompresses large artifacts without embedding bytes in run records`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "testfn-chunks-"));
    const storage = new TestStorage({
      type,
      dbName: type === "file" ? dir : randomUUID(),
      adapter: type === "db" ? memoryAdapter() : undefined,
      retentionDays: 0,
    });
    await storage.open();
    try {
      const bytes = Buffer.alloc(200000, "sample log\n");
      const item = run("chunk-run", 1);
      item.results[0].artifacts![0].buffer = bytes;
      await storage.saveRun(item);
      const id = getArtifactId("chunk-run", "same-test", "log");
      expect(
        (await storage.getRun("chunk-run"))?.results[0].artifacts?.[0].buffer,
      ).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of storage.getArtifactStream(id)) {
        expect(chunk.length).toBeLessThanOrEqual(65536);
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(1);
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect((await storage.getArtifact(id))?.buffer).toEqual(bytes);
      await storage.saveArtifactStream(
        {
          id,
          runId: "chunk-run",
          testId: "same-test",
          type: "log",
          path: "log.txt",
        },
        (async function* () {
          yield Buffer.from("replacement");
        })(),
      );
      expect((await storage.getArtifact(id))?.buffer?.toString()).toBe(
        "replacement",
      );
      await storage.cleanup();
      expect(await storage.getArtifact(id)).toBeNull();
    } finally {
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
it("automatically applies retention at the configured run-write threshold", async () => {
  const storage = new TestStorage({
    type: "indexeddb",
    dbName: crypto.randomUUID(),
    retentionDays: 1,
    cleanupThreshold: 2,
  });
  await storage.open();
  try {
    await storage.saveRun(run("old", 1));
    expect(await storage.getRun("old")).not.toBeNull();
    await storage.saveRun(run("current", Date.now()));
    expect(await storage.getRun("old")).toBeNull();
    expect(await storage.getRun("current")).not.toBeNull();
  } finally {
    await storage.close();
  }
});
it("file metadata preserves reserved-looking objects, dates and undefined properties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "testfn-metadata-"));
  const storage = new TestStorage({ type: "file", dbName: directory });
  await storage.open();
  try {
    const item = run("metadata", 1);
    item.results[0].metadata = {
      bufferLike: { type: "Buffer", data: [1, 2] },
      date: new Date("2020-01-01"),
      missing: undefined,
    };
    await storage.saveRun(item);
    expect((await storage.getRun("metadata"))?.results[0].metadata).toEqual(
      item.results[0].metadata,
    );
    const cycle: any = {};
    cycle.self = cycle;
    item.results[0].metadata = cycle;
    await expect(storage.saveRun(item)).rejects.toThrow("Circular");
    expect(
      (await storage.getRun("metadata"))?.results[0].metadata?.bufferLike,
    ).toEqual({ type: "Buffer", data: [1, 2] });
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
