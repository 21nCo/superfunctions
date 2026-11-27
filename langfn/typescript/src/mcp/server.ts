import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnManifest,
  type McpFnObjectSchema,
  type McpFnServer
} from "@mcpfn/core";

import { Tool, type ToolContext } from "../tools/base.js";
import { ToolPolicy } from "../tools/policy.js";
import type { MCPTool } from "./types.js";

/**
 * Exposes LangFn tools through the official MCP SDK via McpFn.
 * A fresh protocol server is created for each transport connection.
 */
export class MCPServer {
  readonly registry: McpFnRegistry;
  private readonly activeServers = new Set<McpFnServer>();

  constructor(readonly tools: Array<Tool<any, any>>, readonly policy: ToolPolicy = new ToolPolicy()) {
    this.registry = new McpFnRegistry();
    for (const tool of tools) {
      const definition = tool.json_schema();
      this.registry.register({
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeObjectSchema(definition.parameters),
        annotations: tool.annotations ?? { openWorldHint: true },
        metadata: { "mcpfn/source": "langfn" },
        handler: async (args) => {
          const context: ToolContext = {
            metadata: { transport: "mcp" },
            policy: this.policy
          };
          const result = await tool.run(args, context);
          return structuredResult({ result: result ?? null });
        }
      });
    }
  }

  /** Retains the pre-McpFn descriptor shape for existing LangFn callers. */
  listTools(): MCPTool[] {
    return this.registry.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Record<string, unknown>
    }));
  }

  manifest(): McpFnManifest {
    return this.createServer().manifest();
  }

  async connect(transport: Transport): Promise<void> {
    const server = this.createServer();
    this.activeServers.add(server);
    try {
      await server.connect(transport);
      const onclose = transport.onclose;
      transport.onclose = () => {
        try {
          onclose?.();
        } finally {
          this.activeServers.delete(server);
        }
      };
    } catch (error) {
      this.activeServers.delete(server);
      throw error;
    }
  }

  async serveStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    const server = this.createServer();
    this.activeServers.add(server);
    try {
      await server.connect(transport);
      const onclose = transport.onclose;
      transport.onclose = () => {
        try {
          onclose?.();
        } finally {
          this.activeServers.delete(server);
        }
      };
    } catch (error) {
      this.activeServers.delete(server);
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Options go to McpFn's handler: for a hosted endpoint used from browsers,
   * list their origins in `allowedOrigins` (requests carrying any other
   * Origin are refused).
   */
  async createWebStandardHandler(
    options?: Parameters<McpFnServer["createWebStandardHandler"]>[0],
  ): ReturnType<McpFnServer["createWebStandardHandler"]> {
    const server = this.createServer();
    // Tracked before the await so close() during it still closes the server;
    // dropped again if the options fail validation.
    this.activeServers.add(server);
    let handler: Awaited<ReturnType<McpFnServer["createWebStandardHandler"]>>;
    try {
      handler = await server.createWebStandardHandler(options);
    } catch (error) {
      this.activeServers.delete(server);
      await server.close().catch(() => undefined);
      throw error;
    }
    // close() ran meanwhile and already closed the server: no live handler.
    if (!this.activeServers.has(server)) throw new Error("MCPServer was closed");
    return handler;
  }

  async close(): Promise<void> {
    const servers = [...this.activeServers];
    this.activeServers.clear();
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  }

  private createServer(): McpFnServer {
    return createMcpFnServer({
      info: {
        name: "langfn",
        version: "0.2.2",
        instructions: "Execute LangFn tools with LangFn parsing and policy enforcement."
      },
      registry: this.registry,
      transports: ["stdio", "streamable-http"]
    });
  }
}

function normalizeObjectSchema(schema: Record<string, unknown>): McpFnObjectSchema {
  return {
    ...schema,
    type: "object",
    properties:
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {},
  };
}
