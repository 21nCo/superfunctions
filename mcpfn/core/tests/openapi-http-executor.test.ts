import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpFnServer, McpFnError, McpFnRegistry, McpFnValidationError, type McpFnRequestExtra } from "../src/index.js";
import { fromOpenAPI, httpExecutor, type HttpExecutorHeaderSource, type OpenApiExecutor, type OpenApiOperation } from "../src/openapi/index.js";
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

  describe("an operator Content-Type", () => {
    const withContentType = (headers: HttpExecutorHeaderSource<Context>) =>
      fromOpenAPI<Context>(document, { executor: httpExecutor<Context>({ baseUrl: `${api.origin}/v1/`, headers }), allowMutations: true })
        .registry;

    it.each([
      ["a record", { "content-type": "application/json; charset=utf-8" }],
      ["a function", () => ({ "Content-Type": "application/json; charset=utf-8" })],
      ["a record, any case", { "content-type": "Application/JSON" }],
    ] as Array<[string, HttpExecutorHeaderSource<Context>]>)("is sent as written from %s when it matches the body's media type", async (_, headers) => {
      const expected = typeof headers === "function" ? headers(context)["Content-Type"] : (headers as Record<string, string>)["content-type"];
      const result = await withContentType(headers).callTool(
        "forms",
        { path: { id: "a", ids: [1] }, header: { "X-Trace": "trace-1" }, body: { name: "Rex" } },
        context,
        clientExtra(),
      );
      expect(result.isError).toBeUndefined();
      expect(lastRequest().headers["content-type"]).toBe(expected);
      expect(JSON.parse(lastRequest().body)).toEqual({ name: "Rex" });
    });

    it("is sent as written for a +json operation when it matches", async () => {
      const registry = withContentType({ "content-type": "application/merge-patch+json; charset=UTF-8" });
      const result = await registry.callTool("merge", { path: { id: "m1" }, body: { name: null } }, context, clientExtra());
      expect(result.isError).toBeUndefined();
      expect(lastRequest().headers["content-type"]).toBe("application/merge-patch+json; charset=UTF-8");
    });

    it.each([
      ["another media type", "text/x-operator-type"],
      ["a JSON type the operation does not document", "application/json"],
      ["a charset other than UTF-8", "application/merge-patch+json; charset=utf-16le"],
      ["an unparsable value", "application/merge-patch+json; x-operator-param"],
    ])("refuses the call before fetch for %s, naming the header but not its value", async (_, value) => {
      const before = api.received.length;
      for (const headers of [{ "content-type": value }, () => ({ "content-type": value })]) {
        const result = await withContentType(headers).callTool("merge", { path: { id: "m1" }, body: { name: "Rex" } }, context, clientExtra());
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("Content-Type");
        expect(text(result)).not.toContain(value);
      }
      expect(api.received.length).toBe(before);
    });

    it("leaves a bodyless call unchanged", async () => {
      const registry = withContentType({ "content-type": "text/x-operator-type" });
      const result = await registry.callTool("merge", { path: { id: "m1" } }, context, clientExtra());
      expect(result.isError).toBeUndefined();
      expect(lastRequest().headers["content-type"]).toBe("text/x-operator-type");
    });
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

  it("refuses, sending nothing, a header parameter value for a header the operator's function sets", async () => {
    const { registry } = catalog();
    const before = api.received.length;
    const result = await registry.callTool(
      "forms",
      { path: { id: "1", ids: [1] }, header: { "X-Api-Key": "test-client-key" }, body: {} },
      context,
      clientExtra(),
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: 'The header parameter "X-Api-Key" is set by the server; leave it out.' }],
    });
    expect(api.received.length).toBe(before);
    await registry.callTool("forms", { path: { id: "1", ids: [1] }, header: { "X-Trace": "trace-1" }, body: {} }, context, clientExtra());
    expect(lastRequest().headers["x-api-key"]).toBe("test-operator-key");
  });

  it("publishes no input for a header an operator record sets or an optional one fetch manages", async () => {
    const managed = ["Connection", "Expect", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"];
    const { registry, tools } = fromOpenAPI<Context>(
      {
        openapi: "3.1.0",
        info: { title: "owned", version: "1.0.0" },
        paths: {
          "/owned": {
            get: {
              operationId: "owned",
              parameters: [
                { name: "X-Api-Key", in: "header", required: true, schema: { type: "string" } },
                { name: "X-Trace", in: "header", schema: { type: "string" } },
                ...managed.map((name) => ({ name, in: "header", schema: { type: "string" } })),
              ],
              responses: ok,
            },
          },
        },
      },
      { executor: httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, headers: { "X-API-KEY": "test-operator-key" } }) },
    );
    const owned = tools[0]!;
    expect(owned.operation.parameters.map((parameter) => parameter.name)).toEqual(["X-Trace"]);
    expect(Object.keys((owned.inputSchema.properties as Record<string, { properties: object }>).header!.properties)).toEqual(["X-Trace"]);
    for (const name of ["X-Api-Key", ...managed]) {
      await expect(registry.callTool("owned", { header: { [name]: "test-client-value" } }, context, clientExtra())).rejects.toThrow(
        McpFnValidationError,
      );
    }
    await registry.callTool("owned", { header: { "X-Trace": "trace-2" } }, context, clientExtra());
    expect(lastRequest().headers["x-api-key"]).toBe("test-operator-key");
    expect(lastRequest().headers["x-trace"]).toBe("trace-2");
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
    const expected = {
      stall: "The API did not respond within 200 ms.",
      // The status arrived, so the call may have taken effect: it must not read as unanswered.
      stallBody:
        "The API responded with HTTP 200, so the call reached the API and may have taken effect, but its body did not arrive within 200 ms. Do not repeat the call without checking.",
    };
    for (const [name, message] of Object.entries(expected)) {
      const closed = api.closed.length;
      const result = await registry.callTool(name, {}, context, clientExtra());
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: message }] });
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
    for (const [fetch, message] of [
      [neverSettles, "The API did not respond within 100 ms."],
      [
        stalledBody,
        "The API responded with HTTP 200, so the call reached the API and may have taken effect, but its body did not arrive within 100 ms. Do not repeat the call without checking.",
      ],
    ] as const) {
      const { registry } = fromOpenAPI<Context>(document, {
        executor: httpExecutor<Context>({ baseUrl: api.origin, timeoutMs: 100, fetch: fetch as typeof globalThis.fetch }),
      });
      await expect(registry.callTool("getItem", { path: { id: "1" } }, context, clientExtra())).resolves.toEqual({
        isError: true,
        content: [{ type: "text", text: message }],
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
    // Separate echoes, so each is its own marker (adjacent ones merge into one).
    const { fetch } = stubFetch(() => new Response("q ".repeat(2048), { status: 500 }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { "x-api-key": "q" }, fetch });
    const result = await execute(executor, operationOf("fail"));
    const excerpt = /^The API responded with HTTP 500\.\n\n((?:\[REDACTED\] )+)\n\[body truncated after \d+ bytes\]$/.exec(text(result));
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
    // Percent-encode only the first "s" of the token (index-based, so exactly one character is encoded).
    const first = operatorToken.indexOf("s");
    const partlyEncoded = `${operatorToken.slice(0, first)}%73${operatorToken.slice(first + 1)}`;
    const { fetch } = stubFetch(() => new Response(`echo ${partlyEncoded}`, { status: 500 }));
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
    for (const body of [
      '{"id":9007199254740993}',
      '{"id":9007199254740993.0}',
      '{"id":9.007199254740993e15}',
      // An underflow written longer than any fixed window.
      `{"n":0.${"0".repeat(1200)}1}`,
      '{"n":1e-400}',
      // Below 2^53 too: digits a double cannot hold are lost.
      '{"n":0.123456789012345678901}',
      '{"n":1.0000000000000001}',
      '{"n":9007199254740991.1}',
      // A negative zero serializes as 0.
      '{"n":-0}',
      '{"n":-0.0e5}',
      '{"id":"9007199254740993","n":1.5}',
    ]) {
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
    // A plain record with a then getter that is not enumerable, so only thenable handling would read it.
    // A non-enumerable key is refused (it is neither sent nor skipped) without its getter being read.
    const record = Object.defineProperty({ authorization: `Bearer ${operatorToken}` }, "then", {
      get(): unknown {
        throw new Error(`then read for ${operatorToken}`);
      },
      enumerable: false,
    }) as Record<string, string>;
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const refused = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers: () => record, fetch }), operationOf("getItem"), { path: { id: "1" } }).catch(
      (error: Error) => error,
    );
    expect((refused as Error).message).toBe('httpExecutor headers entry "then" is not enumerable');
    expect(urls).toHaveLength(0);
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

  it("keeps a large number whose shortest spelling is the value written, however it is written", async () => {
    const body = '{"a":1e23,"b":100000000000000000000000,"c":9007199254740992.0,"d":-9.007199254740992e15,"e":1.50,"f":0.10,"g":1E2}';
    const { fetch } = stubFetch(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch });
    const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema: true });
    expect(result.structuredContent).toEqual({ a: 1e23, b: 1e23, c: 9007199254740992, d: -9007199254740992, e: 1.5, f: 0.1, g: 100 });
  });

  it.each([
    ["undefined", () => undefined],
    ["null", () => null],
    ["a promise of undefined", async () => undefined],
  ])("refuses to send a call whose headers function returns %s", async (_label, headers) => {
    const { fetch, urls } = stubFetch(() => new Response("{}"));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: headers as () => Record<string, string>, fetch });
    const failure = await execute(executor, operationOf("getItem"), { path: { id: "1" } }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(McpFnError);
    expect(urls).toEqual([]);
  });

  it("recognises a cookie value whose percent-encoding holds a byte order mark mid-value", async () => {
    const wire = ["test", "fake", "cookie"].join("%EF%BB%BF");
    // As decodeURIComponent, and so cookie parsers, decode it: the U+FEFF is kept.
    const decoded = decodeURIComponent(wire);
    expect(decoded).toContain("\uFEFF");
    for (const [status, hasOutputSchema] of [[200, true], [401, false]] as const) {
      const { fetch } = stubFetch(() => new Response(JSON.stringify({ seen: decoded }), { status }));
      const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { cookie: `session=${wire}` }, fetch });
      const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(JSON.stringify(decoded).slice(1, -1));
      expect(text(result)).not.toContain(decoded);
    }
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

describe("httpExecutor apiKey credentials (D9)", () => {
  const credentialDocument = {
    openapi: "3.1.0",
    info: { title: "credentials", version: "1.0.0" },
    components: {
      securitySchemes: {
        queryKey: { type: "apiKey", in: "query", name: "api_key" },
        headerKey: { $ref: "#/components/securitySchemes/headerKeyTarget" },
        headerKeyTarget: { type: "apiKey", in: "header", name: "X-Api-Key" },
        cookieKey: { type: "apiKey", in: "cookie", name: "session" },
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    // Inherited by every operation that declares no security of its own.
    security: [{ headerKey: [] }],
    paths: {
      "/query-only": {
        get: {
          operationId: "queryOnly",
          security: [{ queryKey: [] }],
          parameters: [{ name: "api_key", in: "query", required: true, schema: { type: "string" } }],
          responses: ok,
        },
      },
      "/query-or-bearer": {
        get: {
          operationId: "queryOrBearer",
          security: [{ queryKey: [] }, { bearer: [] }],
          parameters: [
            { name: "api_key", in: "query", required: true, schema: { type: "string" } },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          responses: ok,
        },
      },
      "/header-key": {
        get: {
          operationId: "headerKey",
          parameters: [
            { name: "x-api-key", in: "header", required: true, schema: { type: "string" } },
            { name: "X-Trace", in: "header", schema: { type: "string" } },
          ],
          responses: ok,
        },
      },
      "/cookie-key": {
        get: {
          operationId: "cookieKey",
          security: [{ cookieKey: [] }],
          parameters: [{ name: "session", in: "cookie", required: true, schema: { type: "string" } }],
          responses: ok,
        },
      },
    },
  };

  // The operator authenticates with a bearer token only: it sets no X-Api-Key.
  function credentialCatalog() {
    return fromOpenAPI<Context>(credentialDocument, {
      executor: httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, headers: (trusted) => ({ authorization: `Bearer ${trusted.apiToken}` }) }),
    });
  }

  it("skips an operation whose only credential goes in the query, which operator headers cannot supply", () => {
    const { tools, skipped } = credentialCatalog();
    expect(tools.map((tool) => tool.name)).not.toContain("queryOnly");
    expect(skipped).toEqual([
      {
        operation: { method: "GET", path: "/query-only", operationId: "queryOnly" },
        code: "unsupported-by-executor",
        reason: 'the operation needs the query credential "api_key", which operator headers cannot supply',
      },
    ]);
  });

  it("never takes an apiKey parameter as an input, and gives the executor the schemes", () => {
    const { tools } = credentialCatalog();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("queryOrBearer")!.operation.parameters.map((parameter) => parameter.name)).toEqual(["q"]);
    expect(byName.get("headerKey")!.operation.parameters.map((parameter) => parameter.name)).toEqual(["X-Trace"]);
    // A cookie credential is dropped rather than making the operation unsupported.
    expect(byName.get("cookieKey")!.operation.parameters).toEqual([]);
    expect(byName.get("headerKey")!.operation.securitySchemes).toEqual({ headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" } });
    expect(byName.get("queryOrBearer")!.operation.securitySchemes).toEqual({
      queryKey: { type: "apiKey", in: "query", name: "api_key" },
      bearer: { type: "http", scheme: "bearer" },
    });
    expect(byName.get("queryOrBearer")!.inputSchema.properties).toMatchObject({ query: { properties: { q: { type: "string" } } } });
    expect(JSON.stringify(byName.get("queryOrBearer")!.inputSchema)).not.toContain("api_key");
    expect(JSON.stringify(byName.get("headerKey")!.inputSchema).toLowerCase()).not.toContain("x-api-key");
  });

  it("drops the same parameters for any executor, so no catalog takes a credential from the caller", () => {
    const { tools } = fromOpenAPI(credentialDocument, { executor: { execute: () => ({ content: [] }) } });
    expect(tools.find((tool) => tool.name === "queryOnly")!.operation.parameters).toEqual([]);
    expect(tools.find((tool) => tool.name === "headerKey")!.operation.parameters.map((parameter) => parameter.name)).toEqual(["X-Trace"]);
  });

  it("rejects a caller's credential by schema and sends none injected past it", async () => {
    const { registry, tools } = credentialCatalog();
    await expect(
      registry.callTool("queryOrBearer", { query: { api_key: "test-client-key", q: "x" } }, context, clientExtra()),
    ).rejects.toThrow(McpFnValidationError);
    await expect(
      registry.callTool("headerKey", { header: { "x-api-key": "test-client-key" } }, context, clientExtra()),
    ).rejects.toThrow(McpFnValidationError);

    // Operations that still declare the credential, and arguments that bypass the registry.
    const executor = httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, headers: (trusted) => ({ authorization: `Bearer ${trusted.apiToken}` }) });
    const declared = (name: string, location: "query" | "header") => ({
      name,
      in: location,
      required: true,
      style: location === "query" ? ("form" as const) : ("simple" as const),
      explode: location === "query",
      shape: "primitive" as const,
    });
    const queryOrBearer = tools.find((tool) => tool.name === "queryOrBearer")!.operation;
    let result = await execute(executor, { ...queryOrBearer, parameters: [...queryOrBearer.parameters, declared("api_key", "query")] }, {
      query: { api_key: "test-client-key", q: "x" },
    });
    expect(result.isError).toBeUndefined();
    expect(lastRequest().url).toBe("/v1/query-or-bearer?q=x");

    const headerKey = tools.find((tool) => tool.name === "headerKey")!.operation;
    result = await execute(executor, { ...headerKey, parameters: [...headerKey.parameters, declared("X-API-KEY", "header")] }, {
      header: { "X-API-KEY": "test-client-key", "X-Trace": "trace-3" },
    });
    expect(result.isError).toBeUndefined();
    const sent = lastRequest();
    expect(sent.url).toBe("/v1/header-key");
    expect(sent.headers["x-api-key"]).toBeUndefined();
    expect(sent.headers["x-trace"]).toBe("trace-3");
    expect(sent.headers.authorization).toBe(`Bearer ${operatorToken}`);
  });

  it("supplies the header credential from the operator when it sets one", async () => {
    const { registry, tools } = fromOpenAPI<Context>(credentialDocument, {
      executor: httpExecutor<Context>({ baseUrl: `${api.origin}/v1`, headers: { "X-Api-Key": "test-operator-key" } }),
    });
    expect(tools.find((tool) => tool.name === "headerKey")!.operation.parameters.map((parameter) => parameter.name)).toEqual(["X-Trace"]);
    const result = await registry.callTool("headerKey", {}, context, clientExtra());
    expect(result.isError).toBeUndefined();
    expect(lastRequest().headers["x-api-key"]).toBe("test-operator-key");
  });
});

