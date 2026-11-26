import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpFnError, McpFnValidationError, type McpFnRequestExtra } from "../src/index.js";
import { fromOpenAPI, httpExecutor, type OpenApiOperation } from "../src/openapi/index.js";
import { requestExtra } from "./openapi-helpers.js";

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Fixture {
  origin: string;
  received: Received[];
  /** Resolves with each request's `close` once its connection or response is torn down. */
  closed: Array<Promise<{ finished: boolean }>>;
  close(): Promise<void>;
}

type Route = (request: IncomingMessage, response: ServerResponse, received: Received) => void;

async function fixtureApi(route: Route): Promise<Fixture> {
  const received: Received[] = [];
  const closed: Fixture["closed"] = [];
  const server: Server = createServer((request, response) => {
    let finished = false;
    response.on("finish", () => {
      finished = true;
    });
    closed.push(new Promise((resolve) => response.on("close", () => resolve({ finished }))));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      route(request, response, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    closed,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

// Made-up credentials, built at run time and obviously fake.
const operatorToken = ["test", "operator", "token"].join("-");
const rotatedToken = ["test", "rotated", "token"].join("-");
const clientToken = ["test", "client", "token"].join("-");

const objectResponse = {
  "200": {
    description: "OK",
    content: {
      "application/json": {
        schema: { type: "object", properties: { seen: { type: "string" }, ok: { type: "boolean" } } },
      },
    },
  },
};
const ok = { "200": { description: "OK" } };

const document = {
  openapi: "3.1.0",
  info: { title: "fixture", version: "1.0.0" },
  paths: {
    "/forms/{id}/{ids}": {
      post: {
        operationId: "forms",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "ids", in: "path", required: true, schema: { type: "array", items: { type: "integer" } } },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "n", in: "query", schema: { type: "number" } },
          { name: "b", in: "query", schema: { type: "boolean" } },
          { name: "maybe", in: "query", schema: { type: ["string", "null"] } },
          { name: "r", in: "query", allowReserved: true, schema: { type: "string" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
          { name: "X-List", in: "header", schema: { type: "array", items: { type: "string" } } },
          { name: "X-Api-Key", in: "header", schema: { type: "string" } },
          { name: "Authorization", in: "header", schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } },
        },
        responses: ok,
      },
    },
    "/merge/{id}": {
      patch: {
        operationId: "merge",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/merge-patch+json": { schema: { type: "object" } } } },
        responses: ok,
      },
    },
    "/items/{id}": {
      get: {
        operationId: "getItem",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: ok,
      },
    },
    "/echo": { get: { operationId: "echo", responses: objectResponse } },
    "/object": { get: { operationId: "object", responses: objectResponse } },
    "/fail-echo": { get: { operationId: "failEcho", responses: ok } },
    "/tagged/x-{id}": {
      get: {
        operationId: "tagged",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: ["string", "null"] } }],
        responses: ok,
      },
    },
    "/text": { get: { operationId: "text", responses: ok } },
    "/not-json": { get: { operationId: "notJson", responses: objectResponse } },
    "/fail": { get: { operationId: "fail", responses: ok } },
    "/redirect": { get: { operationId: "redirect", responses: ok } },
    "/stall": { get: { operationId: "stall", responses: ok } },
    "/stall-body": { get: { operationId: "stallBody", responses: ok } },
    "/big": { get: { operationId: "big", responses: ok } },
    "/big-declared": { get: { operationId: "bigDeclared", responses: ok } },
  },
};

interface Context {
  apiToken: string;
  /** What an MCP client presented; the executor must never forward it. */
  clientAuthorization: string;
}

const context: Context = { apiToken: operatorToken, clientAuthorization: `Bearer ${clientToken}` };

function clientExtra(signal?: AbortSignal): McpFnRequestExtra {
  return {
    ...requestExtra(signal),
    requestInfo: { headers: { authorization: `Bearer ${clientToken}` } },
    authInfo: { token: clientToken, clientId: "test-client", scopes: [] },
  } as unknown as McpFnRequestExtra;
}

const MIB = 1024 * 1024;

/** A URL with made-up user info, assembled at run time. */
function withUserInfo(href: string): string {
  const url = new URL(href);
  url.username = "test-user";
  url.password = ["test", "password"].join("-");
  return url.href;
}

let api: Fixture;
let elsewhere: Fixture;

beforeAll(async () => {
  elsewhere = await fixtureApi((_request, response) => json(response, 200, { stolen: true }));
  api = await fixtureApi((request, response, received) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    switch (path) {
      case "/v1/echo":
        json(response, 200, { seen: received.headers.authorization, ok: true });
        return;
      case "/v1/object":
        json(response, 200, { ok: true, seen: received.headers["x-tenant"] ?? "nobody" });
        return;
      case "/v1/fail-echo":
        json(response, 500, { headers: received.headers });
        return;
      case "/v1/text":
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`plain text with ${received.headers.authorization}`);
        return;
      case "/v1/not-json":
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>not json</html>");
        return;
      case "/v1/fail":
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(`upstream saw ${received.headers.authorization}; token ${operatorToken}\n${"x".repeat(10_000)}`);
        return;
      case "/v1/redirect":
        response.writeHead(302, { location: `${elsewhere.origin}/stolen` });
        response.end();
        return;
      case "/v1/stall":
        return; // never answers
      case "/v1/stall-body":
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("partial");
        return; // never ends
      case "/v1/big": {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 97);
        let sent = 0;
        const pump = () => {
          while (sent < 5 * MIB) {
            sent += chunk.byteLength;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          response.end();
        };
        response.on("close", () => response.removeAllListeners("drain"));
        pump();
        return;
      }
      case "/v1/big-declared":
        response.writeHead(200, { "content-type": "text/plain", "content-length": String(5 * MIB) });
        response.write("a");
        return;
      default:
        json(response, 200, { ok: true });
    }
  });
});

