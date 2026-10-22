// The generated TypeScript client against a local fixture HTTP server, driven
// by the shared cross-language vectors in fixtures/vectors.

import { validateClientFailureEvent } from "@apifn/contracts/failure-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFixtureSdk, cleanupTemp, fixtureCatalog, fixtureConfig, FixtureServer, methodFor, okResponse, paramsFor, readJson } from "./helpers.js";

const catalog = fixtureCatalog();
const server = new FixtureServer();
let sdk: any;

beforeAll(async () => {
  await server.start();
  ({ sdk } = await buildFixtureSdk());
});
afterAll(async () => {
  await server.stop();
  cleanupTemp();
});
beforeEach(() => server.reset());

function client(options: Record<string, unknown> = {}) {
  return new sdk.TasksClient({ baseUrl: server.baseUrl, ...options });
}

async function call(target: any, vector: any, options?: Record<string, unknown>): Promise<{ result?: unknown; error?: any }> {
  try {
    return { result: await target[methodFor(catalog, vector.operation)](paramsFor(catalog, vector.operation, vector), options) };
  } catch (error) {
    return { error };
  }
}

function expectRequest(vector: any, expected: any) {
  expect(server.requests).toHaveLength(1);
  const [request] = server.requests;
  if (expected.method) expect(request.method, vector.name).toBe(expected.method);
  if (expected.path) expect(request.path, vector.name).toBe(expected.path);
  expect(request.query, vector.name).toBe(expected.query);
  for (const [name, value] of Object.entries(expected.headers ?? {})) expect(request.headers[name], `${vector.name}: ${name}`).toBe(value);
  for (const name of expected.absentHeaders ?? []) expect(request.headers[name], `${vector.name}: ${name}`).toBeUndefined();
  if ("body" in expected) expect(JSON.parse(request.body.toString("utf8")), vector.name).toEqual(expected.body);
  if ("bodyText" in expected) expect(request.body.toString("utf8"), vector.name).toBe(expected.bodyText);
  if ("bodyBytes" in expected) expect([...request.body], vector.name).toEqual(expected.bodyBytes);
}

describe("shared serialization vectors", () => {
  const vectors = readJson("vectors/serialization.json");
  for (const vector of vectors.cases) {
    it(vector.name, async () => {
      server.reset([okResponse(catalog, vector.operation)]);
      const outcome = await call(client(), vector);
      expect(outcome.error, vector.name).toBeUndefined();
      expectRequest(vector, vector.expect);
    });
  }
  for (const vector of vectors.rejected) {
    it(`rejects ${vector.name} before sending`, async () => {
      const outcome = await call(client(), vector);
      expect(outcome.error).toBeInstanceOf(sdk.ApiError);
      expect(outcome.error.kind).toBe(vector.kind);
      expect(server.requests).toHaveLength(0);
    });
  }
});