describe("httpExecutor security schemes it cannot rely on", () => {
  it("skips an operation whose security names a scheme that does not resolve or has no placement, or a header fetch manages", () => {
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "schemes", version: "1.0.0" },
        components: {
          securitySchemes: {
            external: { $ref: "https://schemes.example.com/key.yaml#/key" },
            cycleA: { $ref: "#/components/securitySchemes/cycleB" },
            cycleB: { $ref: "#/components/securitySchemes/cycleA" },
            nameless: { type: "apiKey", in: "query" },
            connectionKey: { type: "apiKey", in: "header", name: "Connection" },
            bearer: { type: "http", scheme: "bearer" },
          },
        },
        paths: {
          // An alternative without credentials does not help: the missing scheme's parameter is unknown.
          "/missing": {
            get: {
              operationId: "missing",
              security: [{ missing: [] }, {}],
              parameters: [{ name: "key", in: "query", schema: { type: "string" } }],
              responses: ok,
            },
          },
          "/external": { get: { operationId: "external", security: [{ external: [] }], responses: ok } },
          "/cycle": { get: { operationId: "cycle", security: [{ bearer: [] }, { cycleA: [] }], responses: ok } },
          "/nameless": { get: { operationId: "nameless", security: [{ nameless: [] }], responses: ok } },
          "/transport": { get: { operationId: "transport", security: [{ connectionKey: [] }], responses: ok } },
          "/transport-or-bearer": { get: { operationId: "transportOrBearer", security: [{ connectionKey: [] }, { bearer: [] }], responses: ok } },
        },
      },
      { executor: httpExecutor({ baseUrl: api.origin }) },
    );
    expect(tools.map((tool) => tool.name)).toEqual(["transportOrBearer"]);
    expect(skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["missing", "unsupported-by-executor", 'the security scheme "missing" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown'],
      ["external", "unsupported-by-executor", 'the security scheme "external" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown'],
      ["cycle", "unsupported-by-executor", 'the security scheme "cycleA" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown'],
      ["nameless", "unsupported-by-executor", 'the apiKey security scheme "nameless" has no usable name and location'],
      ["transport", "unsupported-by-executor", 'the operation needs the credential header "Connection", which fetch manages'],
    ]);
  });
});

describe("httpExecutor header sources it cannot read as a record", () => {
  function capturingFetch() {
    const sent: Headers[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    return { fetch, sent };
  }

  it("awaits a promise from another realm, so its headers are sent", async () => {
    const record = { authorization: `Bearer ${operatorToken}` };
    const { fetch, sent } = capturingFetch();
    const executor = httpExecutor<Context>({
      baseUrl: api.origin,
      headers: () => runInNewContext("Promise.resolve(record)", { record }) as Record<string, string>,
      fetch,
    });
    await expect(execute(executor, operationOf("getItem"), { path: { id: "1" } })).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("authorization")).toBe(`Bearer ${operatorToken}`);
  });

  it.each([
    ["a Map", () => new Map([["authorization", `Bearer ${operatorToken}`]])],
    ["a Headers", () => new Headers({ authorization: `Bearer ${operatorToken}` })],
    ["another realm's object", () => runInNewContext("({ authorization: value })", { value: `Bearer ${operatorToken}` })],
    ["another realm's promise of another realm's object", () => runInNewContext("Promise.resolve({ authorization: value })", { value: `Bearer ${operatorToken}` })],
    ["null", () => null],
    ["a string", () => `Bearer ${operatorToken}`],
  ])("refuses %s, sending nothing, from a function or as the option", async (_label, make) => {
    const { fetch, sent } = capturingFetch();
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: () => make() as unknown as Record<string, string>, fetch });
    const failure = await execute(executor, operationOf("getItem"), { path: { id: "1" } }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(McpFnError);
    expect((failure as Error).message).toBe("httpExecutor headers must be a plain object of header names to string values");
    expect(sent).toEqual([]);
    const value = make();
    if (!(value instanceof Promise) && !String(value).includes("Promise")) {
      expect(() => httpExecutor({ baseUrl: api.origin, headers: value as unknown as Record<string, string>, fetch })).toThrow(McpFnValidationError);
    }
  });

  it("still sends no operator headers only for an explicit empty record", async () => {
    const { fetch, sent } = capturingFetch();
    for (const headers of [{}, () => ({}), () => Object.create(null) as Record<string, string>]) {
      const executor = httpExecutor<Context>({ baseUrl: api.origin, headers, fetch });
      await execute(executor, operationOf("getItem"), { path: { id: "1" } });
    }
    expect(sent.map((headers) => headers.get("authorization"))).toEqual([null, null, null]);
  });
});

describe("httpExecutor credentials beginning with a byte order mark", () => {
  it("recognises the credential echoed at the start of a success or error body", async () => {
    const wire = `%EF%BB%BF${["test", "fake", "cookie"].join("-")}`;
    const decoded = decodeURIComponent(wire);
    expect(decoded.startsWith("\uFEFF")).toBe(true);
    for (const status of [200, 500]) {
      // The UTF-8 body starts with the bytes EF BB BF, which a BOM-stripping decoder drops.
      const { fetch } = stubFetch(() => new Response(`${decoded} and more`, { status, headers: { "content-type": "text/plain" } }));
      const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: { cookie: `session=${wire}` }, fetch });
      const result = await execute(executor, operationOf("echo"));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("test-fake-cookie");
    }
  });

  it("still parses a JSON success body that starts with a byte order mark", async () => {
    const { fetch } = stubFetch(() => new Response('\uFEFF{"ok":true}', { headers: { "content-type": "application/json" } }));
    const executor = httpExecutor<Context>({ baseUrl: api.origin, fetch });
    const result = await execute(executor, operationOf("echo"), {}, { hasOutputSchema: true });
    expect(result.structuredContent).toEqual({ ok: true });
  });
});

describe("httpExecutor security it cannot read strictly", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "strict security", version: "1.0.0" },
    components: {
      securitySchemes: {
        headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
        typoKey: { type: "api-key", in: "header", name: "X-Api-Key" },
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    // Inherited by every operation that declares no security of its own.
    security: [{ headerKey: [] }],
    paths: {
      // A bare name is not a requirement: reading the rest as [] would replace the inherited apiKey requirement.
      "/bare-name": { get: { operationId: "bareName", security: ["headerKey"], parameters: [{ name: "X-Api-Key", in: "header", schema: { type: "string" } }], responses: ok } },
      "/typo-type": { get: { operationId: "typoType", security: [{ typoKey: [] }], parameters: [{ name: "X-Api-Key", in: "header", schema: { type: "string" } }], responses: ok } },
      "/scope-string": { get: { operationId: "scopeString", security: [{ bearer: "read" }], responses: ok } },
      "/not-a-list": { get: { operationId: "notAList", security: { headerKey: [] }, responses: ok } },
      "/open": { get: { operationId: "open", security: [], responses: ok } },
    },
  };

  it("skips an operation whose security is malformed or names a scheme of an unknown type, and still sends one with none", async () => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const { registry, tools, skipped } = fromOpenAPI<Context>(document, {
      executor: httpExecutor<Context>({ baseUrl: api.origin, headers: { authorization: `Bearer ${operatorToken}` }, fetch }),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["open"]);
    expect(skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["bareName", "unsupported-by-executor", "its security cannot be read: the operation's security has a requirement that is not a plain object"],
      [
        "typoType",
        "unsupported-by-executor",
        'the security scheme "typoKey" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown',
      ],
      ["scopeString", "unsupported-by-executor", 'its security cannot be read: the scopes of the security scheme "bearer" are not a list of strings'],
      ["notAList", "unsupported-by-executor", "its security cannot be read: the operation's security is not a list of requirements"],
    ]);
    await expect(registry.callTool("open", {}, undefined, requestExtra())).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(urls).toEqual([`${api.origin}/open`]);
  });

  it("tells any executor that the security is unresolved", () => {
    const { tools } = fromOpenAPI(document, { executor: { execute: () => ({ content: [] }) } });
    const byName = new Map(tools.map((tool) => [tool.name, tool.operation]));
    expect(byName.get("bareName")!.securityUnresolved).toBe("the operation's security has a requirement that is not a plain object");
    expect(byName.get("open")!.securityUnresolved).toBeUndefined();
  });
});

describe("httpExecutor bodies in other character encodings", () => {
  const headers = { authorization: `Bearer ${operatorToken}` };
  const utf16 = (value: string, bom = false) => {
    const bytes = Buffer.from(value, "utf16le");
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]) : bytes;
  };

  it.each([
    ["a declared utf-16le charset", utf16(`seen ${operatorToken}`), "text/plain; charset=utf-16le"],
    ["a quoted declared charset", utf16(`seen ${operatorToken}`), 'text/plain; charset="UTF-16LE"'],
    ["a UTF-16 byte order mark without a charset", utf16(`seen ${operatorToken}`, true), "text/plain"],
  ])("checks and withholds a credential echoed in %s, a body read in more than one way", async (_label, body, contentType) => {
    const { fetch } = stubFetch(() => new Response(body, { status: 200, headers: { "content-type": contentType } }));
    const success = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch }), operationOf("echo"));
    expect(success.isError).toBe(true);
    expect(text(success)).toContain("reveals an operator credential and was withheld");
    const failing = stubFetch(() => new Response(body, { status: 500, headers: { "content-type": contentType } }));
    const failure = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: failing.fetch }), operationOf("echo"));
    expect(text(failure)).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
  });

  it("withholds a credential echo interleaved with NULs, as UTF-16 read without its encoding", async () => {
    const body = utf16(`seen ${operatorToken}`);
    for (const status of [200, 500]) {
      const { fetch } = stubFetch(() => new Response(body, { status, headers: { "content-type": "text/plain" } }));
      const result = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch }), operationOf("echo"));
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(status === 200 ? /reveals an operator credential and was withheld/ : /\[body withheld: it reveals an operator credential\]$/);
    }
  });

  it("withholds a body whose declared charset cannot be decoded", async () => {
    for (const status of [200, 500]) {
      const { fetch } = stubFetch(() => new Response("hello", { status, headers: { "content-type": "text/plain; charset=x-unknown-test" } }));
      const result = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch }), operationOf("echo"));
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        status === 200
          ? "The API responded with HTTP 200, so the call succeeded, but its body is in a character encoding that cannot be determined or decoded and was withheld."
          : "The API responded with HTTP 500.\n[body withheld: its character encoding cannot be determined or decoded]",
      );
    }
  });

  it("parses a JSON success body in its declared encoding", async () => {
    const { fetch } = stubFetch(() => new Response(utf16('{"ok":true}'), { headers: { "content-type": "application/json; charset=utf-16le" } }));
    const result = await execute(httpExecutor<Context>({ baseUrl: api.origin, fetch }), operationOf("echo"), {}, { hasOutputSchema: true });
    expect(result.structuredContent).toEqual({ ok: true });
  });
});

describe("httpExecutor header records with keys Object.entries skips", () => {
  it.each([
    ["a non-enumerable authorization", () => Object.defineProperty({}, "authorization", { value: `Bearer ${operatorToken}`, enumerable: false }), 'httpExecutor headers entry "authorization" is not enumerable'],
    ["a symbol key", () => ({ [Symbol("authorization")]: `Bearer ${operatorToken}` }), "httpExecutor headers has a symbol key"],
  ])("refuses %s, sending nothing, from a function or as the option", async (_label, make, message) => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const failure = await execute(
      httpExecutor<Context>({ baseUrl: api.origin, headers: () => make() as Record<string, string>, fetch }),
      operationOf("getItem"),
      { path: { id: "1" } },
    ).catch((error: Error) => error);
    expect(failure).not.toBeInstanceOf(McpFnError);
    expect((failure as Error).message).toBe(message);
    expect(() => httpExecutor({ baseUrl: api.origin, headers: make() as Record<string, string>, fetch })).toThrow(message);
    expect(urls).toEqual([]);
  });
});

describe("httpExecutor default responses", () => {
  const item = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
  const catalog = (defaultResponse: Record<string, unknown>, reply: () => Response) =>
    fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "default-response", version: "1.0.0" },
        paths: {
          "/item": {
            post: {
              operationId: "create",
              responses: {
                "200": { description: "Done", content: { "application/json": { schema: item } } },
                default: defaultResponse,
              },
            },
          },
        },
      },
      { executor: httpExecutor({ baseUrl: api.origin, fetch: (async () => reply()) as typeof globalThis.fetch }), allowMutations: true },
    );

  it("publishes no output schema when default allows another body, so a conforming 201 it covers succeeds", async () => {
    const other = { type: "object", required: ["message"], properties: { message: { type: "string" } } };
    const body = '{"message":"created"}';
    const { registry, tools } = catalog({ description: "Other", content: { "application/json": { schema: other } } }, () =>
      new Response(body, { status: 201, headers: { "content-type": "application/json" } }),
    );
    expect(tools[0]!.outputSchema).toBeUndefined();
    await expect(registry.callTool("create", {}, undefined, requestExtra())).resolves.toEqual({ content: [{ type: "text", text: body }] });
  });

  it("publishes no output schema when default documents no body, so a bodyless 201 succeeds", async () => {
    const { registry, tools } = catalog({ description: "Anything" }, () => new Response(null, { status: 201 }));
    expect(tools[0]!.outputSchema).toBeUndefined();
    await expect(registry.callTool("create", {}, undefined, requestExtra())).resolves.toEqual({
      content: [{ type: "text", text: "The API responded with HTTP 201 and no body." }],
    });
  });

  it.each([204, 205])(
    "publishes no output schema when default offers the same JSON schema, so a bodyless %i it covers succeeds",
    async (status) => {
      const { registry, tools } = catalog({ description: "Same", content: { "application/json": { schema: item } } }, () =>
        new Response(null, { status }),
      );
      expect(tools[0]!.outputSchema).toBeUndefined();
      const result = await registry.callTool("create", {}, undefined, requestExtra());
      expect(result).toEqual({ content: [{ type: "text", text: `The API responded with HTTP ${status} and no body.` }] });
    },
  );

  it("returns a same-schema 201 that default covers as text, since no output schema is published", async () => {
    const body = '{"id":"item-1"}';
    const { registry, tools } = catalog({ description: "Same", content: { "application/json": { schema: item } } }, () =>
      new Response(body, { status: 201, headers: { "content-type": "application/json" } }),
    );
    expect(tools[0]!.outputSchema).toBeUndefined();
    await expect(registry.callTool("create", {}, undefined, requestExtra())).resolves.toEqual({ content: [{ type: "text", text: body }] });
  });
});

describe("httpExecutor 2XX ranges", () => {
  it("publishes no output schema for a 2XX range, so a 204 it covers is a plain success", async () => {
    const replies: Array<[number, string | null]> = [
      [204, null],
      [200, '{"id":"item-1"}'],
    ];
    const { registry, tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "ranges", version: "1.0.0" },
        paths: {
          "/range": {
            put: {
              operationId: "putRange",
              responses: { "2XX": { description: "Done", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
            },
          },
          "/exact": {
            put: {
              operationId: "putExact",
              responses: { "200": { description: "Done", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
            },
          },
        },
      },
      {
        executor: httpExecutor({
          baseUrl: api.origin,
          fetch: (async () => {
            const [status, body] = replies.shift()!;
            return new Response(body, { status, headers: body === null ? {} : { "content-type": "application/json" } });
          }) as typeof globalThis.fetch,
        }),
        allowMutations: true,
      },
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("putRange")!.outputSchema).toBeUndefined();
    expect(byName.get("putExact")!.outputSchema).toBeDefined();
    await expect(registry.callTool("putRange", {}, undefined, requestExtra())).resolves.toEqual({
      content: [{ type: "text", text: "The API responded with HTTP 204 and no body." }],
    });
    await expect(registry.callTool("putRange", {}, undefined, requestExtra())).resolves.toEqual({ content: [{ type: "text", text: '{"id":"item-1"}' }] });
  });
});

describe("httpExecutor number spellings of a credential", () => {
  // An all-digit credential, and bodies that spell the same value as a number only inside strings or verbatim text.
  const headers = { "x-api-key": "12345678901234" };

  it("returns text and strings as written, and withholds only a JSON number it would return canonicalized", async () => {
    const reply = (body: string, status = 200) => stubFetch(() => new Response(body, { status, headers: { "content-type": "application/json" } })).fetch;
    const run = (body: string, hasOutputSchema: boolean, status?: number) =>
      execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: reply(body, status) }), operationOf("echo"), {}, { hasOutputSchema });
    await expect(run('{"note":"1.2345678901234e13"}', false)).resolves.toEqual({ content: [{ type: "text", text: '{"note":"1.2345678901234e13"}' }] });
    await expect(run('{"note":"1.2345678901234e13"}', true)).resolves.toMatchObject({ structuredContent: { note: "1.2345678901234e13" } });
    expect(text(await run("code 1.2345678901234e13", false, 500))).toBe("The API responded with HTTP 500.\n\ncode 1.2345678901234e13");
    const structured = await run('{"seen":1.2345678901234e13}', true);
    expect(structured.isError).toBe(true);
    expect(text(structured)).toContain("reveals an operator credential and was withheld");
  });
});