afterAll(async () => {
  await api.close();
  await elsewhere.close();
});

function catalog(options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return fromOpenAPI<Context>(document, {
    executor: httpExecutor<Context>({
      baseUrl: `${api.origin}/v1/`,
      headers: (trusted) => ({ authorization: `Bearer ${trusted.apiToken}`, "x-api-key": "test-operator-key" }),
      ...options,
    }),
    allowMutations: true,
  });
}

function text(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

function lastRequest(): Received {
  const entry = api.received.at(-1);
  if (!entry) throw new Error("the fixture received no request");
  return entry;
}

describe("httpExecutor request building", () => {
  it("sends every closed-set parameter form and a JSON body to the fixed base URL", async () => {
    const { registry } = catalog();
    const result = await registry.callTool(
      "forms",
      {
        path: { id: "a b", ids: [1, 2] },
        query: { q: "x&y=z", tags: ["a", "b c"], n: 1.5, b: true, maybe: null, r: "a/b:c?d&e=f#g" },
        header: { "X-Trace": "trace-1", "X-List": ["a", "b"] },
        body: { name: "Rex" },
      },
      context,
      clientExtra(),
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ ok: true });
    const sent = lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/v1/forms/a%20b/1,2?q=x%26y%3Dz&tags=a&tags=b%20c&n=1.5&b=true&r=a/b:c?d%26e%3Df%23g");
    expect(sent.headers["x-trace"]).toBe("trace-1");
    expect(sent.headers["x-list"]).toBe("a,b");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent.body)).toEqual({ name: "Rex" });
  });

  it("sends a *+json body with its own media type and no body when none is given", async () => {
    const { registry } = catalog();
    await registry.callTool("merge", { path: { id: "m1" }, body: { name: null } }, context, clientExtra());
    let sent = lastRequest();
    expect(sent.method).toBe("PATCH");
    expect(sent.headers["content-type"]).toBe("application/merge-patch+json");
    expect(JSON.parse(sent.body)).toEqual({ name: null });

    await registry.callTool("merge", { path: { id: "m1" } }, context, clientExtra());
    sent = lastRequest();
    expect(sent.body).toBe("");
    expect(sent.headers["content-type"]).toBeUndefined();
  });

  it.each([
    ["../admin", "/v1/items/..%2Fadmin"],
    ["a/b", "/v1/items/a%2Fb"],
    ["%2e%2e", "/v1/items/%252e%252e"],
    ["..%2f..%2fadmin", "/v1/items/..%252f..%252fadmin"],
    ["x?admin=1#frag", "/v1/items/x%3Fadmin%3D1%23frag"],
  ])("keeps the path argument %j inside its templated segment", async (id, expected) => {
    const { registry } = catalog();
    const result = await registry.callTool("getItem", { path: { id } }, context, clientExtra());
    expect(result.isError).toBeUndefined();
    expect(lastRequest().url).toBe(expected);
  });

  it.each([".", "..", ""])("refuses a path argument %j that would be a dot or empty segment, sending nothing", async (id) => {
    const { registry } = catalog();
    const before = api.received.length;
    const result = await registry.callTool("getItem", { path: { id } }, context, clientExtra());
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/cannot be empty, "\." or "\.\."/);
    expect(api.received.length).toBe(before);
  });
});

