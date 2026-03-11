import { describe, beforeAll } from "vitest";
import { ElasticsearchAdapter } from "../../src/elasticsearch";
import { OpenSearchAdapter } from "../../src/opensearch";
import { runConformanceSuite } from "./shared";

const ES_URL = process.env.SEARCHFN_ES_URL ?? "http://localhost:9200";
const OPENSEARCH_URL = process.env.SEARCHFN_OS_URL ?? "http://localhost:9201";

let elasticCounter = 0;
let opensearchCounter = 0;
let elasticAvailable = false;
let opensearchAvailable = false;

async function canConnect(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

describe("Elastic-compatible conformance (Elasticsearch)", () => {
  beforeAll(async () => {
    elasticAvailable = await canConnect(ES_URL);
    if (!elasticAvailable) {
      console.warn("Elasticsearch not available, skipping conformance tests");
    }
  });

  runConformanceSuite({
    name: "elastic-compatible",
    persistent: true,
    shouldSkip: () => !elasticAvailable,
    create: () =>
      new ElasticsearchAdapter({
        node: ES_URL,
        engine: "elasticsearch",
        indexPrefix: `conf_es_${++elasticCounter}`,
        requestTimeoutMs: 10_000,
        retry: { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 100 },
      }),
  });
});

describe("Elastic-compatible conformance (OpenSearch)", () => {
  beforeAll(async () => {
    opensearchAvailable = await canConnect(OPENSEARCH_URL);
    if (!opensearchAvailable) {
      console.warn("OpenSearch not available, skipping conformance tests");
    }
  });

  runConformanceSuite({
    name: "elastic-compatible",
    persistent: true,
    shouldSkip: () => !opensearchAvailable,
    create: () =>
      new OpenSearchAdapter({
        node: OPENSEARCH_URL,
        indexPrefix: `conf_os_${++opensearchCounter}`,
        requestTimeoutMs: 10_000,
        retry: { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 100 },
      }),
  });
});