describe("httpExecutor security objects that are not plain records", () => {
  it("skips an operation whose requirement is a class instance or whose apiKey name its location cannot carry", () => {
    const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "records", version: "1.0.0" },
        components: {
          securitySchemes: {
            headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
            emptyName: { type: "apiKey", in: "header", name: "" },
            spacedName: { type: "apiKey", in: "cookie", name: "X Api Key" },
          },
        },
        security: [{ headerKey: [] }],
        paths: {
          // Read as {} (no credential), either would replace the inherited apiKey requirement and expose X-Api-Key.
          "/map": { get: { operationId: "mapRequirement", security: [new Map()], parameters: [keyParameter], responses: ok } },
          "/date": { get: { operationId: "dateRequirement", security: [new Date()], parameters: [keyParameter], responses: ok } },
          "/empty-name": { get: { operationId: "emptyName", security: [{ emptyName: [] }], responses: ok } },
          "/spaced-name": { get: { operationId: "spacedName", security: [{ spacedName: [] }], responses: ok } },
          "/inherited": { get: { operationId: "inherited", parameters: [keyParameter], responses: ok } },
        },
      },
      { executor: httpExecutor({ baseUrl: api.origin, headers: { "x-api-key": operatorToken } }) },
    );
    expect(tools.map((tool) => [tool.name, Object.keys((tool.inputSchema.properties ?? {}) as object)])).toEqual([["inherited", []]]);
    expect(skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["mapRequirement", "unsupported-by-executor", "its security cannot be read: the operation's security has a requirement that is not a plain object"],
      ["dateRequirement", "unsupported-by-executor", "its security cannot be read: the operation's security has a requirement that is not a plain object"],
      ["emptyName", "unsupported-by-executor", 'the apiKey security scheme "emptyName" has no usable name and location'],
      ["spacedName", "unsupported-by-executor", 'the apiKey security scheme "spacedName" has no usable name and location'],
    ]);
  });
});

describe("httpExecutor bodies whose declared encoding does not match their bytes", () => {
  const headers = { authorization: `Bearer ${operatorToken}` };
  const run = (body: BodyInit, status: number, contentType: string) =>
    execute(
      httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: stubFetch(() => new Response(body, { status, headers: { "content-type": contentType } })).fetch }),
      operationOf("echo"),
    );

  it.each([
    // ASCII bytes read as UTF-16LE are CJK text that encodes back to the credential.
    ["ASCII declared utf-16le", Buffer.from(`seen ${operatorToken}!`), "text/plain; charset=utf-16le"],
    ["ASCII behind a UTF-16LE byte order mark", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`seen ${operatorToken}!`)]), "text/plain"],
    ["UTF-16LE at an odd offset, declared utf-16le", Buffer.concat([Buffer.from("x"), Buffer.from(`seen ${operatorToken}`, "utf16le")]), "text/plain; charset=utf-16le"],
    ["UTF-16BE declared utf-8", Buffer.from(`seen ${operatorToken}`, "utf16le").swap16(), "text/plain; charset=utf-8"],
  ])("withholds a credential echoed as %s, success and error", async (_label, body, contentType) => {
    const success = await run(body, 200, contentType);
    expect(success.isError).toBe(true);
    expect(text(success)).toContain("reveals an operator credential and was withheld");
    expect(text(await run(body, 500, contentType))).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
  });

  it("reads charset only as a parameter, never from inside a quoted value", async () => {
    // Split at every ";", the quoted profile would name utf-16le and hide the UTF-8 echo.
    const contentType = 'text/plain; profile="a;charset=utf-16le"';
    const success = await run(`seen ${operatorToken}`, 200, contentType);
    expect(text(success)).toContain("reveals an operator credential and was withheld");
    expect(text(await run(`seen ${operatorToken}`, 500, contentType))).toBe("The API responded with HTTP 500.\n\nseen [REDACTED]");
    await expect(run("hello", 200, contentType)).resolves.toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it.each([['text/plain; charset="utf-8'], ["text/plain; charset"], ["text"], ["text/plain; charset=utf-8; charset=utf-16le"]])(
    "withholds a body whose Content-Type %s cannot be parsed",
    async (contentType) => {
      expect(text(await run("hello", 200, contentType))).toBe(
        "The API responded with HTTP 200, so the call succeeded, but its body is in a character encoding that cannot be determined or decoded and was withheld.",
      );
      expect(text(await run("hello", 500, contentType))).toBe("The API responded with HTTP 500.\n[body withheld: its character encoding cannot be determined or decoded]");
    },
  );
});

describe("httpExecutor JSON numbers that parse to a credential", () => {
  // An all-digit credential the JSON number 1.2345678901234e13 parses to.
  const headers = { "x-api-key": "12345678901234" };
  const run = (body: string, status: number) =>
    execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        headers,
        fetch: stubFetch(() => new Response(body, { status, headers: { "content-type": "application/json" } })).fetch,
      }),
      operationOf("echo"),
    );

  it("withholds a text success and an error excerpt whose JSON number parses to the credential, and keeps strings", async () => {
    const success = await run('{"seen":1.2345678901234e13}', 200);
    expect(success.isError).toBe(true);
    expect(text(success)).toContain("reveals an operator credential and was withheld");
    expect(text(await run('{"seen":1.2345678901234e13}', 500))).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
    await expect(run('{"note":"1.2345678901234e13"}', 200)).resolves.toEqual({ content: [{ type: "text", text: '{"note":"1.2345678901234e13"}' }] });
    expect(text(await run('{"note":"1.2345678901234e13"}', 500))).toBe('The API responded with HTTP 500.\n\n{"note":"1.2345678901234e13"}');
  });

  it("still redacts a literal echo in a JSON error body", async () => {
    expect(text(await run('{"error":"bad key 12345678901234"}', 500))).toBe('The API responded with HTTP 500.\n\n{"error":"bad key [REDACTED]"}');
  });
});

describe("httpExecutor explicit 204 and 205 entries", () => {
  it("publishes no output schema when a 204 entry declares JSON content", () => {
    const content = { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } };
    const { tools } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "bodyless", version: "1.0.0" },
        paths: { "/item": { put: { operationId: "putItem", responses: { "200": { description: "Done", content }, "204": { description: "Done", content } } } } },
      },
      { executor: httpExecutor({ baseUrl: api.origin }), allowMutations: true },
    );
    expect(tools[0]!.outputSchema).toBeUndefined();
  });
});

describe("httpExecutor security objects structuredClone would flatten", () => {
  it("skips an operation whose requirement or scheme is a class instance, though cloning would make it a plain object", () => {
    class Requirement {}
    class Scheme {
      type = "apiKey";
      in = "header";
      name = "X-Api-Key";
    }
    const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
    const { tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "instances", version: "1.0.0" },
        components: { securitySchemes: { headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" }, instanceKey: new Scheme() } },
        security: [{ headerKey: [] }],
        paths: {
          // Cloned, the instance reads as {} (no credential) and would expose the inherited X-Api-Key as an input.
          "/requirement": { get: { operationId: "instanceRequirement", security: [new Requirement()], parameters: [keyParameter], responses: ok } },
          "/scheme": { get: { operationId: "instanceScheme", security: [{ instanceKey: [] }], parameters: [keyParameter], responses: ok } },
          "/inherited": { get: { operationId: "inherited", parameters: [keyParameter], responses: ok } },
        },
      },
      { executor: httpExecutor({ baseUrl: api.origin, headers: { "x-api-key": operatorToken } }) },
    );
    expect(tools.map((tool) => [tool.name, Object.keys((tool.inputSchema.properties ?? {}) as object)])).toEqual([["inherited", []]]);
    expect(skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["instanceRequirement", "unsupported-by-executor", "its security cannot be read: the operation's security has a requirement that is not a plain object"],
      [
        "instanceScheme",
        "unsupported-by-executor",
        'the security scheme "instanceKey" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown',
      ],
    ]);
  });
});

describe("httpExecutor security levels reached through an accessor", () => {
  class EmptyRequirement {}
  const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
  const scheme = { type: "apiKey", in: "header", name: "X-Api-Key" };
  let reads = 0;
  // An enumerable getter that would give one value to the first read (structuredClone) and another to every later one.
  const flipping = <T extends object>(holder: T, key: string, first: () => unknown, later: () => unknown): T =>
    Object.defineProperty(holder, key, { enumerable: true, configurable: true, get: (() => { let own = 0; return () => { reads += 1; return ++own === 1 ? first() : later(); }; })() });
  const operation = (security?: unknown) => ({
    operationId: "keyed",
    ...(security === undefined ? {} : { security }),
    parameters: [keyParameter],
    responses: ok,
  });
  const documentWith = (fields: { security?: unknown; paths?: unknown; components?: unknown; [extension: `x-${string}`]: unknown }) => ({
    openapi: "3.1.0",
    info: { title: "accessors", version: "1.0.0" },
    components: { securitySchemes: { headerKey: scheme } },
    security: [{ headerKey: [] }],
    ...fields,
  });
  const getterValue = "test-getter-value";
  // A getter that rewrites the operation's security to [{}] (no credential) when it runs.
  const rewriting = (target: { security?: unknown }) => () => {
    reads += 1;
    target.security = [{}];
    return getterValue;
  };
  const withGetter = <T extends object>(holder: T, key: string, get: () => unknown): T =>
    Object.defineProperty(holder, key, { enumerable: true, configurable: true, get });

  const cases: [string, () => object, string][] = [
    [
      "the operation's security",
      () => documentWith({ paths: { "/keyed": { get: flipping(operation(), "security", () => [new EmptyRequirement()], () => [{}]) } } }),
      '$.paths["/keyed"].get.security',
    ],
    [
      "the document's security, inherited",
      () => flipping(documentWith({ paths: { "/keyed": { get: operation() } } }), "security", () => [new EmptyRequirement()], () => [{}]),
      "$.security",
    ],
    [
      "the operation object",
      () => documentWith({ paths: { "/keyed": flipping({}, "get", () => operation([new EmptyRequirement()]), () => operation([{}])) } }),
      '$.paths["/keyed"].get',
    ],
    [
      "the path item",
      () => documentWith({ paths: flipping({}, "/keyed", () => ({ get: operation([new EmptyRequirement()]) }), () => ({ get: operation([{}]) })) }),
      '$.paths["/keyed"]',
    ],
    [
      "the paths object",
      () => flipping(documentWith({}), "paths", () => ({ "/keyed": { get: operation([new EmptyRequirement()]) } }), () => ({ "/keyed": { get: operation([{}]) } })),
      "$.paths",
    ],
    [
      "a security scheme",
      () =>
        documentWith({
          components: { securitySchemes: flipping({}, "headerKey", () => Object.assign(new (class Scheme {})(), scheme), () => scheme) },
          paths: { "/keyed": { get: operation() } },
        }),
      "$.components.securitySchemes.headerKey",
    ],
    [
      "an operation description that rewrites the operation's security",
      () => {
        const keyed = operation([{ headerKey: [] }]);
        return documentWith({ paths: { "/keyed": { get: withGetter(keyed, "description", rewriting(keyed)) } } });
      },
      '$.paths["/keyed"].get.description',
    ],
    [
      "a document extension that rewrites an operation's security while the document is copied",
      () => {
        const keyed = operation([{ headerKey: [] }]);
        return withGetter(documentWith({ paths: { "/keyed": { get: keyed } } }), "x-hook", rewriting(keyed));
      },
      '$["x-hook"]',
    ],
    [
      "a getter inside a Map entry value",
      () => {
        const keyed = operation([{ headerKey: [] }]);
        return documentWith({ paths: { "/keyed": { get: keyed } }, "x-map": new Map([["entry", withGetter({}, "hook", rewriting(keyed))]]) });
      },
      '$["x-map"]["<map value 0>"].hook',
    ],
    [
      "a getter inside a Set entry",
      () => {
        const keyed = operation([{ headerKey: [] }]);
        return documentWith({ paths: { "/keyed": { get: keyed } }, "x-set": new Set([withGetter({}, "hook", rewriting(keyed))]) });
      },
      '$["x-set"]["<set entry 0>"].hook',
    ],
    [
      // structuredClone copies a Map by its brand, whatever its prototype.
      "a getter inside a Map whose prototype is Object.prototype",
      () => {
        const keyed = operation([{ headerKey: [] }]);
        const map = Object.setPrototypeOf(new Map([["entry", withGetter({}, "hook", rewriting(keyed))]]), Object.prototype) as object;
        return documentWith({ paths: { "/keyed": { get: keyed } }, "x-map": map });
      },
      '$["x-map"]["<map value 0>"].hook',
    ],
    [
      "a getter inside a Set with no prototype",
      () => {
        const keyed = operation([{ headerKey: [] }]);
        const set = Object.setPrototypeOf(new Set([withGetter({}, "hook", rewriting(keyed))]), null) as object;
        return documentWith({ paths: { "/keyed": { get: keyed } }, "x-set": set });
      },
      '$["x-set"]["<set entry 0>"].hook',
    ],
  ];

  it.each(cases)("refuses the document when %s is an accessor, running no getter and naming no value", (_where, document, path) => {
    for (const executor of [httpExecutor({ baseUrl: api.origin, headers: { "x-api-key": operatorToken } }), { execute: () => ({ content: [] }) }]) {
      const built = document();
      reads = 0;
      let thrown: unknown;
      try {
        fromOpenAPI(built, { executor });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpFnValidationError);
      const error = thrown as McpFnValidationError;
      expect(error.message).toBe("fromOpenAPI expects a plain JSON document");
      expect(error.details).toEqual({ cause: `${path} is an accessor property` });
      expect(reads).toBe(0);
      const reported = JSON.stringify({ message: error.message, details: error.details });
      expect(reported).not.toContain(getterValue);
      expect(reported).not.toContain(operatorToken);
    }
  });

  it("leaves Error.stackTraceLimit as it was, and the refusal keeps its stack", () => {
    const limit = Error.stackTraceLimit;
    const executor = { execute: () => ({ content: [] }) };
    expect(fromOpenAPI(documentWith({ paths: { "/keyed": { get: operation() } }, "x-map": new Map([["a", {}]]) }), { executor }).tools).toHaveLength(1);
    expect(Error.stackTraceLimit).toBe(limit);
    let thrown: unknown;
    try {
      fromOpenAPI(withGetter(documentWith({ paths: { "/keyed": { get: operation() } } }), "x-hook", () => 1), { executor });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpFnValidationError);
    expect((thrown as Error).stack).toMatch(/\n\s+at /);
    expect(Error.stackTraceLimit).toBe(limit);
  });

  it("walks aliased and cyclic objects once and still finds an accessor behind them", () => {
    const shared: Record<string, unknown> = { type: "object" };
    shared.self = shared;
    const document = documentWith({ paths: { "/keyed": { get: operation() } }, "x-a": shared, "x-b": [shared, shared] });
    expect(fromOpenAPI(document, { executor: { execute: () => ({ content: [] }) } }).tools).toHaveLength(1);
    reads = 0;
    withGetter(shared, "late", () => (reads += 1));
    expect(() => fromOpenAPI(document, { executor: { execute: () => ({ content: [] }) } })).toThrow("fromOpenAPI expects a plain JSON document");
    expect(reads).toBe(0);
  });
});