describe("httpExecutor credentials (D9)", () => {
  it("sends the operator Authorization header and never the client's token from the request context", async () => {
    const { registry } = catalog();
    await registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra());
    const sent = lastRequest();
    expect(sent.headers.authorization).toBe(`Bearer ${operatorToken}`);
    expect(JSON.stringify(sent.headers)).not.toContain(clientToken);
  });

  it("rejects a forbidden header argument by schema and drops one injected past it", async () => {
    const { registry, tools } = catalog();
    const forms = tools.find((tool) => tool.name === "forms")!;
    expect(forms.operation.parameters.map((parameter) => parameter.name)).not.toContain("Authorization");
    const args = { path: { id: "1", ids: [1] }, body: {} };
    await expect(
      registry.callTool("forms", { ...args, header: { Authorization: `Bearer ${clientToken}` } }, context, clientExtra()),
    ).rejects.toThrow(McpFnValidationError);

    // An operation and arguments that bypass fromOpenAPI and the registry.
    const injected: OpenApiOperation = {
      ...forms.operation,
      parameters: [
        ...forms.operation.parameters,
        ...["Authorization", "Cookie", "Host", "Proxy-Authorization", "Content-Type", "Connection"].map((name) => ({
          name,
          in: "header" as const,
          required: false,
          style: "simple" as const,
          explode: false,
          shape: "primitive" as const,
        })),
      ],
    };
    const executor = httpExecutor<Context>({
      baseUrl: `${api.origin}/v1`,
      headers: (trusted) => ({ authorization: `Bearer ${trusted.apiToken}`, "X-Api-Key": "test-operator-key" }),
    });
    const result = await executor.execute({
      operation: injected,
      args: {
        ...args,
        header: {
          Authorization: `Bearer ${clientToken}`,
          Cookie: "session=test-client-cookie",
          Host: "elsewhere.invalid",
          "Proxy-Authorization": `Basic ${clientToken}`,
          "Content-Type": "text/plain",
          Connection: "close",
          "X-Api-Key": "test-client-key",
          "X-Undeclared": "test-undeclared",
        },
      },
      context,
      signal: new AbortController().signal,
      hasOutputSchema: false,
    });
    expect(result.isError).toBeUndefined();
    const sent = lastRequest();
    expect(sent.headers.authorization).toBe(`Bearer ${operatorToken}`);
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.host).toBe(new URL(api.origin).host);
    expect(sent.headers["proxy-authorization"]).toBeUndefined();
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers["x-api-key"]).toBe("test-operator-key");
    expect(sent.headers["x-undeclared"]).toBeUndefined();
  });

  it("does not let a header parameter replace an operator header", async () => {
    const { registry } = catalog();
    await registry.callTool(
      "forms",
      { path: { id: "1", ids: [1] }, header: { "X-Api-Key": "test-client-key" }, body: {} },
      context,
      clientExtra(),
    );
    expect(lastRequest().headers["x-api-key"]).toBe("test-operator-key");
  });

  it("redacts credentials echoed in error bodies and withholds success bodies that echo them", async () => {
    const { registry } = catalog();
    const failed = await registry.callTool("fail", {}, context, clientExtra());
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("HTTP 500");
    expect(text(failed)).toContain("upstream saw [REDACTED]; token [REDACTED]");

    const echoed = await registry.callTool("echo", {}, context, clientExtra());
    const plain = await registry.callTool("text", {}, context, clientExtra());
    for (const result of [echoed, plain]) {
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: "The API responded with HTTP 200, so the call succeeded, but its body reveals an operator credential and was withheld.",
          },
        ],
      });
    }
    for (const result of [failed, echoed, plain]) expect(JSON.stringify(result)).not.toContain(operatorToken);
  });

  it("redacts a credential as fetch sends it, trimmed of surrounding whitespace", async () => {
    const { registry } = fromOpenAPI<Context>(document, {
      executor: httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, headers: { "x-api-key": "  test-operator-key\t" } }),
    });
    const result = await registry.callTool("failEcho", {}, context, clientExtra());
    expect(result.isError).toBe(true);
    expect(lastRequest().headers["x-api-key"]).toBe("test-operator-key");
    expect(text(result)).toContain('"x-api-key":"[REDACTED]"');
    expect(text(result)).not.toContain("test-operator-key");
  });

  it("accepts a short credential and withholds any success body that holds it", async () => {
    const short = ["a", "b", "c"].join("");
    const { fetch } = stubFetch(() => new Response(`{"ok":true,"note":"x${short}y"}`, { headers: { "content-type": "application/json" } }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { authorization: `Bearer ${short}` }, fetch });
    const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema: true });
    expect(text(result)).toContain("reveals an operator credential and was withheld");
    expect(JSON.stringify(result)).not.toContain(short);
  });

  it("calls the headers function on each call, so a retried call carries the current credential", async () => {
    let token = operatorToken;
    const { registry } = fromOpenAPI<Context>(document, {
      executor: httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, headers: () => ({ authorization: `Bearer ${token}` }) }),
    });
    await registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra());
    expect(lastRequest().headers.authorization).toBe(`Bearer ${operatorToken}`);
    token = rotatedToken;
    await registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra());
    expect(lastRequest().headers.authorization).toBe(`Bearer ${rotatedToken}`);
  });

  it("names an invalid operator header without its value", async () => {
    const badValue = `${operatorToken}\r\nx-injected: 1`;
    expect(() => httpExecutor({ baseUrl: api.origin, headers: { "x-key": badValue } })).toThrow(McpFnValidationError);
    try {
      httpExecutor({ baseUrl: api.origin, headers: { "x-key": badValue } });
    } catch (error) {
      expect((error as Error).message).toContain("x-key");
      expect((error as Error).message).not.toContain(operatorToken);
    }
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: () => ({ "x-key": badValue }) });
    const { registry } = fromOpenAPI<Context>(document, { executor });
    const failure = await registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra()).catch((error: Error) => error);
    // A server-side failure: not an McpFnError, so the server withholds it from the client.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(McpFnError);
    expect((failure as Error).message).toBe('httpExecutor headers entry "x-key" must be a string of printable ASCII characters');
  });

  it.each([
    ["a relative URL", "/v1"],
    ["a non-HTTP scheme", "ftp://127.0.0.1/"],
    ["credentials", withUserInfo("http://127.0.0.1/")],
    ["a query", "http://127.0.0.1/v1?key=1"],
    ["a fragment", "http://127.0.0.1/v1#top"],
  ])("refuses a base URL with %s", (_label, baseUrl) => {
    expect(() => httpExecutor({ baseUrl })).toThrow(McpFnValidationError);
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { maxResponseBytes: -1 },
    { maxResponseBytes: 1.5 },
  ])("refuses the bound %j", (bound) => {
    expect(() => httpExecutor({ baseUrl: api.origin, ...bound })).toThrow(McpFnValidationError);
  });
});

