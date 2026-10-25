// The generated TypeScript client against a local fixture HTTP server, driven
// by the shared cross-language vectors in fixtures/vectors.

import { validateClientFailureEvent } from "@apifn/contracts/failure-event";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogOperation, CatalogResponse, OperationCatalog } from "@apifn/contracts";
import { buildFixtureSdk, cleanupTemp, compile, fixtureCatalog, fixtureConfig, FixtureServer, generate, methodFor, okResponse, paramsFor, readJson } from "./helpers.js";

const catalog = fixtureCatalog();
const server = new FixtureServer();
let sdk: any;
/** The generated package's runtime module, for operation specs catalog v1 cannot produce. */
let runtime: any;

beforeAll(async () => {
  await server.start();
  const built = await buildFixtureSdk();
  sdk = built.sdk;
  runtime = await import(pathToFileURL(path.join(built.dir, "dist/runtime.js")).href);
});
afterAll(async () => {
  await server.stop();
  cleanupTemp();
});
beforeEach(() => server.reset());

function client(options: Record<string, unknown> = {}) {
  return new sdk.TasksClient({ baseUrl: server.baseUrl, ...options });
}

const META = {
  apiId: "example.tasks",
  apiVersion: "2026-10-01",
  catalogDigest: `sha256:${"0".repeat(64)}`,
  releaseId: "rel_test",
  target: "typescript",
  packageName: "@example/tasks-sdk",
  packageVersion: "1.0.0",
  defaultBaseUrl: null,
  defaultTimeoutMs: 2_000,
  defaultRetry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
};

/** A runtime operation spec; `retry: "idempotent"` stands for a write a future catalog declares idempotent. */
function operationSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: "files.put",
    name: "putFile",
    method: "PUT",
    path: "/files",
    parameters: [],
    body: { mediaType: "application/octet-stream", kind: "binary", required: true },
    accept: ["application/json"],
    success: ["json"],
    errors: [],
    security: [],
    retry: "idempotent",
    ...overrides,
  };
}

function directRuntime(options: Record<string, unknown> = {}) {
  return new runtime.ApiRuntime(META, { baseUrl: server.baseUrl, ...options });
}