describe("httpExecutor security that structuredClone would drop", () => {
  // Operator headers carry only authorization, so a caller value in X-Api-Key would reach the upstream.
  const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
  const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
  const hidden = <T extends object>(holder: T, key: string, value: unknown): T =>
    Object.defineProperty(holder, key, { value, enumerable: false, configurable: true, writable: true });
  const operation = () => ({ operationId: "keyed", parameters: [keyParameter], responses: ok });
  const documentWith = (get: object, security?: unknown) => ({
    openapi: "3.1.0",
    info: { title: "hidden security", version: "1.0.0" },
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
    ...(security === undefined ? {} : { security }),
    paths: { "/keyed": { get } },
  });
  const notPlain = (where: string) => `its security cannot be read: ${where} security has a requirement that is not a plain object`;
  class KeyedOperation {
    operationId = "keyed";
    parameters = [keyParameter];
    responses = ok;
    get security() {
      return [{ k: [] }];
    }
  }
  const variants: [string, () => object, string][] = [
    ["a requirement with a non-enumerable key", () => documentWith({ ...operation(), security: [hidden({}, "k", [])] }), notPlain("the operation's")],
    ["a non-enumerable operation security", () => documentWith(hidden(operation(), "security", [{ k: [] }])), notPlain("the operation's")],
    [
      "a non-enumerable document security an operation inherits",
      () => hidden(documentWith(operation()), "security", [{ k: [] }]),
      notPlain("the document's"),
    ],
    [
      "an operation that inherits its security",
      () => documentWith(Object.assign(Object.create({ security: [{ k: [] }] }) as object, operation())),
      notPlain("the operation's"),
    ],
    ["an operation whose security is a prototype getter", () => documentWith(new KeyedOperation()), notPlain("the operation's")],
  ];

  it.each(variants)("skips the operation for %s, never exposing the credential header as input", async (_variant, document, reason) => {
    const before = api.received.length;
    const { tools, skipped } = fromOpenAPI(document(), { executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) });
    expect(tools).toEqual([]);
    expect(skipped.map(({ operation: skippedOperation, code, reason: why }) => [skippedOperation.operationId, code, why])).toEqual([
      ["keyed", "unsupported-by-executor", reason],
    ]);
    expect(api.received.length).toBe(before);
  });

  it.each([variants[1]!, variants[3]!])(
    "lists %s with securityUnresolved under an executor that does not check security, and httpExecutor refuses it before any request",
    async (_variant, document) => {
      const { tools } = fromOpenAPI(document(), { executor: { execute: () => ({ content: [] }) } });
      expect(tools[0]!.operation.securityUnresolved).toBe("the operation's security has a requirement that is not a plain object");
      const before = api.received.length;
      const result = await httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }).execute({
        operation: tools[0]!.operation,
        args: { header: { "X-Api-Key": "test-caller-value" } },
        context: undefined,
        signal: new AbortController().signal,
        hasOutputSchema: false,
      });
      expect(result.isError).toBe(true);
      expect(api.received.length).toBe(before);
    },
  );

  it("leaves a scheme with a non-enumerable $ref unresolved, while an enumerable $ref still resolves to the apiKey scheme", async () => {
    const withScheme = (k: object) => ({
      ...documentWith({ ...operation(), security: [{ k: [] }] }),
      components: { securitySchemes: { k, key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
    });
    const ref = "#/components/securitySchemes/key";
    const before = api.received.length;
    const hiddenRef = fromOpenAPI(withScheme(hidden({ type: "http", scheme: "bearer" }, "$ref", ref)), {
      executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }),
    });
    expect(hiddenRef.tools).toEqual([]);
    expect(hiddenRef.skipped.map(({ operation: skippedOperation, code, reason }) => [skippedOperation.operationId, code, reason])).toEqual([
      ["keyed", "unsupported-by-executor", 'the security scheme "k" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown'],
    ]);
    expect(api.received.length).toBe(before);
    const shownRef = fromOpenAPI(withScheme({ type: "http", scheme: "bearer", $ref: ref }), {
      executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }),
    });
    expect(shownRef.tools.map((tool) => Object.keys((tool.inputSchema.properties ?? {}) as object))).toEqual([[]]);
  });

  it("keeps plain security as before: [{ k: [] }] strips the header input, [{}] and [] leave it", () => {
    const listed = (security: unknown) =>
      fromOpenAPI(documentWith({ ...operation(), security }), { executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) }).tools.map(
        (tool) => Object.keys((tool.inputSchema.properties ?? {}) as object),
      );
    expect(listed([{ k: [] }])).toEqual([[]]);
    expect(listed([{}])).toEqual([["header"]]);
    expect(listed([])).toEqual([["header"]]);
  });
});

describe("httpExecutor security of a document built in another realm", () => {
  it("reads another realm's plain objects as plain, so their security resolves as before cloning", () => {
    const realmDocument = runInNewContext(`({
      openapi: "3.1.0",
      info: { title: "realm", version: "1.0.0" },
      components: { securitySchemes: { headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
      paths: {
        "/realm": {
          get: {
            operationId: "realm",
            security: [{ headerKey: [] }],
            parameters: [{ name: "X-Api-Key", in: "header", schema: { type: "string" } }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    })`) as object;
    const { tools, skipped } = fromOpenAPI(realmDocument, { executor: httpExecutor({ baseUrl: api.origin, headers: { "x-api-key": operatorToken } }) });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => [tool.name, Object.keys((tool.inputSchema.properties ?? {}) as object)])).toEqual([["realm", []]]);
  });
});

describe("httpExecutor documents read once, each property by its descriptor", () => {
  // Operator headers carry only authorization, so a caller value in X-Api-Key would reach the upstream.
  const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
  const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
  const notPlain = "the operation's security has a requirement that is not a plain object";
  const trivial = { execute: () => ({ content: [] }) };
  class Unplain {}
  let runs = 0;
  // Operator code that, if it ran, would rewrite the operation's security to [{}] (no credential).
  const rewrite = (operation: { security?: unknown }) => {
    runs += 1;
    operation.security = [{}];
  };
  const unplainOperation = () => ({ operationId: "keyed", security: [new Unplain()] as unknown[], parameters: [keyParameter], responses: ok });
  const keyedOperation = () => ({ operationId: "keyed", security: [{ k: [] }] as unknown[], parameters: [keyParameter], responses: ok });
  const documentWith = (operation: object, extensions: Record<`x-${string}`, unknown> = {}): Record<string, unknown> => ({
    openapi: "3.1.0",
    info: { title: "read once", version: "1.0.0" },
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
    paths: { "/keyed": { get: operation } },
    ...extensions,
  });
  const inputs = (tools: { inputSchema: { properties?: unknown } }[]) => tools.map((tool) => Object.keys((tool.inputSchema.properties ?? {}) as object));

  it("never runs an Error's prototype name getter, so a requirement that is not a plain object stays unresolved", () => {
    const build = () => {
      const operation = unplainOperation();
      const error = new Error("test-error");
      delete (error as { stack?: unknown }).stack;
      Object.setPrototypeOf(
        error,
        Object.create(Error.prototype, { name: { configurable: true, get: () => (rewrite(operation), "Error") } }) as object,
      );
      return documentWith(operation, { "x-z": error });
    };
    runs = 0;
    const listed = fromOpenAPI(build(), { executor: trivial });
    expect(listed.tools.map((tool) => tool.operation.securityUnresolved)).toEqual([notPlain]);
    const before = api.received.length;
    const sent = fromOpenAPI(build(), { executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) });
    expect(sent.tools).toEqual([]);
    expect(sent.skipped.map(({ code, reason }) => [code, reason])).toEqual([["unsupported-by-executor", `its security cannot be read: ${notPlain}`]]);
    expect(api.received.length).toBe(before);
    expect(runs).toBe(0);
  });

  it("refuses a Proxy before any of its traps runs", () => {
    let traps = 0;
    const build = () => {
      const operation = keyedOperation();
      const document = documentWith(operation);
      // Its trap would plant a getter on the operation, then remove itself.
      (document.info as Record<string, unknown>)["x-p"] = new Proxy(
        {},
        {
          ownKeys: (target) => {
            traps += 1;
            Object.defineProperty(operation, "description", { enumerable: true, configurable: true, get: () => (rewrite(operation), "d") });
            return Reflect.ownKeys(target);
          },
        },
      );
      return document;
    };
    for (const executor of [httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), trivial]) {
      runs = 0;
      traps = 0;
      let thrown: unknown;
      try {
        fromOpenAPI(build(), { executor });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpFnValidationError);
      expect((thrown as McpFnValidationError).message).toBe("fromOpenAPI expects a plain JSON document");
      expect((thrown as McpFnValidationError).details).toEqual({ cause: '$.info["x-p"] is a Proxy' });
      expect([traps, runs]).toEqual([0, 0]);
    }
  });

  it("reads a Proxy once through its traps where the runtime cannot detect one, so a trap cannot change what was checked", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
    Object.defineProperty(process, "getBuiltinModule", { value: undefined, configurable: true, writable: true });
    let reloaded: typeof import("../src/openapi/index.js");
    try {
      vi.resetModules();
      reloaded = await import("../src/openapi/index.js");
    } finally {
      if (descriptor) Object.defineProperty(process, "getBuiltinModule", descriptor);
      else delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;
      vi.resetModules();
    }
    let traps = 0;
    const build = () => {
      const operation = unplainOperation();
      const document = documentWith(operation);
      (document.info as Record<string, unknown>)["x-p"] = new Proxy(
        {},
        {
          ownKeys: (target) => {
            traps += 1;
            // Planted on an operation already copied: the copy never reads it.
            Object.defineProperty(operation, "description", { enumerable: true, configurable: true, get: () => (rewrite(operation), "d") });
            operation.security = [{}];
            return Reflect.ownKeys(target);
          },
        },
      );
      return document;
    };
    runs = 0;
    traps = 0;
    const listed = reloaded.fromOpenAPI(build(), { executor: trivial });
    expect(listed.tools.map((tool) => tool.operation.securityUnresolved)).toEqual([notPlain]);
    const before = api.received.length;
    const sent = reloaded.fromOpenAPI(build(), { executor: reloaded.httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) });
    expect(sent.tools).toEqual([]);
    expect(api.received.length).toBe(before);
    expect([traps, runs]).toEqual([2, 0]);
  });

  const mutating: [string, (operation: { security?: unknown }) => unknown][] = [
    [
      "a Date with its own toString, valueOf, toJSON and Symbol.toPrimitive",
      (operation) =>
        // Date.prototype's Symbol.toPrimitive is read-only, so it is defined, not assigned.
        Object.defineProperty(
          Object.assign(new Date(0), { toString: () => rewrite(operation), valueOf: () => rewrite(operation), toJSON: () => rewrite(operation) }),
          Symbol.toPrimitive,
          { value: () => rewrite(operation), enumerable: true },
        ),
    ],
    [
      "a Date subclass whose prototype overrides getTime",
      (operation) =>
        new (class extends Date {
          override getTime() {
            rewrite(operation);
            return 0;
          }
        })(0),
    ],
    [
      "a Map subclass whose prototype overrides size, forEach, entries and its iterator",
      (operation) =>
        new (class extends Map<string, object> {
          override get size() {
            rewrite(operation);
            return 0;
          }
          override forEach() {
            rewrite(operation);
          }
          override entries() {
            rewrite(operation);
            return super.entries();
          }
          override [Symbol.iterator]() {
            rewrite(operation);
            return super[Symbol.iterator]();
          }
        })([["entry", {}]]),
    ],
    [
      "a Set subclass whose prototype overrides size, forEach, values and its iterator",
      (operation) =>
        new (class extends Set<object> {
          override get size() {
            rewrite(operation);
            return 0;
          }
          override forEach() {
            rewrite(operation);
          }
          override values() {
            rewrite(operation);
            return super.values();
          }
          override [Symbol.iterator]() {
            rewrite(operation);
            return super[Symbol.iterator]();
          }
        })([{}]),
    ],
    [
      "a typed array whose prototype overrides buffer, byteOffset, byteLength and length",
      (operation) => {
        const bytes = new Uint8Array([1, 2, 3]);
        const getter = { configurable: true, get: () => (rewrite(operation), 0) };
        Object.setPrototypeOf(
          bytes,
          Object.create(Uint8Array.prototype, { buffer: getter, byteOffset: getter, byteLength: getter, length: getter }) as object,
        );
        return bytes;
      },
    ],
    [
      "an Error whose prototype has name and message getters",
      (operation) => {
        const error = new Error("test-error");
        delete (error as { stack?: unknown }).stack;
        delete (error as { message?: unknown }).message;
        const getter = { configurable: true, get: () => (rewrite(operation), "Error") };
        return Object.setPrototypeOf(error, Object.create(Error.prototype, { name: getter, message: getter })) as object;
      },
    ],
  ];

  it.each(mutating)("copies %s without running its code, keeping the operation's security", (_label, value) => {
    for (const executor of [httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), trivial]) {
      const operation = keyedOperation();
      runs = 0;
      const { tools, skipped } = fromOpenAPI(documentWith(operation, { "x-value": value(operation) }), { executor });
      expect(skipped).toEqual([]);
      // The apiKey requirement holds, so X-Api-Key is not caller input.
      expect(inputs(tools)).toEqual([[]]);
      expect(runs).toBe(0);
    }
  });

  it("refuses a function or a symbol anywhere, naming the path and no value", () => {
    for (const [value, cause] of [
      [() => operatorToken, '$["x-value"].hook is a function'],
      [Symbol(operatorToken), '$["x-value"].hook is a symbol'],
    ] as const) {
      let thrown: unknown;
      try {
        fromOpenAPI(documentWith(keyedOperation(), { "x-value": { hook: value } }), { executor: trivial });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpFnValidationError);
      expect((thrown as McpFnValidationError).details).toEqual({ cause });
      expect(JSON.stringify((thrown as McpFnValidationError).details)).not.toContain(operatorToken);
    }
  });

  it("keeps sharing, cycles and holes as structuredClone would", () => {
    const shared: Record<string, unknown> = { type: "object" };
    shared.self = shared;
    const sparse: unknown[] = [];
    sparse[3] = { k: [] };
    const operation = { ...keyedOperation(), security: sparse };
    const document = documentWith(operation, { "x-a": shared, "x-b": [shared, shared] });
    const { tools, skipped } = fromOpenAPI(document, { executor: trivial });
    // A level with holes is not read as a list of requirements.
    expect(tools).toEqual([]);
    expect(skipped.map(({ code, reason }) => [code, reason])).toEqual([["invalid-operation", "an array has holes or own keys other than its indices"]]);
    expect(fromOpenAPI(documentWith(keyedOperation(), { "x-a": shared, "x-b": [shared, shared] }), { executor: trivial }).tools).toHaveLength(1);
  });
});