describe("httpExecutor responses", () => {
  it("returns a redirect to another origin as an error without following it", async () => {
    const { registry } = catalog();
    const before = elsewhere.received.length;
    const result = await registry.callTool("redirect", {}, context, clientExtra());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("HTTP 302");
    expect(text(result)).not.toContain(elsewhere.origin);
    expect(elsewhere.received.length).toBe(before);
  });

  it("times out a stalled response and a stalled body", async () => {
    const { registry } = catalog({ timeoutMs: 200 });
    for (const name of ["stall", "stallBody"]) {
      const closed = api.closed.length;
      const result = await registry.callTool(name, {}, context, clientExtra());
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The API did not respond within 200 ms." }] });
      await expect(api.closed[closed]).resolves.toEqual({ finished: false });
    }
  });

  it("cancels the fetch when the MCP request is aborted", async () => {
    const { registry } = catalog();
    const controller = new AbortController();
    const closed = api.closed.length;
    const pending = registry.callTool("stall", {}, context, clientExtra(controller.signal));
    await expect.poll(() => api.closed.length).toBe(closed + 1);
    controller.abort();
    await expect(pending).resolves.toEqual({ isError: true, content: [{ type: "text", text: "The call was cancelled." }] });
    await expect(api.closed[closed]).resolves.toEqual({ finished: false });
  });

  it("times out a fetch implementation and a body stream that ignore the abort signal", async () => {
    const neverSettles = () => new Promise<Response>(() => undefined);
    const stalledBody = () =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => new Promise(() => undefined) }), {
          status: 200,
        }),
      );
    for (const fetch of [neverSettles, stalledBody]) {
      const { registry } = fromOpenAPI<Context>(document, {
        executor: httpExecutor<Context>({ baseUrl: api.origin, timeoutMs: 100, fetch: fetch as typeof globalThis.fetch }),
      });
      await expect(registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra())).resolves.toEqual({
        isError: true,
        content: [{ type: "text", text: "The API did not respond within 100 ms." }],
      });
    }
  });

  it("sends nothing for a call already aborted", async () => {
    const { registry } = catalog();
    const controller = new AbortController();
    controller.abort();
    const before = api.received.length;
    const result = await registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra(controller.signal));
    expect(result.isError).toBe(true);
    expect(api.received.length).toBe(before);
  });

  it("cuts a 5 MiB body at the cap, streamed or declared", async () => {
    const { registry } = catalog();
    for (const name of ["big", "bigDeclared"]) {
      const closed = api.closed.length;
      const result = await registry.callTool(name, {}, context, clientExtra());
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: `The API responded with HTTP 200, but its body exceeds ${MIB} bytes and was cancelled.` }],
      });
      await expect(api.closed[closed]).resolves.toEqual({ finished: false });
    }
  });

  it("honours a smaller maxResponseBytes", async () => {
    const { registry } = catalog({ maxResponseBytes: 4 });
    const result = await registry.callTool("object", {}, context, clientExtra());
    expect(text(result)).toBe("The API responded with HTTP 200, but its body exceeds 4 bytes and was cancelled.");
  });

  it("returns a 500 as isError with the status and an excerpt capped at 4 KiB", async () => {
    const { registry } = catalog();
    const result = await registry.callTool("fail", {}, context, clientExtra());
    expect(result.isError).toBe(true);
    const match = /^The API responded with HTTP 500\.\n\n([\s\S]*)\n\[body truncated after \d+ bytes\]$/.exec(text(result));
    expect(match).not.toBeNull();
    const excerpt = match![1]!;
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(4096);
    expect(excerpt).toMatch(/^upstream saw \[REDACTED\]; token \[REDACTED\]\nx+$/);
  });

  it("returns a JSON 200 as structured content when the tool has an output schema", async () => {
    const { registry, tools } = catalog();
    expect(tools.find((tool) => tool.name === "object")!.outputSchema).toBeDefined();
    const result = await registry.callTool("object", {}, context, clientExtra());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, seen: "nobody" });
  });

  it("returns a non-JSON 200 unstructured, saying the call succeeded, when an output schema needs structured content", async () => {
    const { registry } = catalog();
    const result = await registry.callTool("notJson", {}, context, clientExtra());
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The API responded with HTTP 200 and a body that is not JSON, so the call succeeded, but the tool has no structured result to return. Do not repeat the call.",
        },
        { type: "text", text: "<html>not json</html>" },
      ],
    });
  });

  it("reports a refused connection without details", async () => {
    const closedApi = await fixtureApi(() => undefined);
    const baseUrl = closedApi.origin;
    await closedApi.close();
    const { registry } = fromOpenAPI<Context>(document, {
      executor: httpExecutor<Context>({ baseUrl, headers: { authorization: `Bearer ${operatorToken}` } }),
    });
    const result = await registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra());
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The request to the API failed." }] });
  });
});

function operationOf(name: string): OpenApiOperation {
  const { tools } = catalog();
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.operation;
}

/** A fetch that answers every request with `respond()` and records the URLs it was asked for. */
function stubFetch(respond: () => Response) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

function execute(
  executor: ReturnType<typeof httpExecutor<Context>>,
  operation: OpenApiOperation,
  args: Record<string, unknown> = {},
  options: { signal?: AbortSignal; hasOutputSchema?: boolean } = {},
) {
  return executor.execute({
    operation,
    args,
    context,
    signal: options.signal ?? new AbortController().signal,
    hasOutputSchema: options.hasOutputSchema ?? false,
  });
}