describe("shared auth vectors", () => {
  for (const vector of readJson("vectors/auth.json").cases) {
    it(vector.name, async () => {
      server.reset([okResponse(catalog, vector.operation)]);
      const outcome = await call(client({ credentials: vector.credentials }), vector);
      expect(outcome.error).toBeUndefined();
      expectRequest(vector, vector.expect);
    });
  }

  it("resolves credential functions per request", async () => {
    let calls = 0;
    const target = client({ credentials: { bearerAuth: async () => `token-${++calls}` } });
    await target.replaceTask({ projectId: "p", taskId: "t", body: { title: "x" } });
    await target.replaceTask({ projectId: "p", taskId: "t", body: { title: "x" } });
    expect(server.requests.map((request) => request.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
});

describe("shared error vectors", () => {
  for (const vector of readJson("vectors/errors.json").cases) {
    it(vector.name, async () => {
      server.reset([vector.response]);
      const outcome = await call(client({ retry: { maxAttempts: 1 } }), vector);
      expect(server.requests).toHaveLength(1);
      if ("result" in vector.expect) {
        expect(outcome.error).toBeUndefined();
        expect(outcome.result ?? null).toEqual(vector.expect.result);
        return;
      }
      const { error } = outcome;
      expect(error).toBeInstanceOf(sdk.ApiError);
      expect(error.kind).toBe(vector.expect.error.kind);
      expect(error.operationId).toBe(vector.operation);
      if (vector.expect.error.kind !== "http") return;
      expect(error).toBeInstanceOf(sdk.ApiHttpError);
      expect(error.status).toBe(vector.expect.error.status);
      expect(error.declared).toBe(vector.expect.error.declared);
      expect(error.body ?? null).toEqual(vector.expect.error.body);
      expect(sdk.isOperationError(error, vector.operation)).toBe(true);
      expect(sdk.isOperationError(error, "tasks.list" === vector.operation ? "tasks.get" : "tasks.list")).toBe(false);
    });
  }
});

describe("shared retry vectors", () => {
  for (const vector of readJson("vectors/retry.json").cases) {
    it(vector.name, async () => {
      server.reset(vector.responses.map((response: any) => ({ ...response, headers: { "content-type": "application/json", ...response.headers }, body: "{}" })));
      const outcome = await call(client({ credentials: { bearerAuth: "t", apiKeyQuery: "k" } }), vector);
      expect(server.requests).toHaveLength(vector.expect.attempts);
      if (vector.expect.outcome === "success") {
        expect(outcome.error).toBeUndefined();
        return;
      }
      expect(outcome.error).toBeInstanceOf(sdk.ApiHttpError);
      expect(outcome.error.status).toBe(vector.expect.status);
      expect(outcome.error.attempts).toBe(vector.expect.attempts);
    });
  }

  it("retries a read after a dropped connection", async () => {
    server.reset([{ destroy: true }, { status: 200, headers: { "content-type": "application/json" }, body: "{}" }]);
    await client().getTask({ projectId: "p", taskId: "t" });
    expect(server.requests).toHaveLength(2);
  });

  it("never retries a stream body, even for a declared idempotent write", async () => {
    server.reset([{ status: 503 }, { status: 200, headers: { "content-type": "application/json" }, body: "{}" }]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const error = await client()
      .uploadAttachment({ projectId: "p", taskId: "t", body })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiHttpError);
    expect(server.requests).toHaveLength(1);
    expect([...server.requests[0].body]).toEqual([1, 2]);
  });

  it("retries a replayable byte body for a declared idempotent write", async () => {
    server.reset([{ status: 503 }, { status: 200, headers: { "content-type": "application/json" }, body: '{"size":2}' }]);
    await expect(client().uploadAttachment({ projectId: "p", taskId: "t", body: new Uint8Array([1, 2]) })).resolves.toEqual({ size: 2 });
    expect(server.requests.map((request) => [...request.body])).toEqual([[1, 2], [1, 2]]);
  });

  it("rejects a retry budget outside 1 to 10", () => {
    expect(() => client({ retry: { maxAttempts: 0 } })).toThrow(RangeError);
    expect(() => client({ retry: { maxAttempts: 11 } })).toThrow(RangeError);
    expect(() => client({ retry: { maxAttempts: Infinity } })).toThrow(RangeError);
  });
});

describe("timeouts and cancellation", () => {
  it("times out an attempt and retries a read within the budget", async () => {
    server.reset([{ delayMs: 500 }, { delayMs: 500 }, { delayMs: 500 }]);
    const started = Date.now();
    const error = await client({ timeoutMs: 50 })
      .getTask({ projectId: "p", taskId: "t" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiTimeoutError);
    expect(error.kind).toBe("timeout");
    expect(error.attempts).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not retry a timed-out write", async () => {
    server.reset([{ delayMs: 500 }]);
    const error = await client()
      .createTask({ projectId: "p", body: { title: "x" } }, { timeoutMs: 50 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiTimeoutError);
    expect(server.requests).toHaveLength(1);
  });

  it("aborts an in-flight call through AbortSignal without retrying", async () => {
    server.reset([{ delayMs: 1_000 }]);
    const controller = new AbortController();
    const pending = client().getTask({ projectId: "p", taskId: "t" }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user cancelled")), 30);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiAbortError);
    expect(error.kind).toBe("aborted");
    expect((error.cause as Error).message).toBe("user cancelled");
    expect(server.requests).toHaveLength(1);
  });

  it("aborts during the backoff between attempts", async () => {
    server.reset([{ status: 503 }, { status: 200 }]);
    const controller = new AbortController();
    const events: any[] = [];
    const target = client({ retry: { baseDelayMs: 5_000, maxDelayMs: 5_000 }, onFailure: (event: unknown) => events.push(event) });
    const pending = target.getTask({ projectId: "p", taskId: "t" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toBeInstanceOf(sdk.ApiAbortError);
    expect(server.requests).toHaveLength(1);
    // The earlier retryable 503 does not make the cancellation retryable.
    expect(events.map((event) => event.failure)).toEqual([{ kind: "aborted", retryable: false, attempt: 1 }]);
  });

  it("does not send a call whose signal is already aborted", async () => {
    const error = await client()
      .getTask({ projectId: "p", taskId: "t" }, { signal: AbortSignal.abort() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiAbortError);
    expect(server.requests).toHaveLength(0);
  });
});

describe("host-bound requests", () => {
  it("sends every operation to the configured base URL, never to spec servers", async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    // The generated default base URL comes from the SDK config; the catalog's root and /health servers are ignored.
    expect(catalog.servers[0].url).toBe("https://spec-server.example.test/v1");
    expect(catalog.operations.find((operation: any) => operation.id === "system.health").servers[0].url).toBe("https://status.example.test");
    await new sdk.TasksClient({ fetch }).getHealth();
    expect(urls).toEqual(["https://api.example.test/v1/health"]);
    await new sdk.TasksClient({ fetch, baseUrl: "https://consumer.example.test/api/" }).getHealth();
    expect(urls[1]).toBe("https://consumer.example.test/api/health");
  });

  it("requires baseUrl when the SDK config has none", async () => {
    const config = fixtureConfig();
    delete config.options.baseUrl;
    const { sdk: unbound } = await buildFixtureSdk(config);
    expect(() => new unbound.TasksClient({})).toThrow(/baseUrl is required/);
    const urls: string[] = [];
    await new unbound.TasksClient({ baseUrl: server.baseUrl, fetch: async (url: string) => (urls.push(url), new Response("ok", { headers: { "content-type": "text/plain" } })) }).getHealth();
    expect(urls).toEqual([`${server.baseUrl}/health`]);
  });

  it("rejects base URLs with user info, queries, fragments or other schemes", () => {
    for (const baseUrl of ["https://u:p@api.example.test", "https://api.example.test/v1?x=1", "https://api.example.test/#f", "ftp://api.example.test", "/relative"]) {
      expect(() => client({ baseUrl }), baseUrl).toThrow(RangeError);
    }
  });
});

describe("failure observation", () => {
  it("sends nothing but the API request when no hook is set", async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => (urls.push(url), new Response("", { status: 500 }));
    await expect(new sdk.TasksClient({ fetch, retry: { maxAttempts: 1 } }).getTask({ projectId: "p", taskId: "t" })).rejects.toBeInstanceOf(sdk.ApiHttpError);
    expect(urls).toEqual(["https://api.example.test/v1/projects/p/tasks/t"]);
  });

  it("emits valid apifn.client-failure/v1 events without URLs, values or credentials", async () => {
    const events: any[] = [];
    const target = client({ onFailure: (event: unknown) => events.push(event), credentials: { apiKeyQuery: "secret-key-123" } });
    server.reset([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await target.getTask({ projectId: "project-secret", taskId: "t" }).catch(() => undefined);
    await target.getTask({ projectId: "", taskId: "t" }).catch(() => undefined);
    server.reset([{ delayMs: 500 }]);
    await target.getTask({ projectId: "p", taskId: "t" }, { timeoutMs: 20, retry: { maxAttempts: 1 } }).catch(() => undefined);
    expect(events.map((event) => [event.failure.kind, event.failure.httpStatus, event.failure.attempt, event.failure.retryable])).toEqual([
      ["http", 503, 3, true],
      ["validation", undefined, 1, false],
      ["timeout", undefined, 1, true],
    ]);
    for (const event of events) {
      const validated = validateClientFailureEvent(event);
      expect(validated.ok, JSON.stringify(validated)).toBe(true);
      expect(event.operation).toEqual({ id: "tasks.get", name: "getTask", method: "get", pathTemplate: "/projects/{projectId}/tasks/{taskId}" });
      expect(event.release.sdk).toEqual({ target: "typescript", package: "@example/tasks-sdk", version: "1.0.0" });
      expect(JSON.stringify(event)).not.toMatch(/secret|127\.0\.0\.1/);
    }
  });

  it("never lets a hook change the call's outcome", async () => {
    server.reset([{ status: 404, headers: { "content-type": "application/problem+json" }, body: '{"title":"x","status":404}' }]);
    const throwing = client({
      onFailure: () => {
        throw new Error("observer failed");
      },
    });
    const error = await throwing.getTask({ projectId: "p", taskId: "t" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiHttpError);
    expect(error.status).toBe(404);
    server.reset([{ status: 200, headers: { "content-type": "application/json" }, body: "{}" }]);
    const rejecting = client({ onFailure: () => Promise.reject(new Error("async observer failed")) });
    await expect(rejecting.getTask({ projectId: "p", taskId: "t" })).resolves.toEqual({});
  });
});

describe("inherited property names", () => {
  it("never reads parameter or credential values from Object.prototype", async () => {
    const catalog = fixtureCatalog();
    catalog.securitySchemes.toString = { type: "apiKey", in: "header", name: "X-Proto-Key", description: null };
    const get = catalog.operations.find((operation: any) => operation.id === "tasks.get");
    get.security.alternatives = [[{ scheme: "toString", scopes: [] }]];
    get.parameters.push({ name: "constructor", in: "query", required: false, deprecated: false, style: "form", explode: true, allowReserved: false, description: null, schema: { type: "string" } });
    const { sdk: proto } = await buildFixtureSdk(fixtureConfig(), catalog);
    server.reset([okResponse(catalog, "tasks.get")]);
    await new proto.TasksClient({ baseUrl: server.baseUrl }).getTask({ projectId: "p", taskId: "t" });
    expect(server.requests[0].query).toBe("");
    expect(server.requests[0].headers["x-proto-key"]).toBeUndefined();
    server.reset([okResponse(catalog, "tasks.get")]);
    await new proto.TasksClient({ baseUrl: server.baseUrl, credentials: { toString: "k" } }).getTask({ projectId: "p", taskId: "t", constructor: "c" });
    expect(server.requests[0].query).toBe("constructor=c");
    expect(server.requests[0].headers["x-proto-key"]).toBe("k");
  });
});

describe("custom transport", () => {
  it("uses the injected fetch for every attempt", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method) });
      return seen.length === 1 ? new Response("", { status: 503 }) : new Response('{"items":[]}', { status: 200, headers: { "content-type": "application/json" } });
    };
    const target = new sdk.TasksClient({ fetch, baseUrl: "https://mock.example.test", credentials: { bearerAuth: "t" } });
    await expect(target.listTasks({ projectId: "p" })).resolves.toEqual({ items: [] });
    expect(seen).toEqual([
      { url: "https://mock.example.test/projects/p/tasks", method: "GET" },
      { url: "https://mock.example.test/projects/p/tasks", method: "GET" },
    ]);
    expect(server.requests).toHaveLength(0);
  });

  it("classifies a transport failure as a network error", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await new sdk.TasksClient({ fetch, retry: { maxAttempts: 1 } }).getHealth().catch((caught: unknown) => caught);
    expect(error.kind).toBe("network");
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});