describe("httpExecutor objects with internal slots, whatever their prototype", () => {
  // Operator headers carry only authorization, so a caller value in X-Api-Key would reach the upstream.
  const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
  const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
  const trivial = { execute: () => ({ content: [] }) };
  const notPlain = "the operation's security has a requirement that is not a plain object";
  const scheme = { type: "apiKey", in: "header", name: "X-Api-Key" };
  const documentWith = (operation: object, schemes: object = { k: { ...scheme } }): Record<string, unknown> => ({
    openapi: "3.1.0",
    info: { title: "branded", version: "1.0.0" },
    components: { securitySchemes: schemes },
    paths: { "/keyed": { get: operation } },
  });
  const operationFields = () => ({ operationId: "keyed", security: [{ k: [] }] as unknown[], parameters: [keyParameter], responses: ok });
  const inputs = (tools: { inputSchema: { properties?: unknown } }[]) => tools.map((tool) => Object.keys((tool.inputSchema.properties ?? {}) as object));
  /** `value` with a null prototype and, for an Error, no own stack or message, so only its slots set it apart from Object.create(null). */
  const bare = (value: object): object => {
    if (value instanceof Error) {
      delete (value as { stack?: unknown }).stack;
      delete (value as { message?: unknown }).message;
    }
    return Object.setPrototypeOf(value, null) as object;
  };
  const copied: [string, () => object][] = [
    ["a DataView", () => new DataView(new ArrayBuffer(1))],
    ["an ArrayBuffer", () => new ArrayBuffer(1)],
    ["a Boolean object", () => Object(false) as object],
    ["a Number object", () => Object(1) as object],
    ["a RegExp", () => /a/],
    ["an Error", () => new Error("test-error")],
  ];
  const refused: [string, () => object][] = [
    ["a WeakMap", () => new WeakMap()],
    ["a Promise", () => Promise.resolve()],
  ];
  type Listed = ReturnType<typeof fromOpenAPI>;
  // Under a trivial executor, a requirement or operation that is not plain is reported as securityUnresolved, and a scheme that is not plain is left out of securitySchemes.
  const unresolvedSecurity = (listed: Listed) => expect(listed.tools.map((tool) => tool.operation.securityUnresolved)).toEqual([notPlain]);
  const unresolvedScheme = (listed: Listed) =>
    expect(listed.tools.map((tool) => [tool.operation.security, tool.operation.securitySchemes, tool.operation.securityUnresolved])).toEqual([[[{ k: [] }], undefined, undefined]]);
  const placements: [string, (make: () => object) => { document: Record<string, unknown>; path: string }, (listed: Listed) => void][] = [
    [
      "a requirement in the operation's level",
      (make) => ({ document: documentWith({ ...operationFields(), security: [bare(make())] }), path: '$.paths["/keyed"].get.security["0"]' }),
      unresolvedSecurity,
    ],
    ["the operation object", (make) => ({ document: documentWith(Object.assign(bare(make()), operationFields())), path: '$.paths["/keyed"].get' }), unresolvedSecurity],
    [
      "a securitySchemes entry",
      (make) => ({ document: documentWith(operationFields(), { k: Object.assign(bare(make()), scheme) }), path: "$.components.securitySchemes.k" }),
      unresolvedScheme,
    ],
  ];
  const cases = placements.flatMap(([where, place, unresolved]) =>
    copied.map(([kind, make]): [string, string, () => Record<string, unknown>, (listed: Listed) => void] => [kind, where, () => place(make).document, unresolved]),
  );
  const refusals = placements.flatMap(([where, place]) => refused.map(([kind, make]): [string, string, () => { document: Record<string, unknown>; path: string }] => [kind, where, () => place(make)]));

  // Both results must fail closed: never listed with X-Api-Key as caller input, and never sending a request.
  const expectFailsClosed = (
    fromOpenApi: typeof fromOpenAPI,
    executorOf: () => unknown,
    build: () => Record<string, unknown>,
    unresolved: (listed: Listed) => void,
  ) => {
    unresolved(fromOpenApi(build(), { executor: trivial }));
    const before = api.received.length;
    const sent = fromOpenApi(build(), { executor: executorOf() as OpenApiExecutor });
    expect(sent.tools).toEqual([]);
    expect(sent.skipped.map(({ code }) => code)).toEqual(["unsupported-by-executor"]);
    expect(api.received.length).toBe(before);
  };

  it.each(cases)("never reads %s with a null prototype as a plain object, as %s", (_kind, _where, build, unresolved) => {
    expectFailsClosed(fromOpenAPI, () => httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), build, unresolved);
  });

  it.each(refusals)("refuses %s with a null prototype, as %s, naming the path", (_kind, _where, build) => {
    for (const executor of [httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), trivial]) {
      const { document, path } = build();
      let thrown: unknown;
      try {
        fromOpenAPI(document, { executor });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpFnValidationError);
      expect((thrown as McpFnValidationError).message).toBe("fromOpenAPI expects a plain JSON document");
      expect((thrown as McpFnValidationError).details).toEqual({ cause: `${path} is an object that cannot be copied` });
    }
  });

  it("tells the same kinds by intrinsic probes where util.types is not available", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
    Object.defineProperty(process, "getBuiltinModule", { value: undefined, configurable: true, writable: true });
    let reloaded: typeof import("../src/openapi/index.js");
    try {
      vi.resetModules();
      reloaded = await import("../src/openapi/index.js");
    } finally {
      if (descriptor) Object.defineProperty(process, "getBuiltinModule", descriptor);
      else delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;
      vi.resetModules();
    }
    // A Promise has no side-effect-free probe, and an Error one only through Error.isError.
    const probed = new Set(["a DataView", "an ArrayBuffer", "a Boolean object", "a Number object", "a RegExp"]);
    for (const [kind, , build, unresolved] of cases) {
      if (probed.has(kind)) {
        expectFailsClosed(reloaded.fromOpenAPI as typeof fromOpenAPI, () => reloaded.httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), build, unresolved);
      }
    }
    expect(() => reloaded.fromOpenAPI(documentWith({ ...operationFields(), security: [bare(new WeakMap())] }), { executor: trivial })).toThrow(
      "fromOpenAPI expects a plain JSON document",
    );
  });

  it("still reads an ordinary null-prototype requirement, operation and scheme as plain", () => {
    const requirement = Object.assign(Object.create(null) as object, { k: [] });
    const operation = Object.assign(Object.create(null) as object, { ...operationFields(), security: [requirement] });
    const schemes = { k: Object.assign(Object.create(null) as object, scheme) };
    const { tools, skipped } = fromOpenAPI(documentWith(operation, schemes), { executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) });
    expect(skipped).toEqual([]);
    // The apiKey requirement holds, so X-Api-Key is not caller input.
    expect(inputs(tools)).toEqual([[]]);
    // A genuine anonymous requirement, or no security at all, leaves X-Api-Key to the caller.
    for (const security of [[{}], []]) {
      const open = fromOpenAPI(documentWith({ ...operationFields(), security }), { executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) });
      expect(inputs(open.tools)).toEqual([["header"]]);
    }
  });

  it("copies a branded value elsewhere in the document without failing the conversion", () => {
    const document = { ...documentWith(operationFields()), "x-values": [bare(new DataView(new ArrayBuffer(1))), new ArrayBuffer(2), Object(true) as object, /x/] };
    const { tools, skipped } = fromOpenAPI(document, { executor: httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }) });
    expect(skipped).toEqual([]);
    expect(inputs(tools)).toEqual([[]]);
  });
});

describe("httpExecutor plain objects proven ordinary, never assumed", () => {
  // Operator headers carry only authorization, so a caller value in X-Api-Key would reach the upstream.
  const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
  const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
  const trivial = { execute: () => ({ content: [] }) };
  const notPlain = "the operation's security has a requirement that is not a plain object";
  const scheme = { type: "apiKey", in: "header", name: "X-Api-Key" };
  const documentWith = (fields: { documentSecurity?: unknown[]; operationSecurity?: unknown[]; scheme?: object }): Record<string, unknown> => ({
    openapi: "3.1.0",
    info: { title: "exotic", version: "1.0.0" },
    ...(fields.documentSecurity ? { security: fields.documentSecurity } : {}),
    components: { securitySchemes: { k: fields.scheme ?? { ...scheme } } },
    paths: {
      "/keyed": {
        get: {
          operationId: "keyed",
          ...(fields.operationSecurity ? { security: fields.operationSecurity } : {}),
          parameters: [keyParameter],
          responses: ok,
        },
      },
    },
  });
  const inputs = (tools: { inputSchema: { properties?: unknown } }[]) => tools.map((tool) => Object.keys((tool.inputSchema.properties ?? {}) as object));
  /** `value` with prototype `prototype` and, for a DOMException, no own stack, so it has no own key at all. */
  const withPrototype = (value: object, prototype: object | null): object => {
    delete (value as { stack?: unknown }).stack;
    return Object.setPrototypeOf(value, prototype) as object;
  };
  // Kinds no brand list names: engine iterators and Intl objects, and host objects.
  const kinds: [string, () => object][] = [
    ["an Array iterator", () => [][Symbol.iterator]()],
    ["a String iterator", () => ""[Symbol.iterator]()],
    ["a RegExp String iterator", () => "a".matchAll(/a/g)],
    ["an iterator helper", () => [1].values().map((value) => value)],
    ["an Intl.Locale", () => new Intl.Locale("en")],
    ["an Intl.Collator", () => new Intl.Collator("en")],
    ["an Intl.Segmenter", () => new Intl.Segmenter("en")],
    ["a URL", () => new URL("http://example.test/")],
    ["a Headers", () => new Headers()],
    ["a URLSearchParams", () => new URLSearchParams("a=1")],
    ["a DOMException", () => new DOMException("test-exception")],
  ];
  const prototypes: [string, () => object | null][] = [
    ["a null prototype", () => null],
    ["Object.prototype", () => Object.prototype],
  ];
  type Listed = ReturnType<typeof fromOpenAPI>;
  const unresolvedSecurity = (listed: Listed) => expect(listed.tools.map((tool) => tool.operation.securityUnresolved)).toEqual([notPlain]);
  const unresolvedDocumentSecurity = (listed: Listed) =>
    expect(listed.tools.map((tool) => tool.operation.securityUnresolved)).toEqual(["the document's security has a requirement that is not a plain object"]);
  const unresolvedScheme = (listed: Listed) =>
    expect(listed.tools.map((tool) => [tool.operation.security, tool.operation.securitySchemes, tool.operation.securityUnresolved])).toEqual([[[{ k: [] }], undefined, undefined]]);
  const placements: [string, (value: object) => Record<string, unknown>, (listed: Listed) => void][] = [
    ["an operation-level requirement", (value) => documentWith({ operationSecurity: [value] }), unresolvedSecurity],
    ["a document-level requirement", (value) => documentWith({ documentSecurity: [value] }), unresolvedDocumentSecurity],
    ["a securitySchemes entry", (value) => documentWith({ operationSecurity: [{ k: [] }], scheme: value }), unresolvedScheme],
  ];
  const cases = kinds.flatMap(([kind, make]) =>
    prototypes.flatMap(([prototype, prototypeOf]) =>
      placements.map(([where, place, unresolved]): [string, string, string, () => Record<string, unknown>, (listed: Listed) => void] => [
        kind,
        prototype,
        where,
        () => place(withPrototype(make(), prototypeOf())),
        unresolved,
      ]),
    ),
  );

  // Both results must fail closed: securityUnresolved (or the scheme left out) under a trivial executor,
  // skipped under httpExecutor, never listed with X-Api-Key as caller input and never sending a request.
  const expectFailsClosed = (
    fromOpenApi: typeof fromOpenAPI,
    executorOf: () => unknown,
    build: () => Record<string, unknown>,
    unresolved: (listed: Listed) => void,
  ) => {
    unresolved(fromOpenApi(build(), { executor: trivial }));
    const before = api.received.length;
    const sent = fromOpenApi(build(), { executor: executorOf() as OpenApiExecutor });
    expect(sent.tools).toEqual([]);
    expect(sent.skipped.map(({ code }) => code)).toEqual(["unsupported-by-executor"]);
    expect(api.received.length).toBe(before);
  };
  const withoutUtilTypes = async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
    Object.defineProperty(process, "getBuiltinModule", { value: undefined, configurable: true, writable: true });
    try {
      vi.resetModules();
      return await import("../src/openapi/index.js");
    } finally {
      if (descriptor) Object.defineProperty(process, "getBuiltinModule", descriptor);
      else delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;
      vi.resetModules();
    }
  };

  it.each(cases)("never reads %s with %s as a plain object, as %s", (_kind, _prototype, _where, build, unresolved) => {
    expectFailsClosed(fromOpenAPI, () => httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), build, unresolved);
  });

  it("fails closed on the same kinds where util.types is not available", async () => {
    const reloaded = await withoutUtilTypes();
    for (const [, , , build, unresolved] of cases) {
      expectFailsClosed(reloaded.fromOpenAPI as typeof fromOpenAPI, () => reloaded.httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), build, unresolved);
    }
  });

  /** A Proxy to use as a prototype, counting every trap it runs; its getPrototypeOf trap would make the operation anonymous. */
  const trappingPrototype = (onTrap: () => void) => {
    const traps = { count: 0 };
    const handler = new Proxy({} as ProxyHandler<object>, {
      get: (_handler, name) => (...args: unknown[]) => {
        traps.count += 1;
        onTrap();
        return name === "getPrototypeOf" ? null : (Reflect as unknown as Record<string, (...rest: unknown[]) => unknown>)[name as string]!(...args);
      },
    });
    return { prototype: new Proxy({}, handler), traps };
  };

  for (const [runtime, load] of [
    ["with util.types", async () => ({ fromOpenAPI, httpExecutor })],
    ["without util.types", withoutUtilTypes],
  ] as const) {
    it(`runs no trap of a Proxy prototype on an extension reached before the operation (${runtime})`, async () => {
      const loaded = await load();
      for (const executor of [trivial, loaded.httpExecutor({ baseUrl: api.origin, headers: operatorHeaders })]) {
        const document = documentWith({ operationSecurity: [{ k: [] }] });
        const operation = (document.paths as Record<string, Record<string, { security: unknown[] }>>)["/keyed"]!.get!;
        const { prototype, traps } = trappingPrototype(() => {
          operation.security = [{}];
        });
        // Last key, so the copier reaches it first.
        document["x-ext"] = Object.setPrototypeOf({ a: 1 }, prototype) as object;
        const { tools, skipped } = loaded.fromOpenAPI(document, { executor: executor as OpenApiExecutor });
        expect(traps.count).toBe(0);
        expect(skipped).toEqual([]);
        expect(tools.map((tool) => [tool.operation.security, tool.operation.securityUnresolved])).toEqual([[[{ k: [] }], undefined]]);
        // The apiKey requirement holds, so X-Api-Key is not caller input.
        expect(inputs(tools)).toEqual([[]]);
      }
    });

    it(`runs no trap of a Proxy prototype on a requirement, and fails closed (${runtime})`, async () => {
      const loaded = await load();
      for (const own of [{}, { k: [] }]) {
        let traps = { count: 0 };
        const build = () => {
          const made = trappingPrototype(() => {});
          traps = made.traps;
          return documentWith({ operationSecurity: [Object.setPrototypeOf({ ...own }, made.prototype) as object] });
        };
        expectFailsClosed(loaded.fromOpenAPI as typeof fromOpenAPI, () => loaded.httpExecutor({ baseUrl: api.origin, headers: operatorHeaders }), build, unresolvedSecurity);
        expect(traps.count).toBe(0);
      }
    });
  }

  it("still reads ordinary requirements of any realm, [{}] and [] as before", () => {
    const http = () => httpExecutor({ baseUrl: api.origin, headers: operatorHeaders });
    for (const requirement of [
      Object.assign(Object.create(null) as object, { k: [] }),
      runInNewContext("({ k: [] })") as object,
      runInNewContext("Object.assign(Object.create(null), { k: [] })") as object,
    ]) {
      const { tools, skipped } = fromOpenAPI(documentWith({ operationSecurity: [requirement] }), { executor: http() });
      expect(skipped).toEqual([]);
      expect(inputs(tools)).toEqual([[]]);
    }
    // A genuine anonymous requirement of any realm, or no security at all, leaves X-Api-Key to the caller.
    for (const security of [[{}], [Object.create(null) as object], [runInNewContext("({})") as object], []]) {
      const open = fromOpenAPI(documentWith({ operationSecurity: security }), { executor: http() });
      expect(open.skipped).toEqual([]);
      expect(inputs(open.tools)).toEqual([["header"]]);
    }
  });

  it("never reads a requirement holding a symbol key as anonymous", () => {
    const { tools } = fromOpenAPI(documentWith({ operationSecurity: [{ [Symbol("k")]: [] }] }), { executor: trivial });
    expect(tools.map((tool) => tool.operation.securityUnresolved)).toEqual([notPlain]);
  });
});

describe("httpExecutor output judged by the registry's own validator", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "output", version: "1.0.0" },
    paths: {
      "/m": {
        post: {
          operationId: "m",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { a: { type: "number" } } } } } },
          },
        },
      },
    },
  };
  const unrepeatable =
    "The API responded with HTTP 200 and a body the output schema does not describe, so the call succeeded, but the tool has no structured result to return. Do not repeat the call.";
  // A custom compiler with a fixed verdict on the output schema (the one with property `a`), accepting every input.
  const judging = (verdict: boolean) =>
    new McpFnRegistry({
      compileSchema: (schema) => () => (isObjectSchema(schema) && "a" in (schema.properties as object) ? verdict : true),
    });
  const isObjectSchema = (schema: unknown): schema is { properties: object } =>
    typeof schema === "object" && schema !== null && typeof (schema as { properties?: unknown }).properties === "object";
  const convert = (registry: McpFnRegistry, body: string) => {
    const upstream = stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    const { tools } = fromOpenAPI(document, { executor: httpExecutor({ baseUrl: api.origin, fetch: upstream.fetch }), registry, allowMutations: true });
    expect(tools.map(({ name }) => name)).toEqual(["m"]);
    return upstream;
  };
  const connect = async (registry: McpFnRegistry) => {
    const server = createMcpFnServer({ info: { name: "output", version: "1.0.0" }, registry });
    const client = new Client({ name: "client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, close: async () => void (await Promise.all([client.close(), server.close()])) };
  };

  it("returns the do-not-repeat error, never a thrown output error, when a stricter custom compiler rejects a body the built-in one accepts", async () => {
    const registry = judging(false);
    const upstream = convert(registry, '{"a":1.5}');
    const direct = await registry.callTool("m", {}, undefined, requestExtra());
    expect(direct).toEqual({ isError: true, content: [{ type: "text", text: unrepeatable }, { type: "text", text: '{"a":1.5}' }] });
    const { client, close } = await connect(registry);
    try {
      const served = await client.callTool({ name: "m", arguments: {} });
      expect(served.isError).toBe(true);
      expect((served.content as { text: string }[])[0]!.text).toBe(unrepeatable);
      expect(served.structuredContent).toBeUndefined();
    } finally {
      await close();
    }
    expect(upstream.urls).toHaveLength(2);
  });

  it("returns structured content a lenient custom compiler accepts, though the built-in one would reject it", async () => {
    const registry = judging(true);
    convert(registry, '{"a":"x"}');
    expect(await registry.callTool("m", {}, undefined, requestExtra())).toEqual({ content: [{ type: "text", text: '{"a":"x"}' }], structuredContent: { a: "x" } });
    const { client, close } = await connect(registry);
    try {
      expect((await client.callTool({ name: "m", arguments: {} })).structuredContent).toEqual({ a: "x" });
    } finally {
      await close();
    }
  });

  it("judges with the built-in compiler on a default registry, directly and through a server", async () => {
    for (const [body, structured] of [
      ['{"a":1.5}', { a: 1.5 }],
      ['{"a":"x"}', undefined],
    ] as const) {
      const registry = new McpFnRegistry();
      convert(registry, body);
      const direct = await registry.callTool("m", {}, undefined, requestExtra());
      expect(direct.structuredContent).toEqual(structured);
      expect(direct.isError).toBe(structured === undefined ? true : undefined);
      const { client, close } = await connect(registry);
      try {
        expect((await client.callTool({ name: "m", arguments: {} })).structuredContent).toEqual(structured);
      } finally {
        await close();
      }
    }
  });
});

