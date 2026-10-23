import { createHash } from "node:crypto";
import {
  persistArtifact,
  readArtifact,
  readArtifactStream,
} from "./artifacts.js";
import { IndexedDbManager } from "./indexeddb-manager.js";
import {
  FileBackend,
  DatabaseBackend,
  type StorageBackend,
} from "./backends.js";
import type { TestRun, TestResult, Artifact, StorageConfig } from "../types.js";
export class TestStorage {
  private manager: StorageBackend;
  private retentionDays: number;
  private writes = 0;
  private cleanupThreshold: number;
  constructor(config: StorageConfig) {
    this.cleanupThreshold = config.cleanupThreshold ?? 100;
    if (!Number.isInteger(this.cleanupThreshold) || this.cleanupThreshold < 0)
      throw new Error("cleanupThreshold must be a nonnegative integer");
    this.retentionDays = config.retentionDays ?? 30;
    if (!Number.isFinite(this.retentionDays) || this.retentionDays < 0)
      throw Error("retentionDays must be nonnegative");
    if (config.type === "indexeddb")
      this.manager = new IndexedDbManager({
        dbName: config.dbName ?? "testfn-storage",
      });
    else if (config.type === "file")
      this.manager = new FileBackend(config.dbName ?? ".testfn-storage");
    else if (config.type === "db") {
      if (!config.adapter)
        throw Error("Database storage requires a shared Adapter");
      this.manager = new DatabaseBackend(config.adapter);
    } else throw Error(`Unsupported storage type: ${config.type}`);
  }
  async open() {
    await this.manager.open();
  }
  async close() {
    await this.manager.close();
  }
  async saveRun(run: TestRun) {
    const artifacts = run.results.flatMap((result) =>
      (result.artifacts ?? []).map((artifact, index) => ({
        ...artifact,
        id: getArtifactId(run.id, result.id, artifact.type, index),
        runId: run.id,
        testId: result.id,
      })),
    );
    for (const artifact of artifacts)
      await persistArtifact(this.manager, artifact);
    const results = run.results.map((result) => ({
      ...result,
      ...(result.artifacts
        ? {
            artifacts: result.artifacts.map(
              ({ buffer: _buffer, ...artifact }) => artifact,
            ),
          }
        : {}),
    }));
    await this.manager.putRun({
      ...run,
      results,
      artifacts: artifacts.map(({ id, testId, type, path }) => ({
        id,
        testId,
        type,
        path,
      })),
    });
    if (this.cleanupThreshold && ++this.writes >= this.cleanupThreshold) {
      await this.cleanup();
      this.writes = 0;
    }
  }

  async getRun(id: string) {
    return this.manager.getRun(id);
  }
  private limit(limit: number) {
    if (!Number.isInteger(limit) || limit < 0)
      throw Error("limit must be a nonnegative integer");
    return limit;
  }
  async getRecentRuns(limit: number): Promise<TestRun[]> {
    this.limit(limit);
    return limit === 0 ? [] : this.manager.getRecentRuns(limit);
  }
  async getTestHistory(testId: string, limit: number): Promise<TestResult[]> {
    this.limit(limit);
    return limit === 0 ? [] : this.manager.getTestHistory(testId, limit);
  }
  async saveArtifact(
    artifact: Artifact & { id: string; runId: string; testId: string },
  ) {
    await persistArtifact(this.manager, artifact);
    return artifact.id;
  }
  async getArtifactInfo(id: string) {
    const artifact = await this.manager.getArtifact(id);
    if (!artifact) return null;
    return {
      type: artifact.type,
      path: artifact.path,
      metadata: artifact.metadata,
    };
  }
  async getArtifact(id: string) {
    return readArtifact(this.manager, id);
  }
  async saveArtifactStream(
    artifact: Artifact & { id: string; runId: string; testId: string },
    source: AsyncIterable<Uint8Array>,
  ) {
    await persistArtifact(this.manager, artifact, source);
    return artifact.id;
  }
  getArtifactStream(id: string) {
    return readArtifactStream(this.manager, id);
  }
  async cleanup(retentionDays = this.retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays < 0)
      throw new Error("retentionDays must be nonnegative");
    await this.manager.cleanup(retentionDays);
  }
}

/** Stable, unambiguous identifier for an artifact associated with a run and test. */
export function getArtifactId(
  runId: string,
  testId: string,
  type: Artifact["type"],
  index = 0,
): string {
  return createHash("sha256")
    .update(JSON.stringify([runId, testId, type, index]))
    .digest("hex");
}
