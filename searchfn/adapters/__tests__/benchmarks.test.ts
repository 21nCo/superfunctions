import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MemoryAdapter } from "../src/memory";
import { IndexedDbAdapter } from "../src/indexeddb";
import { PostgresAdapter } from "../src/postgres";
import { BENCHMARK_THRESHOLDS } from "../benchmarks/thresholds";
import { runAdapterBenchmark, validateBenchmarkGate } from "../benchmarks/harness";

const PG_URL =
  process.env.SEARCHFN_PG_URL ?? "postgres://searchfn:searchfn_test@localhost:5433/searchfn_test";

async function postgresAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

describe("benchmark gates", () => {
  it("validates memory benchmark thresholds", async () => {
    const result = await runAdapterBenchmark(
      "memory",
      new MemoryAdapter(),
      BENCHMARK_THRESHOLDS.memory,
      { docsCount: 500, searchIterations: 20 },
    );
    expect(result.metrics.docsPerSec).toBeGreaterThan(0);
    expect(result.metrics.searchP95Ms).toBeGreaterThanOrEqual(0);
    validateBenchmarkGate(result);
  }, 30_000);

  it("validates indexeddb benchmark thresholds", async () => {
    const result = await runAdapterBenchmark(
      "indexeddb",
      new IndexedDbAdapter(),
      BENCHMARK_THRESHOLDS.indexeddb,
      { docsCount: 500, searchIterations: 20 },
    );
    expect(result.metrics.docsPerSec).toBeGreaterThan(0);
    expect(result.metrics.searchP95Ms).toBeGreaterThanOrEqual(0);
    validateBenchmarkGate(result);
  }, 30_000);

  it("validates postgres benchmark thresholds when postgres is available", async () => {
    const available = await postgresAvailable();
    if (!available) {
      console.warn("Postgres not available, skipping postgres benchmark gate");
      return;
    }

    const result = await runAdapterBenchmark(
      "postgres",
      new PostgresAdapter({ connectionString: PG_URL, queryTimeoutMs: 10_000 }),
      BENCHMARK_THRESHOLDS.postgres,
      { docsCount: 500, searchIterations: 20 },
    );
    expect(result.metrics.docsPerSec).toBeGreaterThan(0);
    expect(result.metrics.searchP95Ms).toBeGreaterThanOrEqual(0);
    validateBenchmarkGate(result);
  }, 45_000);
});