describe("httpExecutor error and text bodies judged as returned", () => {
  const reply = (body: BodyInit, status: number, contentType = "application/json") =>
    stubFetch(() => new Response(body, { status, headers: { "content-type": contentType } })).fetch;
  const withheldError = (status: number) => `The API responded with HTTP ${status}.\n[body withheld: it reveals an operator credential]`;

  describe("with an all-digit credential", () => {
    const headers = { "x-api-key": "12345" };
    const run = (body: string, status: number) =>
      execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: reply(body, status) }), operationOf("echo"));

    it("reads JSON numbers as written in the unredacted body, duplicate keys included", async () => {
      // Redacting the literal 12345 must not hide the 1.2345e4 next to it.
      expect(text(await run('{"literal":12345,"encoded":1.2345e4}', 500))).toBe(withheldError(500));
      // JSON.parse keeps only the last of a duplicate key.
      expect(text(await run('{"seen":1.2345e4,"seen":0}', 500))).toBe(withheldError(500));
      const success = await run('{"seen":1.2345e4,"seen":0}', 200);
      expect(success.isError).toBe(true);
      expect(text(success)).toContain("reveals an operator credential and was withheld");
      // A JSON string is never read as a number.
      expect(text(await run('{"seen":"1.2345e4"}', 500))).toBe('The API responded with HTTP 500.\n\n{"seen":"1.2345e4"}');
      await expect(run('{"seen":"1.2345e4"}', 200)).resolves.toEqual({ content: [{ type: "text", text: '{"seen":"1.2345e4"}' }] });
    });

    it("withholds an excerpt whose 4 KiB cut leaves a number that parses to the credential", async () => {
      // Cut after 4,096 bytes, 1.2345e45 is shown as 1.2345e4.
      const body = `{"pad":"${"x".repeat(4074)}","n":1.2345e45}`;
      expect(body.indexOf("1.2345e45") + "1.2345e4".length).toBe(4096);
      expect(text(await run(body, 500))).toBe(withheldError(500));
      // The same body cut elsewhere is returned.
      expect(text(await run(`{"pad":"${"x".repeat(4073)}","n":1.2345e45}`, 500))).toContain("[body truncated after 4096 bytes]");
    });
  });

  it("checks the UTF-8 view of an error body without NULs as the success path does", async () => {
    // Declared utf-16le, the bytes are UTF-16BE: read as UTF-8 without NULs they spell the credential percent-encoded.
    const encoded = [...operatorToken].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join("");
    const body = Buffer.from(`seen ${encoded}`, "utf16le").swap16();
    const headers = { authorization: `Bearer ${operatorToken}` };
    const contentType = "text/plain; charset=utf-16le";
    const failure = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: reply(body, 500, contentType) }), operationOf("echo"));
    expect(text(failure)).toBe(withheldError(500));
    const success = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: reply(body, 200, contentType) }), operationOf("echo"));
    expect(text(success)).toContain("reveals an operator credential and was withheld");
  });

  it("returns structured content with its compact serialization as text, which holds no pretty-printed spelling", async () => {
    // A pretty-printed text would hold the credential: "test": "key".
    const headers = { "x-api-key": 'test": "key' };
    const result = await execute(
      httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: reply('{"test":"key"}', 200) }),
      operationOf("echo"),
      {},
      { hasOutputSchema: true },
    );
    expect(result).toEqual({ content: [{ type: "text", text: '{"test":"key"}' }], structuredContent: { test: "key" } });
  });
});

describe("httpExecutor error excerpts redacted only in plain bodies", () => {
  const withheld = "The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]";
  const run = (headers: Record<string, string>, body: BodyInit, contentType = "text/plain") =>
    execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        headers,
        fetch: stubFetch(() => new Response(body, { status: 500, headers: { "content-type": contentType } })).fetch,
      }),
      operationOf("echo"),
    );

  it("withholds a NUL-split echo that overlaps a literal echo of the same credential", async () => {
    // Without the NUL the body holds the credential twice; only the second is literal, and redacting it would leave "test\0-key-".
    expect(text(await run({ "x-self": "test-key-test" }, "test\u0000-key-test-key-test"))).toBe(withheld);
  });

  it("withholds a NUL-split echo that a literal echo of another credential bridges", async () => {
    const headers = { "x-long": "test-long-alpha-key", "x-beta": "key-beta" };
    expect(text(await run(headers, "test-long-alpha-key\u0000-beta"))).toBe(withheld);
  });

  it("withholds a JSON number that parses to a credential around a literal echo of a shorter one", async () => {
    // 1.2345e4 parses to 12345; redacting the literal 345 would leave 1.2[REDACTED]e4.
    expect(text(await run({ "x-api-key": "12345", "x-short": "345" }, '{"seen":1.2345e4}', "application/json"))).toBe(withheld);
  });

  it("still redacts overlapping literal echoes whole", async () => {
    const headers = { "x-first": "test-key-one", "x-second": "one-more" };
    expect(text(await run(headers, "seen test-key-one-more!"))).toBe("The API responded with HTTP 500.\n\nseen [REDACTED]!");
  });

  it.each([
    ["a number written shorter beside one that parses to the credential", '{"a":12345e-1,"b":1.2345e4}'],
    ["a number that overflows beside one that parses to the credential", '{"removed":12345e400,"encoded":1.2345e4}'],
  ])("withholds a JSON body with %s", async (_label, body) => {
    expect(text(await run({ "x-api-key": "12345", "x-short": "345" }, body, "application/json"))).toBe(withheld);
  });

  it("withholds a body whose HTML references move an echo between spellings", async () => {
    const headers = { "x-api-key": "test&amp;key", "x-short": "key" };
    expect(text(await run(headers, "test&amp;key &#116;est&amp;amp;key &#116;est&amp;amp;amp;key"))).toBe(withheld);
  });

  it("withholds a utf-16le body whose bytes read as UTF-8 hold an echo", async () => {
    const bytes = Buffer.concat([Buffer.from("te%73t-", "utf16le").swap16(), Buffer.from("key", "utf16le")]);
    expect(text(await run({ "x-api-key": "test-key", "x-short": "key" }, new Uint8Array(bytes), "text/plain; charset=utf-16le"))).toBe(withheld);
  });

  it.each([
    ["a percent escape", "seen test-key-one at /a%20b"],
    ["a JSON escape", '{"seen":"test-key-one","note":"\\u0041"}'],
    ["an HTML reference", "seen test-key-one &amp; more"],
    ["a plus sign, read as a space in a form", "seen test-key-one a+b"],
  ])("withholds a literal echo in a body with %s, which has another reading", async (_label, body) => {
    expect(text(await run({ "x-api-key": "test-key-one" }, body))).toBe(withheld);
  });

  it.each([
    ["a decimal reference without its semicolon", "te&#115t-operator-key"],
    ["a decimal reference to a hyphen without its semicolon", "test&#45operator-key"],
    ["a hex reference without its semicolon", "test&#x2doperator-key"],
    ["a decimal reference with leading zeros", "test&#0000000045;operator-key"],
    ["named references to ASCII punctuation", "test&lowbar;operator&colon;key"],
    ["a legacy reference without its semicolon", "test&ampoperator-key"],
  ])("withholds an error body and a success body that echo the credential through %s", async (_label, echo) => {
    const headers = { "x-api-key": echo.includes("lowbar") ? "test_operator:key" : echo.includes("amp") ? "test&operator-key" : "test-operator-key" };
    expect(text(await run(headers, `<p>bad key ${echo}</p>`, "text/html"))).toBe(withheld);
    const success = await execute(
      httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: stubFetch(() => new Response(`<p>${echo}</p>`, { status: 200, headers: { "content-type": "text/html" } })).fetch }),
      operationOf("echo"),
    );
    expect(text(success)).toContain("reveals an operator credential and was withheld");
  });

  it("returns an HTML error body with references unchanged when it reveals no credential", async () => {
    const body = "<p>a&#45b &lowbar; &amp &#x2d; &colon;</p>";
    expect(text(await run({ "x-api-key": "test-operator-key" }, body, "text/html"))).toBe(`The API responded with HTTP 500.\n\n${body}`);
  });

  it("still redacts a literal echo in a plain JSON body", async () => {
    const body = '{"error":"bad key test-key-one","code":401}';
    expect(text(await run({ "x-api-key": "test-key-one" }, body, "application/json"))).toBe(
      'The API responded with HTTP 500.\n\n{"error":"bad key [REDACTED]","code":401}',
    );
  });

  it("returns a body with escapes unchanged when it reveals no credential", async () => {
    const body = '{"path":"/a%20b","note":"\\u0041 &amp; a+b"}';
    expect(text(await run({ "x-api-key": "test-key-one" }, body, "application/json"))).toBe(`The API responded with HTTP 500.\n\n${body}`);
  });
});

describe("httpExecutor JSON number checks on long number tokens", () => {
  it("checks a number token with a long internal run of zeros in time linear in its length", async () => {
    const body = `{"n":1.${"0".repeat(500_000)}1}`;
    const { fetch } = stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    const started = performance.now();
    const result = await execute(
      httpExecutor<Context>({ baseUrl: api.origin, headers: { "x-api-key": "test-operator-key" }, fetch }),
      operationOf("echo"),
      {},
      { hasOutputSchema: true },
    );
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("a body that cannot be returned as structured content");
  });
});

describe("httpExecutor response schemas compared with bounded work", () => {
  const response = (schema: object) => ({ description: "Done", content: { "application/json": { schema } } });
  const catalogOf = (responses: Record<string, unknown>) =>
    fromOpenAPI(
      { openapi: "3.1.0", info: { title: "compare", version: "1.0.0" }, paths: { "/item": { put: { operationId: "putItem", responses } } } },
      { executor: httpExecutor({ baseUrl: api.origin }), allowMutations: true },
    );

  it("does not expand a second response's deep alias graph, and keeps the tool without an output schema", () => {
    // Each level refers to the one below twice, as YAML aliases do: written out, it would be 2^64 nodes.
    let shared: object = { type: "string" };
    for (let level = 0; level < 64; level += 1) shared = { type: "object", properties: { a: shared, b: shared } };
    const { tools, skipped } = catalogOf({
      "200": response({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } }),
      "201": response(shared),
    });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["putItem"]);
    expect(tools[0]!.outputSchema).toBeUndefined();
  });

  it("leaves out the output schema when equality is not shown within the budget, and keeps it for a small identical schema", () => {
    // 10,202 pairs of objects to compare (equal strings cost nothing), over the 10,000 budget.
    const properties = (count: number, value: () => object) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, value()]));
    const wide = () => ({ type: "object", properties: properties(100, () => ({ type: "object", properties: properties(100, () => ({ type: "string" })) })) });
    const large = catalogOf({ "200": response(wide()), "201": response(wide()) });
    expect(large.skipped).toEqual([]);
    expect(large.tools[0]!.outputSchema).toBeUndefined();
    const small = () => ({ type: "object", properties: { id: { type: "string" } } });
    expect(catalogOf({ "200": response(small()), "201": response(small()) }).tools[0]!.outputSchema).toBeDefined();
  });
});

describe("httpExecutor 204 and 205 entries with a schema that cannot compile", () => {
  it.each([204, 205])("keeps a %i-only operation callable as a bodyless success", async (status) => {
    const content = { "application/json": { schema: { type: "object", unevaluatedProperties: false } } };
    const { registry, tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "bodyless", version: "1.0.0" },
        paths: { "/item": { put: { operationId: "putItem", responses: { [String(status)]: { description: "Done", content } } } } },
      },
      {
        executor: httpExecutor({ baseUrl: api.origin, fetch: stubFetch(() => new Response(null, { status })).fetch }),
        allowMutations: true,
      },
    );
    expect(skipped).toEqual([]);
    expect(tools[0]!.outputSchema).toBeUndefined();
    await expect(registry.callTool("putItem", {}, undefined, requestExtra())).resolves.toEqual({
      content: [{ type: "text", text: `The API responded with HTTP ${status} and no body.` }],
    });
  });
});

describe("httpExecutor header records changed after construction", () => {
  it("sends the record as it was validated, whatever is later changed in the operator's object", async () => {
    const sent: Headers[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const record: Record<string, string> = { "x-api-key": "test-operator-key", "x-tenant": "tenant-1" };
    const executor = httpExecutor<Context>({ baseUrl: api.origin, headers: record, fetch });
    delete record["x-api-key"];
    record["x-tenant"] = "tenant-2";
    record["x-extra"] = "added-later";
    await execute(executor, operationOf("getItem"), { path: { id: "1" } });
    expect(Object.fromEntries(sent[0]!)).toEqual({ "x-api-key": "test-operator-key", "x-tenant": "tenant-1" });
  });
});

describe("httpExecutor Sec-Fetch-Mode, which undici replaces", () => {
  const documentWith = (required: boolean) => ({
    openapi: "3.1.0",
    info: { title: "fetch-mode", version: "1.0.0" },
    paths: {
      "/mode": {
        get: {
          operationId: "mode",
          parameters: [{ name: "Sec-Fetch-Mode", in: "header", required, schema: { type: "string" } }],
          responses: ok,
        },
      },
    },
  });

  it("publishes no input for an optional one", () => {
    const { tools } = fromOpenAPI(documentWith(false), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools[0]!.operation.parameters).toEqual([]);
  });

  it("skips an operation that requires one", () => {
    const { tools, skipped } = fromOpenAPI(documentWith(true), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([{ code: "unsupported-by-executor", reason: 'fetch manages the required header "Sec-Fetch-Mode"' }]);
  });

  it("refuses an operator entry, naming only the header", () => {
    const create = () => httpExecutor({ baseUrl: api.origin, headers: { "Sec-Fetch-Mode": "test-mode-value" } });
    expect(create).toThrow(McpFnValidationError);
    expect(create).toThrow('httpExecutor headers entry "Sec-Fetch-Mode" is managed by fetch');
    expect(create).not.toThrow(/test-mode-value/);
  });
});

describe("httpExecutor documented request media types that name a charset", () => {
  it("skips an operation whose JSON body is documented in a charset other than UTF-8, and sends a UTF-8 one", async () => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const body = (key: string) => ({ content: { [key]: { schema: { type: "object" } } } });
    const { registry, tools, skipped } = fromOpenAPI(
      {
        openapi: "3.1.0",
        info: { title: "charsets", version: "1.0.0" },
        paths: {
          "/utf16": { post: { operationId: "utf16", requestBody: body("application/json; charset=utf-16"), responses: ok } },
          "/utf8": { post: { operationId: "utf8", requestBody: body("application/json; charset=UTF-8"), responses: ok } },
        },
      },
      { executor: httpExecutor({ baseUrl: api.origin, fetch }), allowMutations: true },
    );
    expect(tools.map((tool) => tool.name)).toEqual(["utf8"]);
    expect(skipped).toMatchObject([
      {
        operation: { operationId: "utf16" },
        code: "unsupported-by-executor",
        reason: "the request body's documented media type names a charset other than UTF-8, but the body is sent as UTF-8",
      },
    ]);
    await registry.callTool("utf8", { body: {} }, undefined, requestExtra());
    expect(urls).toEqual([`${api.origin}/utf8`]);
  });
});

describe("httpExecutor request bodies documented under several JSON media types", () => {
  const documentWith = (content: Record<string, unknown>) => ({
    openapi: "3.1.0",
    info: { title: "media-alternatives", version: "1.0.0" },
    paths: { "/p": { post: { operationId: "p", requestBody: { required: true, content }, responses: ok } } },
  });
  // Each entry requires its own property, so the tool input shows which schema was chosen.
  const entry = (property: string) => ({ schema: { type: "object", required: [property], properties: { [property]: { type: "string" } } } });

  it.each([
    ["names a charset other than UTF-8", "application/json; charset=utf-16", "application/json"],
    ["cannot be parsed", "application/json; charset", "application/example+json"],
    ["has a quoted CR LF", 'application/json; profile="a\r\nb"', "application/example+json; charset=utf-8"],
  ])("lists an operation whose first JSON entry %s and sends the next one, with its schema", async (_label, unsendable, sendable) => {
    const sent: Array<{ contentType: string | null; body: unknown }> = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push({ contentType: new Headers(init?.headers).get("content-type"), body: init?.body });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const { registry, tools, skipped } = fromOpenAPI(documentWith({ [unsendable]: entry("first"), [sendable]: entry("second") }), {
      executor: httpExecutor({ baseUrl: api.origin, fetch }),
      allowMutations: true,
    });
    expect(skipped).toEqual([]);
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: sendable });
    const result = await registry.callTool("p", { body: { second: "value" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ contentType: sendable, body: '{"second":"value"}' }]);
    // The unsendable entry's schema is not the input: a body for it is refused before any request.
    await expect(registry.callTool("p", { body: { first: "value" } }, undefined, requestExtra())).rejects.toThrow(McpFnValidationError);
    expect(sent).toHaveLength(1);
  });

  it("still skips an operation whose JSON entries are all unsendable, for the first entry's reason", () => {
    const content = { "application/json; charset=utf-16": entry("first"), "application/example+json; charset=latin1": entry("second") };
    const { tools, skipped } = fromOpenAPI(documentWith(content), {
      executor: httpExecutor({ baseUrl: api.origin, fetch: stubFetch(() => new Response("ok")).fetch }),
      allowMutations: true,
    });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([
      {
        code: "unsupported-by-executor",
        reason: "the request body's documented media type names a charset other than UTF-8, but the body is sent as UTF-8",
      },
    ]);
  });

  it("keeps the first entry for an executor that does not say which media types it sends", () => {
    const content = { "application/json; charset=utf-16": entry("first"), "application/json": entry("second") };
    const { tools } = fromOpenAPI(documentWith(content), { executor: { execute: () => ({ content: [] }) }, allowMutations: true });
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json; charset=utf-16" });
  });
});

