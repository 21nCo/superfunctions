import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpFnServer } from "@mcpfn/core";
import { fromOpenAPI, httpExecutor } from "@mcpfn/core/openapi";
import { describe, expect, it } from "vitest";

import { createMcpFnClient, customTarget } from "../src/index.js";

// Made-up credential, built at run time and obviously fake.
const operatorToken = ["test", "operator", "token"].join("-");

const document = {
  openapi: "3.1.0",
  info: { title: "pets", version: "1.0.0" },
  paths: {
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "fields", in: "query", schema: { type: "array", items: { type: "string" } } },
        ],
        responses: {
          "200": {
            description: "A pet",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" }, name: { type: "string" } },
                  required: ["id", "name"],
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("fromOpenAPI + httpExecutor behind McpFnServer", () => {
  it("lists the tool and calls the API through @mcpfn/client with the operator's credentials", async () => {
    const received: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const api = createServer((request, response) => {
      received.push({ url: request.url ?? "", headers: request.headers });
      const id = decodeURIComponent((request.url ?? "").split("?")[0]!.split("/").at(-1)!);
      if (id === "missing") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found", auth: request.headers.authorization }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id, name: "Rex" }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const { port } = api.address() as AddressInfo;

    const { registry, skipped } = fromOpenAPI<{ apiToken: string }>(document, {
      executor: httpExecutor<{ apiToken: string }>({
        baseUrl: `http://127.0.0.1:${port}/api`,
        headers: ({ apiToken }) => ({ authorization: `Bearer ${apiToken}` }),
      }),
    });
    expect(skipped).toEqual([]);
    const server = createMcpFnServer({
      info: { name: "openapi-e2e", version: "1.0.0" },
      registry,
      context: () => ({ apiToken: operatorToken }),
    });
    const client = createMcpFnClient({
      target: customTarget({
        kind: "in-memory",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
    });

    try {
      await client.connect();
      const tools = await client.tools.listAll();
      expect(tools.map((tool) => tool.name)).toEqual(["getPet"]);
      expect(tools[0]!.outputSchema).toMatchObject({ type: "object", required: ["id", "name"] });

      const result = await client.tools.call("getPet", { path: { id: "p 1" }, query: { fields: ["id", "name"] } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ id: "p 1", name: "Rex" });
      expect(received.at(-1)).toMatchObject({
        url: "/api/pets/p%201?fields=id&fields=name",
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      const missing = await client.tools.call("getPet", { path: { id: "missing" } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("HTTP 404");
      expect(JSON.stringify(missing)).not.toContain(operatorToken);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => {
        api.closeAllConnections();
        api.close(() => resolve());
      });
    }
  });
});
