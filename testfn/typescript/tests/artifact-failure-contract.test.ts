import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexedDbManager } from "../src/storage/indexeddb-manager.js";
import {
  persistArtifact,
  readArtifact,
  readArtifactStream,
} from "../src/storage/artifacts.js";
import nodeReporter from "../src/integrations/node-reporter.js";
const collect = async (source: AsyncIterable<Uint8Array>) => {
  const values = [];
  for await (const value of source) values.push(value);
  return Buffer.concat(values);
};
it("rolls back failed chunks, preserves previous data, and detects corruption", async () => {
  const manager = new IndexedDbManager({ dbName: crypto.randomUUID() });
  await manager.open();
  const artifact = {
    id: "asset",
    runId: "run",
    testId: "test",
    type: "screenshot" as const,
    path: "",
  };
  try {
    await persistArtifact(manager, { ...artifact, buffer: Buffer.from("old") });
    async function* broken() {
      yield Buffer.from("partial");
      throw Error("stream failure");
    }
    await expect(persistArtifact(manager, artifact, broken())).rejects.toThrow(
      "stream failure",
    );
    expect((await readArtifact(manager, "asset"))?.buffer?.toString()).toBe(
      "old",
    );
    async function* wrong() {
      yield "text" as unknown as Uint8Array;
    }
    await expect(persistArtifact(manager, artifact, wrong())).rejects.toThrow(
      "yield bytes",
    );
    await expect(
      collect(readArtifactStream(manager, "missing")),
    ).rejects.toThrow("not found");
    expect(await readArtifact(manager, "missing")).toBeNull();
    const manifest = (await manager.getArtifact("asset")) as any;
    await manager.deleteArtifact(manifest.storage.chunks[0]);
    await expect(collect(readArtifactStream(manager, "asset"))).rejects.toThrow(
      "is missing",
    );
  } finally {
    await manager.deleteDatabase();
  }
});
it("reads path-only and legacy inline artifacts and removes replaced chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "testfn-artifact-"));
  const manager = new IndexedDbManager({ dbName: crypto.randomUUID() });
  await manager.open();
  try {
    const path = join(directory, "log");
    await writeFile(path, "file payload");
    const artifact = {
      id: "asset",
      runId: "run",
      testId: "test",
      type: "log" as const,
      path,
    };
    await persistArtifact(manager, { ...artifact, buffer: Buffer.from("old") });
    const previous = (await manager.getArtifact("asset")) as any;
    await persistArtifact(manager, artifact);
    expect(await manager.getArtifact(previous.storage.chunks[0])).toBeNull();
    expect(
      (await collect(readArtifactStream(manager, "asset"))).toString(),
    ).toBe("file payload");
    await manager.putArtifact({ ...artifact, buffer: Buffer.from("legacy") });
    expect(
      (await collect(readArtifactStream(manager, "asset"))).toString(),
    ).toBe("legacy");
    await manager.putResult("run", {
      id: "test",
      status: "passed",
      duration: 1,
    });
    await manager.close();
    await expect(manager.getRun("run")).rejects.toThrow("not open");
    await manager.open();
    await manager.open();
    await expect(
      manager.putRun({
        id: "invalid",
        timestamp: 1,
        results: [() => {}],
      } as any),
    ).rejects.toThrow();
    expect(await manager.getRun("invalid")).toBeNull();
  } finally {
    await manager.deleteDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
it("Node reporter distinguishes suites, skipped cases, failure details and output", async () => {
  const events = [
    { type: "test:start", data: {} },
    { type: "test:stdout", data: { message: "out" } },
    { type: "test:stderr", data: { message: "err" } },
    { type: "test:pass", data: { details: { type: "suite" } } },
    { type: "test:pass", data: { name: "pass", details: { duration_ms: 1 } } },
    { type: "test:pass", data: { name: "skip", skip: true } },
    {
      type: "test:fail",
      data: {
        name: "fail",
        details: { error: { message: "assertion", stack: "trace" } },
      },
    },
  ];
  async function* source() {
    yield* events;
  }
  const output = [];
  for await (const line of nodeReporter(source()))
    output.push(JSON.parse(line));
  expect(output).toHaveLength(5);
  expect(output.slice(0, 2).map((x) => x.stream)).toEqual(["stdout", "stderr"]);
  expect(output.slice(2).map((x) => x.status)).toEqual([
    "passed",
    "skipped",
    "failed",
  ]);
  expect(output[4].error.message).toBe("assertion");
});