describe("httpExecutor security arrays read without their methods", () => {
  const documentWith = (security: unknown[]) => ({
    openapi: "3.1.0",
    info: { title: "security-arrays", version: "1.0.0" },
    paths: {
      "/a": { get: { operationId: "a", security, responses: ok } },
      "/b": { get: { operationId: "b", responses: ok } },
    },
  });

  it("never calls an own entries method of a security array", () => {
    const security: unknown[] = [{}];
    Object.defineProperty(security, "entries", {
      value: () => {
        throw new Error("test-entries-called");
      },
    });
    const { tools } = fromOpenAPI(documentWith(security), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools.map((tool) => tool.name).sort()).toEqual(["a", "b"]);
  });

  it("reads a sparse security array of length 1e8 in time proportional to its elements", () => {
    const security: unknown[] = [{}];
    security.length = 1e8;
    const started = performance.now();
    const { tools } = fromOpenAPI(documentWith(security), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(tools.map((tool) => tool.name)).toContain("b");
  });
});

describe("httpExecutor security arrays shared by many operations", () => {
  const documentWith = (security: unknown[], count: number) => ({
    openapi: "3.1.0",
    info: { title: "shared-security", version: "1.0.0" },
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`/op${index}`, { get: { operationId: `op${index}`, security, responses: ok } }]),
    ),
  });

  it("inspects one large array once, however many operations (excluded ones included) reference it", () => {
    const security: unknown[] = Array.from({ length: 2000 }, () => ({}));
    const started = performance.now();
    const { tools } = fromOpenAPI(documentWith(security, 5000), {
      executor: httpExecutor({ baseUrl: api.origin }),
      include: ["op0"],
    });
    expect(performance.now() - started).toBeLessThan(400);
    expect(tools.map((tool) => tool.name)).toEqual(["op0"]);
  });

  it("still marks a class-instance entry of the shared array for every operation that uses it", () => {
    class Requirement {}
    const { tools, skipped } = fromOpenAPI(documentWith([{}, new Requirement()], 3), {
      executor: httpExecutor({ baseUrl: api.origin, headers: { "x-api-key": operatorToken } }),
    });
    expect(tools).toEqual([]);
    expect(skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual(
      ["op0", "op1", "op2"].map((id) => [
        id,
        "unsupported-by-executor",
        "its security cannot be read: the operation's security has a requirement that is not a plain object",
      ]),
    );
  });
});

describe("httpExecutor security requirements and scope lists shared by reference", () => {
  const oauth = { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://auth.example.test/token", scopes: {} } } };
  const documentWith = (operations: Record<string, unknown[]>) => ({
    openapi: "3.1.0",
    info: { title: "shared-requirements", version: "1.0.0" },
    components: { securitySchemes: { oauth } },
    paths: {
      ...Object.fromEntries(Object.entries(operations).map(([id, security]) => [`/${id}`, { get: { operationId: id, security, responses: ok } }])),
      "/plain": { get: { operationId: "plain", responses: ok } },
    },
  });

  it("checks one requirement's scopes once, however many times a level lists it", () => {
    const requirement = { oauth: Array.from({ length: 50_000 }, (_, index) => `scope-${index}`) };
    const started = performance.now();
    const { tools } = fromOpenAPI(documentWith({ aliased: Array.from({ length: 50_000 }, () => requirement) }), {
      executor: httpExecutor({ baseUrl: api.origin }),
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["aliased", "plain"]);
  });

  it("still reports a non-string scope of a shared list for every operation that uses it", () => {
    const scopes: unknown[] = ["read", 7];
    const { tools, skipped } = fromOpenAPI(
      documentWith({ first: [{ oauth: scopes }], second: [{ oauth: scopes }, { oauth: scopes }], third: [{}, { oauth: scopes }] }),
      { executor: httpExecutor({ baseUrl: api.origin }) },
    );
    expect(tools.map((tool) => tool.name)).toEqual(["plain"]);
    expect(skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual(
      ["first", "second", "third"].map((id) => [
        id,
        "unsupported-by-executor",
        'its security cannot be read: the scopes of the security scheme "oauth" are not a list of strings',
      ]),
    );
  });
});

describe("httpExecutor header parameters whose name is not an HTTP token", () => {
  const documentWith = (required: boolean) => ({
    openapi: "3.1.0",
    info: { title: "bad-header-name", version: "1.0.0" },
    paths: {
      "/bad": {
        get: {
          operationId: "bad",
          parameters: [
            { name: "X Bad", in: "header", required, schema: { type: "string" } },
            { name: "X-Good", in: "header", schema: { type: "string" } },
          ],
          responses: ok,
        },
      },
    },
  });

  it("skips an operation that requires one, as no request could carry it", () => {
    const { tools, skipped } = fromOpenAPI(documentWith(true), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([
      { code: "unsupported-by-executor", reason: 'the required header "X Bad" is not a valid HTTP header name' },
    ]);
  });

  it("publishes no input for an optional one, and the call still sends", async () => {
    const sent: Headers[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const { registry, tools } = fromOpenAPI(documentWith(false), { executor: httpExecutor({ baseUrl: api.origin, fetch }) });
    expect(tools[0]!.operation.parameters.map((parameter) => parameter.name)).toEqual(["X-Good"]);
    const result = await registry.callTool("bad", { header: { "X-Good": "test-good" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(sent.map((headers) => headers.get("x-good"))).toEqual(["test-good"]);
  });
});

describe("httpExecutor structured results of deeply nested bodies", () => {
  it("returns text within twice the body size, not a pretty-printed expansion", async () => {
    let value: object = { leaf: Array.from({ length: 20_000 }, () => 0) };
    for (let level = 0; level < 1000; level += 1) value = { a: value };
    const body = JSON.stringify(value);
    const result = await execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        fetch: stubFetch(() => new Response(body, { headers: { "content-type": "application/json" } })).fetch,
      }),
      operationOf("echo"),
      {},
      { hasOutputSchema: true },
    );
    expect(result.structuredContent).toBeDefined();
    expect(text(result).length).toBeLessThanOrEqual(2 * body.length);
  });
});

describe("httpExecutor documented request media types no header can carry", () => {
  const documentWith = (contentType: string) => ({
    openapi: "3.1.0",
    info: { title: "media-types", version: "1.0.0" },
    paths: { "/p": { post: { operationId: "p", requestBody: { content: { [contentType]: { schema: { type: "object" } } } }, responses: ok } } },
  });

  it.each([
    ["a quoted CR LF", 'application/json; profile="a\r\nb"'],
    ["a quoted NUL", 'application/json; profile="a\u0000b"'],
    ["a quoted character above 0xFF", 'application/json; profile="a\u20acb"'],
  ])("skips an operation whose media type has %s, and refuses a call to it without throwing", async (_label, contentType) => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const executor = httpExecutor({ baseUrl: api.origin, fetch });
    const { tools, skipped } = fromOpenAPI(documentWith(contentType), { executor, allowMutations: true });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([
      { code: "unsupported-by-executor", reason: "the request body's documented media type has a character no HTTP header can carry" },
    ]);
    const { tools: sendable } = fromOpenAPI(documentWith("application/json"), { executor, allowMutations: true });
    const operation = sendable[0]!.operation;
    const result = await execute(executor as ReturnType<typeof httpExecutor<Context>>, {
      ...operation,
      requestBody: { ...operation.requestBody!, contentType },
    }, { body: {} });
    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe("httpExecutor Range, beside which undici rewrites Accept-Encoding", () => {
  const documentWith = (required: boolean) => ({
    openapi: "3.1.0",
    info: { title: "range", version: "1.0.0" },
    paths: {
      "/range": {
        get: {
          operationId: "range",
          parameters: [{ name: "Range", in: "header", required, schema: { type: "string" } }],
          responses: ok,
        },
      },
    },
  });

  it("publishes no input for an optional one", () => {
    const { tools } = fromOpenAPI(documentWith(false), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools[0]!.operation.parameters).toEqual([]);
  });

  it("skips an operation that requires one", () => {
    const { tools, skipped } = fromOpenAPI(documentWith(true), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([{ code: "unsupported-by-executor", reason: 'fetch manages the required header "Range"' }]);
  });

  it("refuses an operator entry, naming only the header", () => {
    const create = () => httpExecutor({ baseUrl: api.origin, headers: { Range: "bytes=0-1" } });
    expect(create).toThrow(McpFnValidationError);
    expect(create).toThrow('httpExecutor headers entry "Range" is managed by fetch');
    expect(create).not.toThrow(/bytes=0-1/);
  });
});

describe("httpExecutor HTML named references a non-ASCII credential form may hide in", () => {
  const cookie = { cookie: "session=test-%C3%A9-cookie" };
  const body = "<p>test-&eacute;-cookie</p>";
  const run = (headers: Record<string, string>, status: number) =>
    execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        headers,
        fetch: stubFetch(() => new Response(body, { status, headers: { "content-type": "text/html" } })).fetch,
      }),
      operationOf("echo"),
    );

  it("withholds an error body and a success body that spell the decoded cookie with a reference it does not decode", async () => {
    expect(text(await run(cookie, 500))).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
    expect(text(await run(cookie, 200))).toContain("reveals an operator credential and was withheld");
  });

  it("returns such a body unchanged when every credential form is ASCII", async () => {
    const headers = { "x-api-key": "test-operator-key" };
    expect(text(await run(headers, 500))).toBe(`The API responded with HTTP 500.\n\n${body}`);
    expect(text(await run(headers, 200))).toBe(body);
  });
});

describe("httpExecutor named references that only start with a legacy name", () => {
  const cookie = { cookie: "session=test-%E2%8B%89-key" };
  const body = "<p>test-&ltimes;-key</p>";
  const run = (headers: Record<string, string>, status: number) =>
    execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        headers,
        fetch: stubFetch(() => new Response(body, { status, headers: { "content-type": "text/html" } })).fetch,
      }),
      operationOf("echo"),
    );

  it("withholds &ltimes; spelling a non-ASCII cookie form on an error and a success", async () => {
    expect(text(await run(cookie, 500))).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
    expect(text(await run(cookie, 200))).toContain("reveals an operator credential and was withheld");
  });

  it("returns the body unchanged when every credential form is ASCII", async () => {
    const headers = { "x-api-key": "test-operator-key" };
    expect(text(await run(headers, 500))).toBe(`The API responded with HTTP 500.\n\n${body}`);
    expect(text(await run(headers, 200))).toBe(body);
  });
});

describe("httpExecutor HTML numeric references in the windows-1252 range and text that only looks like a reference", () => {
  const run = (headers: Record<string, string>, status: number, body: string, contentType = "text/html") =>
    execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        headers,
        fetch: stubFetch(() => new Response(body, { status, headers: { "content-type": contentType } })).fetch,
      }),
      operationOf("echo"),
    );
  const withheld = "The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]";

  it.each([
    ["session=test-%E2%82%AC-key", "<p>test-&#128;-key</p>"],
    ["session=test-%E2%82%AC-key", "<p>test-&#x80;-key</p>"],
    ["session=test-%E2%80%94-key", "<p>test-&#151-key</p>"],
  ])("withholds %s spelled as %s on an error and a success", async (cookie, body) => {
    expect(text(await run({ cookie }, 500, body))).toBe(withheld);
    expect(text(await run({ cookie }, 200, body))).toContain("reveals an operator credential and was withheld");
  });

  it("returns a C1 numeric reference unchanged when every credential form is ASCII", async () => {
    const body = "<p>a &#128; b</p>";
    const headers = { "x-api-key": "test-operator-key" };
    expect(text(await run(headers, 500, body))).toBe(`The API responded with HTTP 500.\n\n${body}`);
    expect(text(await run(headers, 200, body))).toBe(body);
  });

  it("returns a URL query with &name= unchanged beside a non-ASCII cookie, and still withholds real references", async () => {
    const cookie = { cookie: "session=test-%C3%A9-key" };
    const link = '{"link":"https://x/?a=1&view=compact"}';
    expect(text(await run(cookie, 500, link, "application/json"))).toBe(`The API responded with HTTP 500.\n\n${link}`);
    expect(text(await run(cookie, 200, link, "application/json"))).toBe(link);
    for (const body of ["<p>test-&eacute;-key</p>", "<p>test-&ltimes;-key</p>"]) {
      expect(text(await run(cookie, 500, body))).toBe(withheld);
      expect(text(await run(cookie, 200, body))).toContain("reveals an operator credential and was withheld");
    }
  });
});

describe("httpExecutor JSON error bodies read as they serialize", () => {
  const headers = { "x-cfg": '{"label":"test-key"}' };
  const run = (body: string) =>
    execute(
      httpExecutor<Context>({
        baseUrl: api.origin,
        headers,
        fetch: stubFetch(() => new Response(body, { status: 500, headers: { "content-type": "application/json" } })).fetch,
      }),
      operationOf("echo"),
    );

  it("withholds a spaced JSON body whose compact serialization echoes a credential, as a success body is", async () => {
    expect(text(await run('{ "label": "test-key" }'))).toBe("The API responded with HTTP 500.\n[body withheld: it reveals an operator credential]");
  });

  it("still redacts a compact JSON body's literal echo", async () => {
    expect(text(await run('{"label":"test-key"}'))).toBe("The API responded with HTTP 500.\n\n[REDACTED]");
  });

  it("returns a spaced JSON body unchanged when it reveals no credential", async () => {
    const body = '{ "label": "other" }';
    expect(text(await run(body))).toBe(`The API responded with HTTP 500.\n\n${body}`);
  });
});

describe("httpExecutor request bodies under an operator Content-Type", () => {
  const documentWith = (content: Record<string, unknown>) => ({
    openapi: "3.1.0",
    info: { title: "fixed-content-type", version: "1.0.0" },
    paths: { "/p": { post: { operationId: "p", requestBody: { required: true, content }, responses: ok } } },
  });
  const entry = (property: string) => ({ schema: { type: "object", required: [property], properties: { [property]: { type: "string" } } } });
  const headers = { "Content-Type": "application/example+json" };

  it("chooses the documented entry the operator's record Content-Type can label, and sends it", async () => {
    const sent: Array<{ contentType: string | null; body: unknown }> = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push({ contentType: new Headers(init?.headers).get("content-type"), body: init?.body });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const { registry, tools } = fromOpenAPI(documentWith({ "application/json": entry("first"), "application/example+json": entry("second") }), {
      executor: httpExecutor({ baseUrl: api.origin, headers, fetch }),
      allowMutations: true,
    });
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/example+json" });
    const result = await registry.callTool("p", { body: { second: "value" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ contentType: "application/example+json", body: '{"second":"value"}' }]);
  });

  it("skips an operation whose required body no entry the Content-Type can label carries", () => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const { tools, skipped } = fromOpenAPI(documentWith({ "application/json": entry("first") }), {
      executor: httpExecutor({ baseUrl: api.origin, headers, fetch }),
      allowMutations: true,
    });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([
      {
        operation: { method: "POST", path: "/p", operationId: "p" },
        code: "unsupported-by-executor",
        reason: "the server's Content-Type header cannot label the required request body this operation documents",
      },
    ]);
    expect(JSON.stringify(skipped)).not.toContain("application/example+json");
    expect(urls).toEqual([]);
  });

  it("keeps listing an operation whose optional body conflicts, sends a call without it and refuses one with it", async () => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const document = documentWith({ "application/json": entry("first") });
    (document.paths["/p"].post.requestBody as { required: boolean }).required = false;
    const { registry, tools, skipped } = fromOpenAPI(document, {
      executor: httpExecutor({ baseUrl: api.origin, headers, fetch }),
      allowMutations: true,
    });
    expect(skipped).toEqual([]);
    expect(tools[0]!.operation.requestBody).toEqual({ required: false, contentType: "application/json" });
    const refused = await registry.callTool("p", { body: { first: "value" } }, undefined, requestExtra());
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Content-Type header does not match");
    expect(urls).toEqual([]);
    const bodiless = await registry.callTool("p", {}, undefined, requestExtra());
    expect(bodiless.isError).toBeFalsy();
    expect(urls).toHaveLength(1);
  });

  it("checks a required body per call when the headers come from a function", async () => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const { registry, tools, skipped } = fromOpenAPI(documentWith({ "application/json": entry("first") }), {
      executor: httpExecutor({ baseUrl: api.origin, headers: () => headers, fetch }),
      allowMutations: true,
    });
    expect(skipped).toEqual([]);
    expect(tools).toHaveLength(1);
    const result = await registry.callTool("p", { body: { first: "value" } }, undefined, requestExtra());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Content-Type header does not match");
    expect(urls).toEqual([]);
  });
});

