import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresAdapter } from "../../src/postgres";
import { MeilisearchAdapter } from "../../src/meilisearch";
import { ElasticsearchAdapter } from "../../src/elasticsearch";
import { OpenSearchAdapter } from "../../src/opensearch";
import { createSearchProvider } from "../../../datafn-provider/src/index";

const PG_URL = process.env.SEARCHFN_PG_URL ?? "postgres://searchfn:searchfn_test@localhost:5433/searchfn_test";
const MEILI_URL = process.env.SEARCHFN_MEILI_URL ?? "http://localhost:7700";
const ES_URL = process.env.SEARCHFN_ES_URL ?? "http://localhost:9200";
const OS_URL = process.env.SEARCHFN_OS_URL ?? "http://localhost:9201";

const REQUIRE_MATRIX = process.env.SEARCHFN_REQUIRE_MATRIX === "1";
const REQUIRED_TARGETS = ["postgres", "meilisearch", "elasticsearch", "opensearch", "datafn-provider"];

async function canConnectHttp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function canConnectPostgres(): Promise<boolean> {
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

function handleUnavailable(target: string): boolean {
  if (REQUIRE_MATRIX) {
    throw new Error(`DFQL_INVALID: Integration matrix incomplete (${target} unavailable)`);
  }
  console.warn(`${target} not available, skipping integration target`);
  return true;
}

describe("integration matrix", () => {
  it("declares all required matrix targets", () => {
    expect(REQUIRED_TARGETS).toEqual(["postgres", "meilisearch", "elasticsearch", "opensearch", "datafn-provider"]);
  });

  it("postgres target passes", async () => {
    if (!(await canConnectPostgres())) {
      if (handleUnavailable("postgres")) return;
    }

    const adapter = new PostgresAdapter({ connectionString: PG_URL, queryTimeoutMs: 10_000 });
    await adapter.initialize({ resources: [{ name: "matrix_tasks", searchFields: ["title"] }] });
    await adapter.clear("matrix_tasks");
    await adapter.index({ resource: "matrix_tasks", documents: [{ id: "p1", fields: { title: "incident" } }] });
    const ids = await adapter.search({ resource: "matrix_tasks", query: "incident", limit: 5 });
    expect(ids).toContain("p1");
    await adapter.clear("matrix_tasks");
    await adapter.dispose();
  });

  it("meilisearch target passes", async () => {
    if (!(await canConnectHttp(new URL("/health", MEILI_URL).toString()))) {
      if (handleUnavailable("meilisearch")) return;
    }

    const adapter = new MeilisearchAdapter({ host: MEILI_URL, indexPrefix: "matrix_meili", requestTimeoutMs: 10_000 });
    await adapter.initialize({ resources: [{ name: "matrix_docs", searchFields: ["title"] }] });
    await adapter.clear("matrix_docs");
    await adapter.index({ resource: "matrix_docs", documents: [{ id: "m1", fields: { title: "incident" } }] });
    const ids = await adapter.search({ resource: "matrix_docs", query: "incident", limit: 5 });
    expect(ids).toContain("m1");
    await adapter.clear("matrix_docs");
    await adapter.dispose();
  });

  it("elasticsearch target passes", async () => {
    if (!(await canConnectHttp(ES_URL))) {
      if (handleUnavailable("elasticsearch")) return;
    }

    const adapter = new ElasticsearchAdapter({
      node: ES_URL,
      engine: "elasticsearch",
      indexPrefix: "matrix_es",
      requestTimeoutMs: 10_000,
    });
    await adapter.initialize({ resources: [{ name: "matrix_docs", searchFields: ["title"] }] });
    await adapter.clear("matrix_docs");
    await adapter.index({ resource: "matrix_docs", documents: [{ id: "e1", fields: { title: "incident" } }] });
    const ids = await adapter.search({ resource: "matrix_docs", query: "incident", limit: 5 });
    expect(ids).toContain("e1");
    await adapter.clear("matrix_docs");
    await adapter.dispose();
  });

  it("opensearch target passes", async () => {
    if (!(await canConnectHttp(OS_URL))) {
      if (handleUnavailable("opensearch")) return;
    }

    const adapter = new OpenSearchAdapter({ node: OS_URL, indexPrefix: "matrix_os", requestTimeoutMs: 10_000 });
    await adapter.initialize({ resources: [{ name: "matrix_docs", searchFields: ["title"] }] });
    await adapter.clear("matrix_docs");
    await adapter.index({ resource: "matrix_docs", documents: [{ id: "o1", fields: { title: "incident" } }] });
    const ids = await adapter.search({ resource: "matrix_docs", query: "incident", limit: 5 });
    expect(ids).toContain("o1");
    await adapter.clear("matrix_docs");
    await adapter.dispose();
  });

  it("datafn-provider target passes", async () => {
    if (!(await canConnectPostgres())) {
      if (handleUnavailable("datafn-provider")) return;
    }

    const adapter = new PostgresAdapter({ connectionString: PG_URL, queryTimeoutMs: 10_000 });
    await adapter.initialize({ resources: [{ name: "matrix_provider", searchFields: ["title", "body"] }] });
    await adapter.clear("matrix_provider");

    const provider = createSearchProvider(adapter, {
      resourceFields: {
        matrix_provider: ["title", "body"],
      },
    });

    await provider.updateIndices({
      resource: "matrix_provider",
      records: [{ id: "d1", title: "incident", body: "provider bridge" }] as any,
      operation: "upsert",
    } as any);

    const ids = await provider.search({ resource: "matrix_provider", query: "incident", limit: 5 } as any);
    expect(ids).toContain("d1");

    await provider.dispose();
  });

  it("runs datafn-provider package test suite", () => {
    execSync("npm --prefix ../datafn-provider test", {
      cwd: process.cwd(),
      stdio: "pipe",
      env: process.env,
    });
  }, 120_000);
});
