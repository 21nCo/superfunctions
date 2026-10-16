import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  wrapWithSchema,
  type Adapter,
  type TableSchema,
} from "@superfunctions/db";
import type { TestRun, TestResult, Artifact } from "../types.js";
export type StoredArtifact = Artifact & {
  id: string;
  runId: string;
  testId: string;
};
export interface StorageBackend {
  open(): Promise<void>;
  close(): Promise<void>;
  putRun(run: TestRun): Promise<void>;
  getRun(id: string): Promise<TestRun | null>;
  getRecentRuns(limit: number): Promise<TestRun[]>;
  getTestHistory(testId: string, limit: number): Promise<TestResult[]>;
  putArtifact(artifact: StoredArtifact): Promise<void>;
  getArtifact(id: string): Promise<Artifact | null>;
  deleteArtifact(id: string): Promise<void>;
  cleanup(days: number): Promise<void>;
}
type Wire = null | boolean | number | string | [string, unknown];
export function encode(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): Wire => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new TypeError("Storage requires finite numbers");
      return item;
    }
    if (item === undefined) return ["undefined", null];
    if (typeof item !== "object")
      throw new TypeError(
        "Storage metadata must contain JSON values, dates, or bytes",
      );
    if (Buffer.isBuffer(item) || item instanceof Uint8Array)
      return ["bytes", Buffer.from(item).toString("base64")];
    if (item instanceof Date) return ["date", item.toISOString()];
    if (seen.has(item))
      throw new TypeError("Circular storage metadata is unsupported");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("Storage metadata must use plain objects");
    seen.add(item);
    try {
      return Array.isArray(item)
        ? ["array", item.map(visit)]
        : [
            "object",
            Object.entries(item).map(([key, value]) => [key, visit(value)]),
          ];
    } finally {
      seen.delete(item);
    }
  };
  return JSON.stringify({ format: "testfn-json-v1", value: visit(value) });
}
export function decode<T>(text: string): T {
  const parsed = JSON.parse(text);
  if (parsed?.format !== "testfn-json-v1") return parsed as T;
  const visit = (wire: Wire): unknown => {
    if (!Array.isArray(wire)) return wire;
    const [kind, value] = wire;
    if (kind === "undefined") return undefined;
    if (kind === "bytes") return Buffer.from(value as string, "base64");
    if (kind === "date") return new Date(value as string);
    if (kind === "array") return (value as Wire[]).map(visit);
    if (kind === "object")
      return Object.fromEntries(
        (value as [string, Wire][]).map(([key, item]) => [key, visit(item)]),
      );
    throw new Error("Invalid stored value");
  };
  return visit(parsed.value) as T;
}
const digest = (id: string) => createHash("sha256").update(id).digest("hex");
export class FileBackend implements StorageBackend {
  private opened = false;
  constructor(private directory: string) {
    this.directory = resolve(directory);
  }
  async open() {
    await mkdir(this.directory, { recursive: true });
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  private path(kind: string, id: string) {
    if (!this.opened) throw Error("Storage is not open");
    return join(this.directory, `${kind}-${digest(id)}.json`);
  }
  private async put(kind: string, id: string, value: unknown) {
    const path = this.path(kind, id),
      temp = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, encode(value));
      await rename(temp, path);
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  private async get<T>(kind: string, id: string): Promise<T | null> {
    try {
      return decode<T>(await readFile(this.path(kind, id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async putRun(run: TestRun) {
    await this.put("run", run.id, run);
  }
  async getRun(id: string) {
    return this.get<TestRun>("run", id);
  }
  async getRecentRuns(limit: number) {
    this.path("run", "");
    const files = await readdir(this.directory);
    const runs = await Promise.all(
      files
        .filter((file) => /^run-[a-f0-9]{64}\.json$/.test(file))
        .map(async (file) =>
          decode<TestRun>(await readFile(join(this.directory, file), "utf8")),
        ),
    );
    return runs
      .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
  async getTestHistory(testId: string, limit: number) {
    return (await this.getRecentRuns(Infinity))
      .flatMap((run) => run.results.filter((result) => result.id === testId))
      .slice(0, limit);
  }
  async putArtifact(artifact: StoredArtifact) {
    await this.put("artifact", artifact.id, artifact);
  }
  async getArtifact(id: string) {
    return this.get<StoredArtifact>("artifact", id);
  }
  async deleteArtifact(id: string) {
    await unlink(this.path("artifact", id)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async cleanup(days: number) {
    const old = (await this.getRecentRuns(Infinity)).filter(
      (run) => run.timestamp < Date.now() - days * 86400000,
    );
    const ids = new Set(old.map((run) => run.id));
    for (const run of old) await unlink(this.path("run", run.id));
    for (const file of await readdir(this.directory)) {
      if (!/^artifact-[a-f0-9]{64}\.json$/.test(file)) continue;
      const artifact = decode<StoredArtifact>(
        await readFile(join(this.directory, file), "utf8"),
      );
      if (ids.has(artifact.runId)) await unlink(join(this.directory, file));
    }
  }
}
export function getTestFnSchema(): { version: number; schemas: TableSchema[] } {
  return {
    version: 1,
    schemas: [
      {
        modelName: "testfn_runs",
        fields: {
          id: { type: "string", required: true, unique: true },
          timestamp: { type: "number", required: true },
          data: { type: "string", required: true },
        },
      },
      {
        modelName: "testfn_artifacts",
        fields: {
          id: { type: "string", required: true, unique: true },
          runId: { type: "string", required: true },
          data: { type: "string", required: true },
        },
      },
    ],
  };
}
export class DatabaseBackend implements StorageBackend {
  private db: Adapter;
  constructor(adapter: Adapter) {
    this.db = wrapWithSchema(adapter, getTestFnSchema());
  }
  async open() {
    await this.db.initialize();
  }
  async close() {
    await this.db.close();
  }
  async putRun(run: TestRun) {
    await this.db.upsert({
      model: "testfn_runs",
      where: [{ field: "id", operator: "eq", value: run.id }],
      create: { id: run.id, timestamp: run.timestamp, data: encode(run) },
      update: { timestamp: run.timestamp, data: encode(run) },
    });
  }
  async getRun(id: string) {
    const row = await this.db.findOne<{ data: string }>({
      model: "testfn_runs",
      where: [{ field: "id", operator: "eq", value: id }],
    });
    return row ? decode<TestRun>(row.data) : null;
  }
  async getRecentRuns(limit: number) {
    const rows = await this.db.findMany<{ data: string }>({
      model: "testfn_runs",
      where: [],
      orderBy: [
        { field: "timestamp", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    return rows.map((row) => decode<TestRun>(row.data));
  }
  async getTestHistory(testId: string, limit: number) {
    return (await this.getRecentRuns(Infinity))
      .flatMap((run) => run.results.filter((result) => result.id === testId))
      .slice(0, limit);
  }
  async putArtifact(artifact: StoredArtifact) {
    await this.db.upsert({
      model: "testfn_artifacts",
      where: [{ field: "id", operator: "eq", value: artifact.id }],
      create: {
        id: artifact.id,
        runId: artifact.runId,
        data: encode(artifact),
      },
      update: { runId: artifact.runId, data: encode(artifact) },
    });
  }
  async getArtifact(id: string) {
    const row = await this.db.findOne<{ data: string }>({
      model: "testfn_artifacts",
      where: [{ field: "id", operator: "eq", value: id }],
    });
    return row ? decode<StoredArtifact>(row.data) : null;
  }
  async deleteArtifact(id: string) {
    await this.db.deleteMany({
      model: "testfn_artifacts",
      where: [{ field: "id", operator: "eq", value: id }],
    });
  }
  async cleanup(days: number) {
    const old = await this.db.findMany<{ id: string }>({
      model: "testfn_runs",
      where: [
        {
          field: "timestamp",
          operator: "lt",
          value: Date.now() - days * 86400000,
        },
      ],
    });
    for (const run of old) {
      await this.db.deleteMany({
        model: "testfn_artifacts",
        where: [{ field: "runId", operator: "eq", value: run.id }],
      });
      await this.db.delete({
        model: "testfn_runs",
        where: [{ field: "id", operator: "eq", value: run.id }],
      });
    }
  }
}