describe("httpExecutor path templates a URL parser rewrites", () => {
  const documentWith = (path: string) => ({
    openapi: "3.1.0",
    info: { title: "path-template", version: "1.0.0" },
    paths: {
      [path]: {
        get: {
          operationId: "op",
          parameters: path.includes("{id}") ? [{ name: "id", in: "path", required: true, schema: { type: "string" } }] : [],
          responses: ok,
        },
      },
    },
  });

  it.each([["/a b/x"], ["/café/{id}"]])("skips %s, which no call could send as written", (path) => {
    const { tools, skipped } = fromOpenAPI(documentWith(path), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([{ code: "unsupported-by-executor", reason: "the operation path cannot be sent as written" }]);
  });

  it("still lists and sends a plain template", async () => {
    const { fetch, urls } = stubFetch(() => new Response("ok"));
    const { registry, skipped } = fromOpenAPI(documentWith("/items/{id}"), { executor: httpExecutor({ baseUrl: `${api.origin}/v1`, fetch }) });
    expect(skipped).toEqual([]);
    const result = await registry.callTool("op", { path: { id: "a b" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(urls).toEqual([`${api.origin}/v1/items/a%20b`]);
  });
});

describe("httpExecutor security scheme $ref chains", () => {
  const documentWith = (schemes: Record<string, unknown>, names: string[]) => ({
    openapi: "3.1.0",
    info: { title: "scheme-chains", version: "1.0.0" },
    components: { securitySchemes: schemes },
    paths: {
      "/a": { get: { operationId: "a", security: names.map((name) => ({ [name]: [] })), responses: ok } },
      "/b": { get: { operationId: "b", security: [], responses: ok } },
    },
  });
  const ref = (name: string) => ({ $ref: `#/components/securitySchemes/${name}` });

  it("resolves each name of a long chain once, so every alias listed as an alternative stays within the budgets", () => {
    const count = 5000;
    const schemes: Record<string, unknown> = { [`s${count - 1}`]: { type: "http", scheme: "bearer" } };
    for (let index = 0; index < count - 1; index += 1) schemes[`s${index}`] = ref(`s${index + 1}`);
    const names = Array.from({ length: count }, (_, index) => `s${index}`);
    const started = performance.now();
    const { tools, skipped } = fromOpenAPI(documentWith(schemes, names), { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["a", "b"]);
    expect(Object.keys(tools.find((tool) => tool.name === "a")!.operation.securitySchemes!)).toHaveLength(count);
  });

  it("still resolves a cyclic chain to no scheme, from any of its names", () => {
    const { tools, skipped } = fromOpenAPI(documentWith({ c0: ref("c1"), c1: ref("c2"), c2: ref("c1") }, ["c0"]), {
      executor: httpExecutor({ baseUrl: api.origin }),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["b"]);
    expect(skipped).toMatchObject([
      {
        code: "unsupported-by-executor",
        reason: 'the security scheme "c0" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown',
      },
    ]);
    const second = fromOpenAPI(documentWith({ c0: ref("c1"), c1: ref("c2"), c2: ref("c1") }, ["c2"]), {
      executor: httpExecutor({ baseUrl: api.origin }),
    });
    expect(second.tools.map((tool) => tool.name)).toEqual(["b"]);
  });

  it.each([
    ["the dead name first", ["dead", "c0"]],
    ["the aliasing name first", ["c0", "dead"]],
  ])("keeps a cached dead outcome final and never reads $ref siblings, with %s", (_order, names) => {
    const schemes = {
      dead: ref("missing"),
      c0: { ...ref("dead"), type: "apiKey", in: "header", name: "X-K" },
    };
    const paths = Object.fromEntries(
      names.map((name) => [`/${name}`, { get: { operationId: name, security: [{ [name]: [] }], responses: ok } }]),
    );
    const document = { openapi: "3.1.0", info: { title: "scheme-order", version: "1.0.0" }, components: { securitySchemes: schemes }, paths };
    const { tools, skipped } = fromOpenAPI(document, { executor: httpExecutor({ baseUrl: api.origin }) });
    expect(tools).toEqual([]);
    expect(skipped.find((skip) => skip.operation.operationId === "c0")).toMatchObject({
      code: "unsupported-by-executor",
      reason: 'the security scheme "c0" does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown',
    });
  });
});

describe("httpExecutor 407 Proxy Authentication Required", () => {
  const headers = { "x-api-key": operatorToken };
  const proxyBody = (size: number) => `proxy saw ${operatorToken}\n${"x".repeat(size)}`;
  let proxy: Fixture;
  beforeAll(async () => {
    proxy = await fixtureApi((_request, response) => {
      response.writeHead(407, { "content-type": "text/plain", "proxy-authenticate": 'Basic realm="fixture"' });
      response.end(proxyBody(10));
    });
  });
  afterAll(() => proxy.close());

  it("reports a 407 from the default fetch as a failed request, with no credential, after one request", async () => {
    // Fetch turns a 407 into a network error, so the status and body never reach the executor.
    const result = await execute(httpExecutor<Context>({ baseUrl: proxy.origin, headers }), operationOf("echo"));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The request to the API failed." }] });
    expect(JSON.stringify(result)).not.toContain(operatorToken);
    expect(proxy.received).toHaveLength(1);
    expect(proxy.received[0]!.headers["x-api-key"]).toBe(operatorToken);
  });

  it("reports a 407 a custom fetch returns with its status and a capped, redacted excerpt", async () => {
    const { fetch, urls } = stubFetch(() => new Response(proxyBody(5000), { status: 407, headers: { "content-type": "text/plain" } }));
    const result = await execute(httpExecutor<Context>({ baseUrl: proxy.origin, headers, fetch }), operationOf("echo"));
    expect(result.isError).toBe(true);
    const match = /^The API responded with HTTP 407\.\n\n([\s\S]*)\n\[body truncated after \d+ bytes\]$/.exec(text(result));
    expect(match).not.toBeNull();
    expect(Buffer.byteLength(match![1]!)).toBeLessThanOrEqual(4096);
    expect(match![1]!).toMatch(/^proxy saw \[REDACTED\]\nx+$/);
    expect(JSON.stringify(result)).not.toContain(operatorToken);
    expect(urls).toHaveLength(1);
  });
});

describe("httpExecutor request bodies under an operator Content-Type with parameters", () => {
  const documentWith = (content: Record<string, unknown>) => ({
    openapi: "3.1.0",
    info: { title: "content-type-parameters", version: "1.0.0" },
    paths: { "/p": { post: { operationId: "p", requestBody: { required: true, content }, responses: ok } } },
  });
  const entry = (property: string) => ({ schema: { type: "object", required: [property], properties: { [property]: { type: "string" } } } });
  const profiles = { "application/json; profile=a": entry("a"), "application/json; profile=b": entry("b") };
  const recording = () => {
    const sent: Array<{ contentType: string | null; body: unknown }> = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push({ contentType: new Headers(init?.headers).get("content-type"), body: init?.body });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    return { sent, fetch };
  };

  it("chooses the entry whose parameters the record's Content-Type carries, and rejects a body for another entry", async () => {
    const { sent, fetch } = recording();
    const { registry, tools, skipped } = fromOpenAPI(documentWith(profiles), {
      executor: httpExecutor({ baseUrl: api.origin, headers: { "Content-Type": "application/json; profile=b" }, fetch }),
      allowMutations: true,
    });
    expect(skipped).toEqual([]);
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json; profile=b" });
    const result = await registry.callTool("p", { body: { b: "value" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ contentType: "application/json; profile=b", body: '{"b":"value"}' }]);
    await expect(registry.callTool("p", { body: { a: "value" } }, undefined, requestExtra())).rejects.toThrow(McpFnValidationError);
    expect(sent).toHaveLength(1);
  });

  it("matches a parameter name in any case and a quoted value by its content", async () => {
    const { sent, fetch } = recording();
    const { registry, tools } = fromOpenAPI(documentWith(profiles), {
      executor: httpExecutor({ baseUrl: api.origin, headers: { "Content-Type": 'application/json; Profile="b"' }, fetch }),
      allowMutations: true,
    });
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json; profile=b" });
    await registry.callTool("p", { body: { b: "value" } }, undefined, requestExtra());
    expect(sent).toEqual([{ contentType: 'application/json; Profile="b"', body: '{"b":"value"}' }]);
  });

  it("chooses the entry without parameters for a Content-Type with none, and rejects a body for a profile entry", async () => {
    const { sent, fetch } = recording();
    const { registry, tools, skipped } = fromOpenAPI(
      documentWith({ "application/json; profile=a": entry("a"), "application/json": entry("p") }),
      { executor: httpExecutor({ baseUrl: api.origin, headers: { "Content-Type": "application/json" }, fetch }), allowMutations: true },
    );
    expect(skipped).toEqual([]);
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json" });
    const result = await registry.callTool("p", { body: { p: "value" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ contentType: "application/json", body: '{"p":"value"}' }]);
    await expect(registry.callTool("p", { body: { a: "value" } }, undefined, requestExtra())).rejects.toThrow(McpFnValidationError);
    expect(sent).toHaveLength(1);
  });

  it("skips an operation whose only required entry has a parameter a Content-Type without parameters lacks", () => {
    const { sent, fetch } = recording();
    const { tools, skipped } = fromOpenAPI(documentWith({ "application/json; profile=a": entry("a") }), {
      executor: httpExecutor({ baseUrl: api.origin, headers: { "Content-Type": "application/json" }, fetch }),
      allowMutations: true,
    });
    // No entry can be labeled and the body is required, so every call would be refused before fetch.
    expect(tools).toEqual([]);
    expect(skipped).toMatchObject([{ code: "unsupported-by-executor" }]);
    expect(JSON.stringify(skipped)).not.toContain("profile");
    expect(sent).toEqual([]);
  });

  it("sends the first documented entry's media type as written when there is no operator Content-Type", async () => {
    const { sent, fetch } = recording();
    const { registry, tools } = fromOpenAPI(documentWith(profiles), {
      executor: httpExecutor({ baseUrl: api.origin, headers: {}, fetch }),
      allowMutations: true,
    });
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json; profile=a" });
    const result = await registry.callTool("p", { body: { a: "value" } }, undefined, requestExtra());
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ contentType: "application/json; profile=a", body: '{"a":"value"}' }]);
  });

  it.each(["application/json", "application/json; profile=a; version=1"])(
    "refuses before fetch a function's Content-Type %j whose parameters differ from the chosen profile=a entry",
    async (contentType) => {
      const { sent, fetch } = recording();
      const { registry, tools } = fromOpenAPI(documentWith(profiles), {
        executor: httpExecutor({ baseUrl: api.origin, headers: () => ({ "Content-Type": contentType }), fetch }),
        allowMutations: true,
      });
      expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json; profile=a" });
      const result = await registry.callTool("p", { body: { a: "value" } }, undefined, requestExtra());
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Content-Type header does not match");
      expect(text(result)).not.toContain("version");
      expect(sent).toEqual([]);
    },
  );

  it("refuses before fetch a function's Content-Type whose parameters the chosen entry does not carry", async () => {
    const { sent, fetch } = recording();
    const { registry, tools } = fromOpenAPI(documentWith(profiles), {
      executor: httpExecutor({ baseUrl: api.origin, headers: () => ({ "Content-Type": "application/json; profile=b" }), fetch }),
      allowMutations: true,
    });
    // A function's headers are not known when the entry is chosen, so the first entry is.
    expect(tools[0]!.operation.requestBody).toEqual({ required: true, contentType: "application/json; profile=a" });
    const result = await registry.callTool("p", { body: { a: "value" } }, undefined, requestExtra());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Content-Type header does not match");
    expect(text(result)).not.toContain("profile=b");
    expect(sent).toEqual([]);
  });
});

describe("httpExecutor scheme credentials separated by SP or HTAB", () => {
  const token = ["test", "tabbed", "operator", "token"].join("-");
  const run = (authorization: string, status: number) => {
    const { fetch } = stubFetch(() => new Response(`seen ${token}`, { status, headers: { "content-type": "text/plain" } }));
    return execute(httpExecutor<Context>({ baseUrl: api.origin, headers: { authorization }, fetch }), operationOf("echo"));
  };

  it.each([
    ["a tab", `Bearer\t${token}`],
    ["a space then a tab", `Bearer \t${token}`],
    ["a tab then a space", `Bearer\t ${token}`],
    ["a space and a trailing tab", `Bearer ${token}\t`],
    ["a tab and a trailing space and tab", `Bearer\t${token} \t`],
  ])("treats the bare credential after %s as a secret, success and error", async (_label, authorization) => {
    const success = await run(authorization, 200);
    expect(success.isError).toBe(true);
    expect(text(success)).toContain("reveals an operator credential and was withheld");
    expect(JSON.stringify(success)).not.toContain(token);
    const failure = await run(authorization, 500);
    expect(text(failure)).toBe("The API responded with HTTP 500.\n\nseen [REDACTED]");
  });
});

describe("httpExecutor own __proto__ keys in the document", () => {
  // Operator headers carry only authorization, so a caller value in X-Api-Key would reach the upstream.
  const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
  const keyParameter = { name: "X-Api-Key", in: "header", schema: { type: "string" } };
  const trivial = { execute: () => ({ content: [] }) };
  const documentWith = (fields: { documentSecurity?: unknown; operationSecurity?: unknown }): Record<string, unknown> => ({
    openapi: "3.1.0",
    info: { title: "proto", version: "1.0.0" },
    ...(fields.documentSecurity === undefined ? {} : { security: fields.documentSecurity }),
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
    paths: {
      "/keyed": {
        get: {
          operationId: "keyed",
          ...(fields.operationSecurity === undefined ? {} : { security: fields.operationSecurity }),
          parameters: [keyParameter],
          responses: ok,
        },
      },
    },
  });
  const withOwn = <T extends object>(target: T, key: string, value: unknown): T =>
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  type Listed = ReturnType<typeof fromOpenAPI>;
  /** What a listing exposes about the keyed operation: what was skipped, and each tool's inputs and unresolved security. */
  const outcome = (listed: Listed) => ({
    skipped: listed.skipped.map(({ code, reason }) => [code, reason]),
    tools: listed.tools.map((tool) => [Object.keys((tool.inputSchema.properties ?? {}) as object), tool.operation.securityUnresolved]),
  });
  const placements: [string, (level: unknown) => Record<string, unknown>][] = [
    ["the operation level", (level) => documentWith({ documentSecurity: [{ k: [] }], operationSecurity: level })],
    ["the document level", (level) => documentWith({ documentSecurity: level })],
  ];
  const values: [string, () => unknown][] = [
    ["1", () => 1],
    ["[]", () => []],
    ['"x"', () => "x"],
    ["null", () => null],
  ];

  it.each(placements.flatMap(([where, place]) => values.map(([label, value]): [string, string, typeof place, () => unknown] => [where, label, place, value])))(
    "keeps an own __proto__ key of a security array at %s (value %s) and fails closed like any other extra key",
    async (_where, _label, place, value) => {
      const upstream = stubFetch(() => new Response("{}", { status: 200 }));
      const http = () => httpExecutor({ baseUrl: api.origin, headers: operatorHeaders, fetch: upstream.fetch });
      for (const executor of [trivial, http()]) {
        const control = outcome(fromOpenAPI(place(withOwn([], "extra", value())), { executor }));
        const listed = outcome(fromOpenAPI(place(withOwn([], "__proto__", value())), { executor }));
        expect(listed).toEqual(control);
        // The level is not read as empty: X-Api-Key never becomes caller input.
        expect(listed.tools.every(([keys]) => !(keys as string[]).includes("header"))).toBe(true);
      }
      expect(upstream.urls).toEqual([]);
    },
  );

  it.each(values)("keeps an own __proto__ key (value %s) of a requirement, which names no scheme", (_label, value) => {
    for (const executor of [trivial, httpExecutor({ baseUrl: api.origin, headers: operatorHeaders })]) {
      const control = outcome(fromOpenAPI(documentWith({ operationSecurity: [{ k: [], extra: value() }] }), { executor }));
      const listed = outcome(fromOpenAPI(documentWith({ operationSecurity: [withOwn({ k: [] }, "__proto__", value())] }), { executor }));
      // The same outcome, naming the key it kept.
      expect(JSON.parse(JSON.stringify(listed).replaceAll('\\"__proto__\\"', '\\"extra\\"'))).toEqual(JSON.parse(JSON.stringify(control)));
      expect(listed.tools.every(([keys]) => !(keys as string[]).includes("header"))).toBe(true);
    }
  });
});
