import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describe, expect, it } from "vitest";

import { LangFn } from "../src/client.js";
import { MCPProtocolError, MCPTransportError, ValidationError } from "../src/core/errors.js";
import { createMetric, Evaluator } from "../src/evaluation/index.js";
import { MCPClient } from "../src/mcp/client.js";
import { MCPServer } from "../src/mcp/server.js";
import { SSEMCPTransport } from "../src/mcp/sse.js";
import { StdioMCPTransport } from "../src/mcp/stdio.js";
import { MockChatModel } from "../src/models/mock.js";
import { Tool } from "../src/tools/base.js";

const addTool = new Tool({
  name: "add",
  description: "Add two integers",
  schema: {
    jsonSchema: {
      type: "object",
      properties: {
        a: { type: "integer" },
        b: { type: "integer" }
      },
      required: ["a", "b"]
    },
    parse(data) {
      const value = data as Record<string, unknown>;
      return { a: Number(value.a), b: Number(value.b) };
    }
  },
  async execute(args) {
    return args.a + args.b;
  }
});

describe("mcp and evaluation parity", () => {
  it("round-trips tools/list and tools/call over stdio", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new MCPServer([addTool]);
    await server.connect(new StdioServerTransport(clientToServer, serverToClient));
    const transport = new StdioMCPTransport({
      streams: {
        input: serverToClient,
        output: clientToServer,
        close: async () => {
          clientToServer.end();
          serverToClient.end();
        }
      }
    });
    const client = new MCPClient(transport);

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("add");

    await expect(client.callTool("add", { a: 2, b: 3 })).resolves.toBe(5);
    await client.close();
    await server.close();
  });

  it("normalizes unknown tools and shutdown hangs to canonical MCP errors", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new MCPServer([addTool]);
    await server.connect(new StdioServerTransport(clientToServer, serverToClient));
    const transport = new StdioMCPTransport({
      streams: {
        input: serverToClient,
        output: clientToServer,
        close: async () => {
          clientToServer.end();
          serverToClient.end();
        }
      }
    });
    const client = new MCPClient(transport);

    await expect(client.callTool("missing", {})).rejects.toBeInstanceOf(MCPProtocolError);
    await client.close();
    await server.close();

    const hangingTransport = new StdioMCPTransport({
      closeTimeoutMs: 10,
      streams: {
        input: new PassThrough(),
        output: new PassThrough(),
        close: async () => {
          await new Promise(() => {});
        }
      }
    });
    await expect(hangingTransport.close()).rejects.toBeInstanceOf(MCPTransportError);
  });

  it("round-trips tools over the SSE transport", async () => {
    const server = new MCPServer([addTool]);
    const handler = await server.createWebStandardHandler();
    const transport = new SSEMCPTransport({
      url: "http://langfn.test/mcp",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        return await handler(request);
      }
    });
    const client = new MCPClient(transport);

    await expect(client.listTools()).resolves.toMatchObject([{ name: "add" }]);
    await expect(client.callTool("add", { a: 2, b: 3 })).resolves.toBe(5);
    await client.close();
    await server.close();
  });

  it("supports compare flows, custom metrics, and testfn export hooks", async () => {
    const exportPayloads: Array<Record<string, unknown>> = [];
    const evaluator = new Evaluator();
    const exactLang = new LangFn({ model: new MockChatModel({ responses: ["4", "Paris"] }) });
    const partialLang = new LangFn({ model: new MockChatModel({ responses: ["4", "Lyon"] }) });

    const comparison = await evaluator.compare({
      models: [
        { name: "mockA", lang: exactLang },
        { name: "mockB", lang: partialLang }
      ],
      dataset: [
        { input: "2+2", expected: "4" },
        { input: "capital of France", expected: "Paris" }
      ],
      metrics: [
        createMetric("exact_match", (output, expected) => output.trim() === expected.trim())
      ],
      exportHook(payload) {
        exportPayloads.push(payload as Record<string, unknown>);
      }
    });

    expect(comparison.bestModel).toBe("mockA");
    expect(comparison.perModel.mockA.accuracy).toBe(1);
    expect(comparison.perModel.mockB.accuracy).toBe(0.5);
    expect(comparison.testfnExported).toBe(true);
    expect(exportPayloads).toHaveLength(2);
    expect(exportPayloads[0].summary).toBeTruthy();
  });

  it("fails empty datasets with VALIDATION_ERROR", async () => {
    const evaluator = new Evaluator({ lang: new LangFn({ model: new MockChatModel() }) });
    await expect(evaluator.run([])).rejects.toBeInstanceOf(ValidationError);
  });
});