describe("httpExecutor edge cases", () => {
  const credentialHeaders = { authorization: `Bearer ${operatorToken}`, "x-api-key": "12345678901234" };
  const json201 = {
    description: "Created",
    content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
  };

  const escapedToken = [...operatorToken].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

  it.each([
    ["a JSON number", '{"seen":12345678901234}', true],
    ["a JSON number in exponent form", '{"seen":1.2345678901234e13}', true],
    ["an escaped string", `{"seen":"${escapedToken}"}`, true],
    ["an escaped string, without an output schema", `{"seen":"${escapedToken}"}`, false],
    ["a percent-encoded string, without an output schema", `seen=${[...operatorToken].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("")}`, false],
  ])("withholds a success that reveals a credential as %s", async (_label, body, hasOutputSchema) => {
    const { fetch } = stubFetch(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: credentialHeaders, fetch });
    const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("reveals an operator credential and was withheld");
    expect(result.structuredContent).toBeUndefined();
  });

  it("withholds an error excerpt that reveals a credential once decoded", async () => {
    const { fetch } = stubFetch(() => new Response(`{"error":"bad token ${escapedToken}"}`, { status: 401 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: credentialHeaders, fetch });
    const result = await execute(executor, operationOf("fail"));
    expect(text(result)).toBe("The API responded with HTTP 401.\n[body withheld: it reveals an operator credential]");
  });

  it("redacts each cookie value an error body echoes on its own", async () => {
    const session = ["test", "session", "cookie"].join("-");
    const { fetch } = stubFetch(() => new Response(`session ${session} expired`, { status: 401 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { cookie: `theme=dark; session=${session}` }, fetch });
    const result = await execute(executor, operationOf("fail"));
    expect(text(result)).toBe("The API responded with HTTP 401.\n\nsession [REDACTED] expired");
  });

  it("never cuts the excerpt inside a credential", async () => {
    const token = "test-operator-token-padded-to-forty-chars";
    // Earlier echoes shrink the text when redacted; the cut falls where a later copy would straddle it.
    const head = `Bearer ${token} ${token} `;
    // The redacted head is 22 bytes; one more byte of filler than fits a marker after it leaves the token straddling 4 KiB.
    const filler = "x".repeat(4096 - "[REDACTED] [REDACTED] ".length - "[REDACTED]".length + 1);
    const body = head + filler + token + "y".repeat(10_000);
    const { fetch } = stubFetch(() => new Response(body, { status: 500 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { authorization: `Bearer ${token}` }, fetch });
    const result = text(await execute(executor, operationOf("fail")));
    const match = /^The API responded with HTTP 500\.\n\n(\[REDACTED\] \[REDACTED\] x+)\n\[body truncated after (\d+) bytes\]$/.exec(result);
    expect(match).not.toBeNull();
    expect(Number(match![2])).toBe(head.length + filler.length);
    expect(Buffer.byteLength(match![1]!)).toBeLessThanOrEqual(4096);
    expect(result).not.toContain(token.slice(0, 4));
  });

  it("reports an error body over maxResponseBytes without an excerpt, so no credential is judged from part of it", async () => {
    const shorter = ["test", "operator", "key"].join("-");
    const longer = `${shorter}-extended`;
    const { fetch } = stubFetch(() => new Response(`${"x".repeat(40)}${longer} and more`, { status: 500 }));
    const executor = httpExecutor<Context>({
      baseUrl: api.origin,
      headers: { "x-short": shorter, "x-long": longer },
      maxResponseBytes: 60,
      fetch,
    });
    const result = await execute(executor, operationOf("fail"));
    expect(text(result)).toBe("The API responded with HTTP 500; its body exceeds 60 bytes and was cancelled.");
  });

  it("applies maxResponseBytes to error bodies, and reports a declared oversize without waiting", async () => {
    const { fetch } = stubFetch(() => new Response("abcdef", { status: 500 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, maxResponseBytes: 2, fetch });
    await expect(execute(executor, operationOf("fail"))).resolves.toMatchObject({
      content: [{ text: "The API responded with HTTP 500; its body exceeds 2 bytes and was cancelled." }],
    });

    const stalled = stubFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), {
          status: 500,
          headers: { "content-length": String(5 * MIB) },
        }),
    );
    const declared = httpExecutor<Context>({ baseUrl: api.origin, fetch: stalled.fetch });
    await expect(execute(declared, operationOf("fail"))).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: `The API responded with HTTP 500; its body exceeds ${MIB} bytes and was cancelled.` }],
    });
  });

  it("keeps an error status whose body stalls", async () => {
    const { fetch } = stubFetch(
      () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), { status: 503 }),
    );
    const executor = httpExecutor<Context>({ baseUrl: api.origin, timeoutMs: 100, fetch });
    await expect(execute(executor, operationOf("fail"))).resolves.toMatchObject({
      content: [{ text: "The API responded with HTTP 503; its body did not arrive within 100 ms." }],
    });
  });

  it("cancels the body of a response that arrives after the call timed out", async () => {
    let cancelled = false;
    let deliver: (response: Response) => void = () => undefined;
    const fetch = (() => new Promise<Response>((resolve) => (deliver = resolve))) as typeof globalThis.fetch;
    const executor = httpExecutor<Context>({ baseUrl: api.origin, timeoutMs: 50, fetch });
    const result = await execute(executor, operationOf("fail"));
    expect(text(result)).toBe("The API did not respond within 50 ms.");
    deliver(new Response(new ReadableStream({ cancel: () => void (cancelled = true) })));
    await expect.poll(() => cancelled).toBe(true);
  });

  it("publishes no output schema when an operation documents other successes, so each is a plain success", async () => {
    const replies: Array<[number, unknown]> = [
      [201, { id: "job-1" }],
      [202, { ticket: "t-1" }],
      [204, undefined],
    ];
    const { registry, tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "jobs", version: "1.0.0" },
        paths: {
          "/jobs": {
            post: {
              operationId: "createJob",
              responses: {
                "201": json201,
                "202": { description: "Accepted", content: { "application/json": { schema: { type: "object", required: ["ticket"] } } } },
                "204": { description: "Nothing to do" },
              },
            },
          },
        },
      },
      {
        executor: httpExecutor({
          baseUrl: api.origin,
          fetch: (async () => {
            const [status, body] = replies.shift()!;
            return new Response(body === undefined ? null : JSON.stringify(body), { status });
          }) as typeof globalThis.fetch,
        }),
        allowMutations: true,
      },
    );
    expect(tools[0]!.outputSchema).toBeUndefined();
    for (const expected of ['{"id":"job-1"}', '{"ticket":"t-1"}', "The API responded with HTTP 204 and no body."]) {
      await expect(registry.callTool("createJob", {}, undefined, requestExtra())).resolves.toEqual({
        content: [{ type: "text", text: expected }],
      });
    }
  });

  it("returns a success body its output schema does not describe unstructured, saying the call succeeded", async () => {
    const replies = [{ id: "job-1" }, { ticket: "t-1" }];
    const { registry, tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "jobs", version: "1.0.0" },
        paths: { "/jobs": { post: { operationId: "createJob", responses: { "201": json201 } } } },
      },
      {
        executor: httpExecutor({
          baseUrl: api.origin,
          fetch: (async () => new Response(JSON.stringify(replies.shift()), { status: 201 })) as typeof globalThis.fetch,
        }),
        allowMutations: true,
      },
    );
    expect(tools[0]!.outputSchema).toMatchObject({ required: ["id"] });
    await expect(registry.callTool("createJob", {}, undefined, requestExtra())).resolves.toMatchObject({ structuredContent: { id: "job-1" } });
    await expect(registry.callTool("createJob", {}, undefined, requestExtra())).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The API responded with HTTP 201 and a body the output schema does not describe, so the call succeeded, but the tool has no structured result to return. Do not repeat the call.",
        },
        { type: "text", text: '{"ticket":"t-1"}' },
      ],
    });
  });

  it("merges overlapping credential echoes, so no fragment of either survives", async () => {
    const first = ["test", "long", "alpha", "key"].join("-");
    const second = ["key", "beta"].join("-");
    const selfOverlapping = ["test", "key", "test"].join("-");
    for (const [headers, body] of [
      [{ "x-first": first, "x-second": second }, `${first}-beta`],
      [{ "x-self": selfOverlapping }, `${selfOverlapping}-key-test`],
    ] as const) {
      const { fetch } = stubFetch(() => new Response(body, { status: 500 }));
      const executor = httpExecutor<Context>({ baseUrl: api.origin, headers, fetch });
      const result = await execute(executor, operationOf("fail"));
      expect(text(result)).toBe("The API responded with HTTP 500.\n\n[REDACTED]");
    }
  });

  it("keeps the excerpt within 4 KiB when redaction markers are longer than the credentials", async () => {
    const { fetch } = stubFetch(() => new Response("q".repeat(4096), { status: 500 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { "x-api-key": "q" }, fetch });
    const result = await execute(executor, operationOf("fail"));
    const excerpt = /^The API responded with HTTP 500\.\n\n((?:\[REDACTED\])+)\n\[body truncated after \d+ bytes\]$/.exec(text(result));
    expect(excerpt).not.toBeNull();
    expect(Buffer.byteLength(excerpt![1]!)).toBeLessThanOrEqual(4096);
  });

  it("recognises a quoted cookie value and an escape inside percent-encoding", async () => {
    const session = ["test", "session", "cookie"].join("-");
    const quoted = stubFetch(() => new Response(`session ${session} expired`, { status: 401 }));
    const cookieExecutor = httpExecutor<Context>({ baseUrl: api.origin, headers: { cookie: `session="${session}"` }, fetch: quoted.fetch });
    expect(text(await execute(cookieExecutor, operationOf("fail")))).toBe("The API responded with HTTP 401.\n\nsession [REDACTED] expired");

    const nested = encodeURIComponent(`{"seen":"${escapedToken}"}`);
    const { fetch } = stubFetch(() => new Response(`trace=${nested}`));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: credentialHeaders, fetch });
    expect(text(await execute(executor, operationOf("text")))).toContain("reveals an operator credential and was withheld");
  });

  it("reports an error status for a HEAD request whatever its Content-Length, and for a body that breaks off", async () => {
    const head = stubFetch(() => new Response(null, { status: 404, headers: { "content-length": String(5 * MIB) } }));
    const headExecutor = httpExecutor<Context>({ baseUrl: api.origin, fetch: head.fetch });
    await expect(execute(headExecutor, { ...operationOf("fail"), method: "HEAD" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "The API responded with HTTP 404." }],
    });

    const broken = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 502 },
        ),
    );
    const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch: broken.fetch });
    await expect(execute(executor, operationOf("fail"))).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "The API responded with HTTP 502; its body could not be read." }],
    });
  });

  it("keeps the first-success output schema for other executors", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "jobs", version: "1.0.0" },
      paths: {
        "/jobs": {
          post: {
            operationId: "createJob",
            responses: { "201": json201, "204": { description: "Nothing to do" } },
          },
        },
        "/mixed": {
          get: {
            operationId: "mixedMedia",
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": json201.content["application/json"],
                  "application/vnd.example+json": { schema: { type: "object", required: ["ticket"] } },
                },
              },
            },
          },
        },
        "/text": {
          get: {
            operationId: "jsonOrText",
            responses: { "200": { description: "OK", content: { ...json201.content, "text/plain": { schema: { type: "string" } } } } },
          },
        },
      },
    };
    const custom = fromOpenAPI(document, { executor: { execute: () => ({ content: [] }) }, allowMutations: true });
    expect(custom.tools.map((tool) => [tool.name, tool.outputSchema !== undefined])).toEqual([
      ["createJob", true],
      ["mixedMedia", true],
      ["jsonOrText", true],
    ]);
    const http = fromOpenAPI(document, { executor: httpExecutor({ baseUrl: api.origin }), allowMutations: true });
    expect(http.tools.map((tool) => [tool.name, tool.outputSchema !== undefined])).toEqual([
      ["createJob", false],
      ["mixedMedia", false],
      ["jsonOrText", false],
    ]);
  });

  it("recognises a cookie value an upstream decodes before echoing it", async () => {
    const wire = ["test", "fake", "cookie"].join("%2F");
    const decoded = ["test", "fake", "cookie"].join("/");
    for (const [status, hasOutputSchema] of [[200, true], [401, false]] as const) {
      const { fetch } = stubFetch(() => new Response(JSON.stringify({ seen: decoded }), { status }));
      const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { cookie: `session=${wire}` }, fetch });
      const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(decoded);
    }
  });

  it("withholds an excerpt where an encoded credential overlaps a literal one", async () => {
    const { fetch } = stubFetch(() => new Response(`echo ${operatorToken.replace("s", "%73")}`, { status: 500 }));
    const executor = httpExecutor<Context>({
      baseUrl: api.origin,
      headers: { "x-long": operatorToken, "x-short": operatorToken.slice("test-".length) },
      fetch,
    });
    expect(text(await execute(executor, operationOf("fail")))).toBe(
      "The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]",
    );
  });

  it("withholds an excerpt with a credential in the widest decoded spelling where the 4 KiB cut falls", async () => {
    // Each character as a JSON escape whose characters are percent-encoded: 18 bytes per character.
    const widest = [...operatorToken]
      .map((char) => [..."\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")].map((part) => `%${part.charCodeAt(0).toString(16).toUpperCase()}`).join(""))
      .join("");
    const longest = encodeURIComponent(`Bearer ${operatorToken}`).length;
    const body = "x".repeat(4090) + widest + "y".repeat(20 * longest + 10_000);
    const { fetch } = stubFetch(() => new Response(body, { status: 500 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { authorization: `Bearer ${operatorToken}` }, fetch });
    const result = text(await execute(executor, operationOf("fail")));
    expect(result).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
  });

  it("returns a body that structured content would change unstructured, saying the call succeeded", async () => {
    const deep = `${"{\"a\":".repeat(20_000)}1${"}".repeat(20_000)}`;
    for (const body of ['{"n":1e400}', deep]) {
      const { fetch } = stubFetch(() => new Response(body, { headers: { "content-type": "application/json" } }));
      const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch });
      const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema: true });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("so the call succeeded");
      expect(result.content).toContainEqual({ type: "text", text: body });
    }
  });

  it("reports an error status whose body is already locked", async () => {
    const response = new Response("locked", { status: 502 });
    response.body!.getReader();
    const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch: (async () => response) as typeof globalThis.fetch });
    await expect(execute(executor, operationOf("fail"))).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "The API responded with HTTP 502; its body could not be read." }],
    });
  });

  it("recognises a UTF-8 cookie value an upstream decodes, and HTML character references", async () => {
    const wire = "test-%C3%A9-cookie";
    const decoded = "test-\u00e9-cookie";
    const cookie = stubFetch(() => new Response(JSON.stringify({ seen: decoded }), { status: 200 }));
    const cookieExecutor = httpExecutor<Context>({ baseUrl: api.origin, headers: { cookie: `session=${wire}` }, fetch: cookie.fetch });
    const success = await execute(cookieExecutor, operationOf("echo"), {}, { hasOutputSchema: true });
    expect(text(success)).toContain("reveals an operator credential and was withheld");

    const entities = [...operatorToken].map((char) => `&#${char.charCodeAt(0)};`).join("");
    const html = stubFetch(() => new Response(`<p>bad token ${entities}</p>`, { status: 401 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: credentialHeaders, fetch: html.fetch });
    expect(text(await execute(executor, operationOf("fail")))).toBe(
      "The API responded with HTTP 401.\n[body withheld: it reveals an operator credential]",
    );
  });

  it("withholds an excerpt whose encoded echo keeps the credential count unchanged", async () => {
    // Decoding turns the literal echo's own `\u0078` into `x`, and the escaped echo into the credential.
    const credential = "test\\u0078-key";
    const escaped = [...credential].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const { fetch } = stubFetch(() => new Response(`${credential} ${escaped}`, { status: 500 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { "x-api-key": credential }, fetch });
    expect(text(await execute(executor, operationOf("fail")))).toBe(
      "The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]",
    );
  });

  it("returns a body whose numbers JSON parsing would change unstructured", async () => {
    for (const body of ['{"id":9007199254740993}', '{"n":1e-400}', '{"id":"9007199254740993","n":1.5}']) {
      const { fetch } = stubFetch(() => new Response(body, { headers: { "content-type": "application/json" } }));
      const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch });
      const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema: true });
      if (body.includes('"9007199254740993"')) {
        // A string is kept as written, and 1.5 is exact.
        expect(result.structuredContent).toEqual({ id: "9007199254740993", n: 1.5 });
      } else {
        expect(text(result)).toContain("a body that cannot be returned as structured content, so the call succeeded");
      }
    }
  });

  it("skips an operation that requires a header fetch manages", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "upgrade", version: "1.0.0" },
        paths: {
          "/socket": {
            get: { operationId: "socket", parameters: [{ name: "Upgrade", in: "header", required: true, schema: { type: "string" } }], responses: ok },
          },
        },
      },
      { executor: httpExecutor({ baseUrl: api.origin }) },
    );
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([{ code: "unsupported-by-executor", reason: 'fetch manages the required header "Upgrade"' }]);
  });

  it("never reads a then property of a header record", async () => {
    const record = Object.create(
      {
        get then(): unknown {
          throw new Error(`then read for ${operatorToken}`);
        },
      },
      { authorization: { value: `Bearer ${operatorToken}`, enumerable: true } },
    ) as Record<string, string>;
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    for (const headers of [record, () => record]) {
      const executor = httpExecutor<Context>({ baseUrl: api.origin, headers, fetch });
      await expect(execute(executor, operationOf("getItem"), { path: { id: "1" } })).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    }
    expect(urls).toHaveLength(2);
    const thenable = { get then(): unknown { throw new Error(`then read for ${operatorToken}`); } };
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: () => thenable as unknown as Record<string, string>, fetch });
    const failure = await execute(executor, operationOf("getItem"), { path: { id: "1" } }).catch((error: Error) => error);
    expect((failure as Error).message).toBe("httpExecutor headers could not be read");
    // An async function's own promise resolution reads it; that failure is the function's.
    const asyncThenable = httpExecutor<Context>({ baseUrl: api.origin, headers: async () => thenable as unknown as Record<string, string>, fetch });
    const asyncFailure = await execute(asyncThenable, operationOf("getItem"), { path: { id: "1" } }).catch((error: Error) => error);
    expect((asyncFailure as Error).message).toBe("httpExecutor headers function failed");
  });

  it("turns a header record whose getter throws into a server-side error without its details", async () => {
    const throwing = {
      get authorization(): string {
        throw new McpFnValidationError(`cannot read ${operatorToken}`);
      },
    };
    expect(() => httpExecutor({ baseUrl: api.origin, headers: throwing })).toThrow("httpExecutor headers could not be read");
    const throwingOptions = {
      baseUrl: api.origin,
      get headers(): Record<string, string> {
        throw new Error(`cannot read ${operatorToken}`);
      },
    };
    expect(() => httpExecutor(throwingOptions)).toThrow("httpExecutor headers could not be read");
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: () => throwing });
    const failure = await execute(executor, operationOf("getItem"), { path: { id: "1" } }).catch((error: Error) => error);
    expect(failure).not.toBeInstanceOf(McpFnError);
    expect((failure as Error).message).toBe("httpExecutor headers could not be read");
  });

  it("reports a bodyless success as a success, and ignores a HEAD Content-Length", async () => {
    const operation = operationOf("echo");
    const noContent = stubFetch(() => new Response(null, { status: 204 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch: noContent.fetch });
    await expect(execute(executor, operation, {}, { hasOutputSchema: true })).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The API responded with HTTP 204 and no body, so the call succeeded, but the tool has no structured result to return. Do not repeat the call.",
        },
      ],
    });
    await expect(execute(executor, operation)).resolves.toEqual({
      content: [{ type: "text", text: "The API responded with HTTP 204 and no body." }],
    });

    const head = stubFetch(() => new Response(null, { status: 200, headers: { "content-length": String(5 * MIB) } }));
    const headExecutor = httpExecutor<Context>({ baseUrl: api.origin, fetch: head.fetch });
    await expect(execute(headExecutor, { ...operation, method: "HEAD" })).resolves.toEqual({
      content: [{ type: "text", text: "The API responded with HTTP 200 and no body." }],
    });
  });

  it("sends a schema-valid null path value as an empty value inside its segment", async () => {
    const { registry } = catalog();
    await registry.callTool("tagged", { path: { id: null } }, context, clientExtra());
    expect(lastRequest().url).toBe("/v1/tagged/x-");
  });

  it("refuses a template that the URL parser would rewrite outside its segment", async () => {
    const { fetch, urls } = stubFetch(() => new Response("{}"));
    const executor = httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, fetch });
    const operation: OpenApiOperation = { ...operationOf("getItem"), path: "/items\\{id}" };
    for (const id of ["..", "a"]) {
      await expect(execute(executor, operation, { path: { id } })).resolves.toEqual({
        isError: true,
        content: [{ type: "text", text: "The operation path cannot be sent as written." }],
      });
    }
    expect(urls).toEqual([]);
  });

  it("settles a call cancelled while the headers function is pending, without fetching", async () => {
    const { fetch, urls } = stubFetch(() => new Response("{}"));
    let rejectHeaders: (error: Error) => void = () => undefined;
    const executor = httpExecutor<Context>({
      baseUrl: api.origin,
      headers: () => new Promise((_resolve, reject) => (rejectHeaders = reject)),
      fetch,
    });
    const controller = new AbortController();
    const pending = execute(executor, operationOf("getItem"), { path: { id: "1" } }, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ isError: true, content: [{ type: "text", text: "The call was cancelled." }] });
    // A late rejection is consumed, not reported as unhandled.
    rejectHeaders(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(urls).toEqual([]);
  });

  it("turns a failing headers function into a server-side error without its details", async () => {
    const executor = httpExecutor<Context>({
      baseUrl: api.origin,
      headers: () => {
        throw new McpFnValidationError(`lookup failed for ${operatorToken}`);
      },
    });
    const failure = await execute(executor, operationOf("getItem"), { path: { id: "1" } }).catch((error: Error) => error);
    expect(failure).not.toBeInstanceOf(McpFnError);
    expect((failure as Error).message).toBe("httpExecutor headers function failed");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("lets fromOpenAPI skip operations fetch cannot send before naming any tool", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "methods", version: "1.0.0" },
        paths: {
          "/trace": { trace: { operationId: "traceIt", responses: ok } },
          "/search": {
            get: {
              operationId: "searchWithBody",
              requestBody: { content: { "application/json": { schema: { type: "object" } } } },
              responses: ok,
            },
          },
          "/plain": { get: { operationId: "plain", responses: ok } },
        },
      },
      // One name for every operation: only the operation that is kept takes it.
      { executor: httpExecutor({ baseUrl: api.origin }), allowMutations: true, name: () => "only" },
    );
    expect(tools.map((tool) => [tool.name, tool.operation.operationId])).toEqual([["only", "plain"]]);
    expect(skipped).toEqual([
      { operation: { method: "TRACE", path: "/trace", operationId: "traceIt" }, code: "unsupported-by-executor", reason: "fetch cannot send TRACE requests" },
      {
        operation: { method: "GET", path: "/search", operationId: "searchWithBody" },
        code: "unsupported-by-executor",
        reason: "fetch cannot send a GET request with a body",
      },
    ]);
  });
});