/** A fetch that never settles and ignores its signal, as a misbehaving custom transport might. */
const stuckFetch = () => new Promise<Response>(() => undefined);

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
  const vectors = readJson("vectors/auth.json");
  for (const vector of vectors.cases) {
    it(vector.name, async () => {
      server.reset([okResponse(catalog, vector.operation)]);
      const outcome = await call(client({ credentials: vector.credentials }), vector);
      expect(outcome.error).toBeUndefined();
      expectRequest(vector, vector.expect);
    });
  }
  for (const vector of vectors.rejected) {
    it(`rejects ${vector.name} before sending`, async () => {
      const outcome = await call(client({ credentials: vector.credentials }), vector);
      expect(outcome.error).toBeInstanceOf(sdk.ApiError);
      expect(outcome.error.kind).toBe(vector.kind);
      expect(server.requests).toHaveLength(0);
    });
  }

  it("resolves an awaited or async-returned client to itself and serializes it, sending nothing", async () => {
    const target = client();
    expect(await Promise.resolve(target)).toBe(target);
    expect(await (async () => target)()).toBe(target);
    expect(JSON.stringify(target)).toBe("{}");
    expect(server.requests).toHaveLength(0);
  });

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
      if ("binaryResult" in vector.expect) {
        expect(outcome.error).toBeUndefined();
        expect(outcome.result).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(outcome.result as Uint8Array).toString("base64")).toBe(vector.expect.binaryResult);
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

  it("never retries a write under catalog v1, whatever its method or body", async () => {
    server.reset([{ status: 503 }, { status: 200, headers: { "content-type": "application/json" }, body: '{"size":2}' }]);
    const error = await client()
      .uploadAttachment({ projectId: "p", taskId: "t", body: new Uint8Array([1, 2]) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiHttpError);
    expect(server.requests).toHaveLength(1);
  });

  it("retries a declared-idempotent write within the budget, replaying its byte body", async () => {
    server.reset([{ status: 503 }, { status: 500 }, { status: 503 }, { status: 200 }]);
    const error = await directRuntime()
      .request(operationSpec(), { body: new Uint8Array([1, 2]) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(runtime.ApiHttpError);
    expect(error.attempts).toBe(3);
    expect(server.requests.map((request) => [...request.body])).toEqual([[1, 2], [1, 2], [1, 2]]);
    server.reset([{ status: 504 }, { status: 200, headers: { "content-type": "application/json" }, body: '{"size":2}' }]);
    await expect(directRuntime().request(operationSpec(), { body: new Uint8Array([1, 2]) })).resolves.toEqual({ size: 2 });
    expect(server.requests).toHaveLength(2);
  });

  it("never retries a stream body, even for a declared-idempotent write", async () => {
    server.reset([{ status: 503 }, { status: 200, headers: { "content-type": "application/json" }, body: "{}" }]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const error = await directRuntime()
      .request(operationSpec(), { body })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(runtime.ApiHttpError);
    expect(server.requests).toHaveLength(1);
    expect([...server.requests[0].body]).toEqual([1, 2]);
  });

  it("fails a request fetch cannot build as invalid input, without sending or retrying it", async () => {
    let calls = 0;
    const fetch = async () => (calls++, new Response("{}"));
    for (const spec of [operationSpec({ method: "TRACE", body: null, retry: "read" }), operationSpec({ method: "GET", body: { mediaType: "application/json", kind: "json", required: true }, retry: "read" })]) {
      const error = await directRuntime({ fetch })
        .request(spec, { body: { a: 1 } })
        .catch((caught: unknown) => caught);
      expect(error.kind, spec.method).toBe("validation");
      expect(error.attempts).toBe(0);
    }
    expect(calls).toBe(0);
  });

  it("fails a JSON body JSON.stringify rejects as invalid input, observed as validation, without sending it", async () => {
    const circular: Record<string, unknown> = { title: "t" };
    circular.self = circular;
    const bodies = { bigint: { title: "t", estimate: 10n }, circular, "a throwing toJSON": { title: "t", toJSON: () => { throw new Error("no JSON"); } } };
    const events: any[] = [];
    const target = client({ onFailure: (event: unknown) => events.push(event) });
    for (const [name, body] of Object.entries(bodies)) {
      const error = await target.createTask({ projectId: "p", body }).catch((caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(sdk.ApiError);
      expect([error.kind, error.attempts], name).toEqual(["validation", 0]);
      expect(error.message, name).toMatch(/^Parameter body must be JSON-serializable: /);
    }
    expect(server.requests).toHaveLength(0);
    expect(events.map((event) => [event.failure.kind, event.failure.retryable])).toEqual([
      ["validation", false],
      ["validation", false],
      ["validation", false],
    ]);
    for (const event of events) expect(validateClientFailureEvent(event).ok).toBe(true);
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

  it("does not send a call whose signal is already aborted, or resolve its credentials", async () => {
    let resolved = 0;
    const error = await client({ credentials: { apiKeyQuery: () => (resolved++, "k") } })
      .getTask({ projectId: "p", taskId: "t" }, { signal: AbortSignal.abort() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiAbortError);
    expect(resolved).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it("aborts and times out while a credential provider never settles", async () => {
    const credentials = { apiKeyQuery: () => new Promise<string>(() => undefined) };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const aborted = await client({ credentials })
      .getTask({ projectId: "p", taskId: "t" }, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(aborted).toBeInstanceOf(sdk.ApiAbortError);
    const timedOut = await client({ credentials, timeoutMs: 50 })
      .getTask({ projectId: "p", taskId: "t" })
      .catch((caught: unknown) => caught);
    expect(timedOut).toBeInstanceOf(sdk.ApiTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(server.requests).toHaveLength(0);
  });

  it("aborts and times out a custom fetch that ignores its signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const aborted = await client({ fetch: stuckFetch })
      .getTask({ projectId: "p", taskId: "t" }, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(aborted).toBeInstanceOf(sdk.ApiAbortError);
    expect(aborted.attempts).toBe(1);
    const timedOut = await client({ fetch: stuckFetch, timeoutMs: 50, retry: { maxAttempts: 2 } })
      .getTask({ projectId: "p", taskId: "t" })
      .catch((caught: unknown) => caught);
    expect(timedOut).toBeInstanceOf(sdk.ApiTimeoutError);
    expect(timedOut.attempts).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("times out a response body that never ends", async () => {
    const fetch = async () =>
      new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) }), { status: 200, headers: { "content-type": "application/json" } });
    const started = Date.now();
    const error = await client({ fetch, timeoutMs: 50, retry: { maxAttempts: 1 } })
      .getTask({ projectId: "p", taskId: "t" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /** A body that yields 1 KiB every 20 ms for as long as it is read, and records being cancelled. */
  function trickle() {
    const state = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          state.pulls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!state.cancelled) controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    return { state, response: new Response(body, { status: 200, headers: { "content-type": "application/json" } }) };
  }

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const ending of ["timeout", "abort"] as const) {
    it(`stops reading a response body on ${ending}`, async () => {
      const { state, response } = trickle();
      const controller = new AbortController();
      if (ending === "abort") setTimeout(() => controller.abort(), 60);
      const error = await client({ fetch: async () => response, timeoutMs: ending === "timeout" ? 60 : 2_000, retry: { maxAttempts: 1 } })
        .getTask({ projectId: "p", taskId: "t" }, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ending === "timeout" ? sdk.ApiTimeoutError : sdk.ApiAbortError);
      await settle(30);
      expect(state.cancelled).toBe(true);
      const pulls = state.pulls;
      await settle(100);
      expect(state.pulls).toBe(pulls);
    });
  }

  it("cancels the body of a response that arrives after the attempt gave up", async () => {
    const { state, response } = trickle();
    const fetch = () => settle(80).then(() => response);
    const error = await client({ fetch, timeoutMs: 30, retry: { maxAttempts: 1 } })
      .getTask({ projectId: "p", taskId: "t" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk.ApiTimeoutError);
    await settle(100);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(1);
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

  it("trims long runs of trailing slashes from the base URL in linear time, keeping the host and prefix", async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => (urls.push(url), new Response("ok", { headers: { "content-type": "text/plain" } }));
    const slashes = "/".repeat(64 * 1024);
    const started = performance.now();
    await new sdk.TasksClient({ fetch, baseUrl: `https://consumer.example.test/api${slashes}` }).getHealth();
    await new sdk.TasksClient({ fetch, baseUrl: `https://consumer.example.test${slashes}api${slashes}` }).getHealth();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(urls).toEqual(["https://consumer.example.test/api/health", `https://consumer.example.test${slashes}api/health`]);
  });

  it("rejects base URLs with user info, queries, fragments or other schemes", () => {
    for (const baseUrl of ["https://u:p@api.example.test", "https://api.example.test/v1?x=1", "https://api.example.test/#f", "ftp://api.example.test", "/relative"]) {
      expect(() => client({ baseUrl }), baseUrl).toThrow(RangeError);
    }
  });
});

describe("failure observation", () => {
  it("gives events distinct valid IDs without Web Crypto, and never uses Math.random", async () => {
    const events: any[] = [];
    const target = client({ onFailure: (event: unknown) => events.push(event) });
    vi.stubGlobal("crypto", undefined);
    const random = vi.spyOn(Math, "random");
    try {
      await target.getTask({ projectId: "", taskId: "t" }).catch(() => undefined);
      await target.getTask({ projectId: "", taskId: "t" }).catch(() => undefined);
    } finally {
      vi.unstubAllGlobals();
      random.mockRestore();
    }
    expect(random).not.toHaveBeenCalled();
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    for (const event of events) expect(validateClientFailureEvent(event).ok).toBe(true);
  });

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
    server.reset([{ status: 404, headers: { "content-type": "application/problem+json" }, body: '{"title":"x","status":404}' }]);
    let observed = 0;
    const rejecting = client({ onFailure: () => (observed++, Promise.reject(new Error("async observer failed"))) });
    const rejected = await rejecting.getTask({ projectId: "p", taskId: "t" }).catch((caught: unknown) => caught);
    expect(observed).toBe(1);
    expect(rejected).toBeInstanceOf(sdk.ApiHttpError);
    expect(rejected.status).toBe(404);
    // A rejection the hook returns is handled: vitest fails the run on an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("handles rejections of cross-realm promises and thenables a hook returns", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const results: Array<[string, () => unknown]> = [
        ["a rejected promise from another realm", () => vm.runInNewContext('Promise.reject(new Error("cross-realm observer failed"))')],
        ["a rejecting thenable", () => ({ then: (_resolve: unknown, reject: (reason: unknown) => void) => reject(new Error("thenable observer failed")) })],
        ["a thenable whose then throws", () => ({ then: () => { throw new Error("then failed"); } })],
        ["a throwing then getter", () => Object.defineProperty({}, "then", { get: () => { throw new Error("then getter failed"); } })],
      ];
      for (const [name, result] of results) {
        server.reset([{ status: 404, headers: { "content-type": "application/problem+json" }, body: '{"title":"x","status":404}' }]);
        let observed = 0;
        const target = client({ onFailure: () => (observed++, result()) });
        const error = await target.getTask({ projectId: "p", taskId: "t" }).catch((caught: unknown) => caught);
        expect(observed, name).toBe(1);
        expect(error, name).toBeInstanceOf(sdk.ApiHttpError);
        expect(error.status, name).toBe(404);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("HEAD operations", () => {
  const pdf: CatalogResponse["contents"] = [{ mediaType: "application/pdf", schema: null, encoding: {} }];

  /**
   * HEAD clones of tasks.delete: one documents 404 and a 5XX range, one only `default`, all with bodies;
   * three document a success, exact or a range, only as application/pdf, which the client cannot decode,
   * two of them with a problem+json error too.
   */
  function headCatalog(): OperationCatalog {
    const catalog: OperationCatalog = fixtureCatalog();
    const del = catalog.operations.find((operation) => operation.id === "tasks.delete");
    const problem = del?.responses.find((response) => response.status === "404")?.contents;
    if (!del || !problem) throw new Error("the fixture catalog has no tasks.delete documenting 404");
    const clone = (id: string, name: string, responses: CatalogResponse[]): CatalogOperation => ({ ...structuredClone(del), id, name, openapiOperationId: name, method: "head", deprecation: { deprecated: false, message: null, replacement: null, since: null }, responses });
    const notFound: CatalogResponse = { status: "404", kind: "error", description: "Problem", contents: problem };
    catalog.operations.push(
      clone("tasks.exists", "taskExists", [del.responses[0]!, notFound, { status: "5XX", kind: "error", description: "Problem", contents: problem }]),
      clone("tasks.probe", "probeTask", [del.responses[0]!, { status: "default", kind: "default", description: "Problem", contents: problem }]),
      clone("tasks.document", "taskDocument", [{ status: "200", kind: "success", description: "The document's headers", contents: pdf }, notFound]),
      clone("tasks.any", "anyTask", [{ status: "2XX", kind: "success", description: "The document's headers", contents: pdf }]),
      clone("tasks.headers", "taskHeaders", [
        { status: "2XX", kind: "success", description: "The document's headers", contents: pdf },
        { status: "default", kind: "default", description: "Problem", contents: problem },
      ])
    );
    catalog.operations.sort((a, b) => (a.id < b.id ? -1 : 1));
    return catalog;
  }

  type HttpError = { status: number; declared: boolean; body: unknown };

  it("declares every documented error status, which never has a body", async () => {
    const { dir, sdk: head } = await buildFixtureSdk(fixtureConfig(), headCatalog());
    const target = new head.TasksClient({ baseUrl: server.baseUrl, credentials: { bearerAuth: "t" }, retry: { maxAttempts: 1 } });
    const failure = async (call: () => Promise<unknown>, status: number) => {
      server.reset([{ status, headers: { "content-type": "application/problem+json" }, body: '{"title":"x"}' }]);
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(head.ApiHttpError);
      expect(server.requests.map((request) => request.method)).toEqual(["HEAD"]);
      const { status: received, declared, body } = error as HttpError;
      return { status: received, declared, body };
    };
    const exists = () => target.taskExists({ projectId: "p", taskId: "t" });
    expect(await failure(exists, 404)).toEqual({ status: 404, declared: true, body: undefined });
    expect(await failure(exists, 503)).toEqual({ status: 503, declared: true, body: undefined });
    expect(await failure(exists, 409)).toEqual({ status: 409, declared: false, body: undefined });
    expect(await failure(() => target.probeTask({ projectId: "p", taskId: "t" }), 409)).toEqual({ status: 409, declared: true, body: undefined });
    expect(await failure(() => target.taskDocument({ projectId: "p", taskId: "t" }), 404)).toEqual({ status: 404, declared: true, body: undefined });

    writeFileSync(
      path.join(dir, "src/custom/head-types.ts"),
      `import { isOperationError } from "../index.js";
export function bodies(error: unknown): undefined {
  if (isOperationError(error, "tasks.exists") && error.declared) {
    const body: undefined = error.body;
    return body;
  }
  if (isOperationError(error, "tasks.probe") && error.declared) {
    // @ts-expect-error a HEAD error never has a body to read
    return error.body.title;
  }
  return undefined;
}
`
    );
    expect(compile(dir)).toEqual([]);
  });

  it("includes a success documented only in media types the client cannot decode, which resolves to no content", async () => {
    const catalog = headCatalog();
    const generated = generate(catalog, fixtureConfig());
    expect(generated.ok).toBe(true);
    expect(generated.diagnostics.filter((diagnostic) => /tasks\.(document|any)|application\/pdf/.test(JSON.stringify(diagnostic)))).toEqual([]);
    expect(generated.manifest?.operations.included.map((operation) => operation.id)).toEqual(expect.arrayContaining(["tasks.any", "tasks.document"]));
    expect(generated.manifest?.operations.excluded.filter((operation) => operation.id.startsWith("tasks."))).toEqual([]);

    const { dir, sdk: head } = await buildFixtureSdk(fixtureConfig(), catalog);
    const target = new head.TasksClient({ baseUrl: server.baseUrl, credentials: { bearerAuth: "t" }, retry: { maxAttempts: 1 } });
    const calls = [
      { call: () => target.taskDocument({ projectId: "p", taskId: "t" }), status: 200 },
      { call: () => target.anyTask({ projectId: "p", taskId: "t" }), status: 206 },
    ];
    for (const { call, status } of calls) {
      server.reset([{ status, headers: { "content-type": "application/pdf", "content-length": "1024" } }]);
      expect(await call()).toBeUndefined();
      expect(server.requests.map((request) => request.method)).toEqual(["HEAD"]);
    }

    writeFileSync(
      path.join(dir, "src/custom/head-success.ts"),
      `import type { TasksClient } from "../index.js";
export async function results(client: TasksClient): Promise<undefined> {
  const document: undefined = await client.taskDocument({ projectId: "p", taskId: "t" });
  const any: undefined = await client.anyTask({ projectId: "p", taskId: "t" });
  return document ?? any;
}
`
    );
    expect(compile(dir)).toEqual([]);
  });
  it("accepts every media type a HEAD operation documents, so a negotiating server serves the representation", async () => {
    // A server that honours Accept: it answers 406 unless Accept admits application/pdf, the document's only representation.
    const accepts: Array<string | undefined> = [];
    const negotiating = createServer((request, response) => {
      const accept = request.headers.accept;
      accepts.push(accept);
      const ranges = (accept ?? "*/*").split(",").map((range) => range.split(";")[0]!.trim().toLowerCase());
      const admits = ranges.some((range) => range === "*/*" || range === "application/*" || range === "application/pdf");
      response.writeHead(admits ? 200 : 406, admits ? { "content-type": "application/pdf", "content-length": "1024" } : { "content-type": "application/problem+json" });
      response.end();
    });
    await new Promise<void>((resolve) => negotiating.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = negotiating.address() as AddressInfo;
      const { sdk: head } = await buildFixtureSdk(fixtureConfig(), headCatalog());
      const target = new head.TasksClient({ baseUrl: `http://127.0.0.1:${port}/v1`, credentials: { bearerAuth: "t" }, retry: { maxAttempts: 1 } });
      const params = { projectId: "p", taskId: "t" };
      // An exact 200 with a 404, a 2XX range alone and a 2XX range with `default`.
      expect(await target.taskDocument(params)).toBeUndefined();
      expect(await target.anyTask(params)).toBeUndefined();
      expect(await target.taskHeaders(params)).toBeUndefined();
      expect(accepts).toEqual(["application/pdf, application/problem+json", "application/pdf", "application/pdf, application/problem+json"]);
    } finally {
      await new Promise<void>((resolve) => negotiating.close(() => resolve()));
    }
  });
});

describe("statuses that never have content", () => {
  it("types and matches a 204, 205 or 304 as no content whatever content it documents", async () => {
    // GET clones of tasks.get whose 204 or 304 documents JSON content; the response has none.
    const catalog: OperationCatalog = fixtureCatalog();
    const get = catalog.operations.find((operation) => operation.id === "tasks.get");
    const json = get?.responses.find((response) => response.status === "200")?.contents;
    if (!get || !json) throw new Error("the fixture catalog has no tasks.get documenting 200");
    const clone = (id: string, name: string, responses: CatalogResponse[]): CatalogOperation => ({ ...structuredClone(get), id, name, openapiOperationId: name, path: `${get.path}/${name}`, responses });
    catalog.operations.push(
      clone("tasks.touch", "touchTask", [{ status: "204", kind: "success", description: "Touched", contents: json }]),
      clone("tasks.cached", "cachedTask", [get.responses.find((response) => response.status === "200")!, { status: "304", kind: "success", description: "Not modified", contents: json }])
    );
    catalog.operations.sort((a, b) => (a.id < b.id ? -1 : 1));
    const { dir, sdk: built } = await buildFixtureSdk(fixtureConfig(), catalog);
    const target = new built.TasksClient({ baseUrl: server.baseUrl, credentials: { bearerAuth: "t" }, retry: { maxAttempts: 1 } });
    const params = { projectId: "p", taskId: "t" };

    server.reset([{ status: 204, headers: { "content-type": "application/json" } }]);
    expect(await target.touchTask(params)).toBeUndefined();
    server.reset([{ status: 304, headers: { "content-type": "application/json" } }]);
    const error = await target.cachedTask(params).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(built.ApiHttpError);
    const { status, declared, body } = error as { status: number; declared: boolean; body: unknown };
    expect({ status, declared, body }).toEqual({ status: 304, declared: true, body: undefined });

    writeFileSync(
      path.join(dir, "src/custom/bodyless-statuses.ts"),
      `import type { TasksClient } from "../index.js";
export async function touched(client: TasksClient): Promise<undefined> {
  return client.touchTask({ projectId: "p", taskId: "t" });
}
`
    );
    expect(compile(dir)).toEqual([]);
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
