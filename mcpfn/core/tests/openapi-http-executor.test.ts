import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
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
  ])("checks and redacts a credential echoed in %s", async (_label, body, contentType) => {
    const { fetch } = stubFetch(() => new Response(body, { status: 200, headers: { "content-type": contentType } }));
    const success = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch }), operationOf("echo"));
    expect(success.isError).toBe(true);
    expect(text(success)).toContain("reveals an operator credential and was withheld");
    const failing = stubFetch(() => new Response(body, { status: 500, headers: { "content-type": contentType } }));
    const failure = await execute(httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: failing.fetch }), operationOf("echo"));
    expect(text(failure)).toBe("The API responded with HTTP 500.\n\nseen [REDACTED]");
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

  it("checks the pretty-printed text of structured content, not only its compact serialization", async () => {
    // Only the pretty-printed text content holds the credential: "test": "key".
    const headers = { "x-api-key": 'test": "key' };
    const result = await execute(
      httpExecutor<Context>({ baseUrl: api.origin, headers, fetch: reply('{"test":"key"}', 200) }),
      operationOf("echo"),
      {},
      { hasOutputSchema: true },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("reveals an operator credential and was withheld");
  });
});
