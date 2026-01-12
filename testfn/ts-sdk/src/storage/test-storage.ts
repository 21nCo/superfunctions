import { IndexedDbManager } from './indexeddb-manager.js';
import type { TestRun, TestResult, Artifact, StorageConfig } from '../types.js';

export class TestStorage {
  private manager: IndexedDbManager;
  private retentionDays: number;

  constructor(config: StorageConfig) {
    const dbName = config.dbName ?? 'testfn-storage';
    this.manager = new IndexedDbManager({ dbName, version: 1 });
    this.retentionDays = config.retentionDays ?? 30;
  }

  async open(): Promise<void> {
    await this.manager.open();
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  async saveRun(run: TestRun): Promise<void> {
    await this.manager.putRun(run);
    
    for (const result of run.results) {
      await this.manager.putResult(run.id, result);
      
      if (result.artifacts) {
        for (const artifact of result.artifacts) {
          await this.manager.putArtifact({
            ...artifact,
            id: `${run.id}-${result.id}-${artifact.type}`,
            runId: run.id,
            testId: result.id
          });
        }
      }
    }
  }

  async getRun(id: string): Promise<TestRun | null> {
    return this.manager.getRun(id);
  }

  async getRecentRuns(limit: number): Promise<TestRun[]> {
    return this.manager.getRecentRuns(limit);
  }

  async getTestHistory(testId: string, limit: number): Promise<TestResult[]> {
    return this.manager.getTestHistory(testId, limit);
  }

  async saveArtifact(artifact: Artifact & { id: string; runId: string; testId: string }): Promise<string> {
    await this.manager.putArtifact(artifact);
    return artifact.id;
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    return this.manager.getArtifact(id);
  }

  async cleanup(): Promise<void> {
    await this.manager.cleanup(this.retentionDays);
  }
}
