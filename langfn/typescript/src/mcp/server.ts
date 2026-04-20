import { Tool, type ToolContext } from "../tools/base.js";
import { ToolPolicy } from "../tools/policy.js";
import { MCPProtocolError, ValidationError } from "../core/errors.js";
import type { CallToolParams, JSONRPCRequest, JSONRPCResponse, MCPTool } from "./types.js";

export class MCPServer {
  constructor(readonly tools: Array<Tool<any, any>>) {}

  listTools(): MCPTool[] {
    return this.tools
      .map((tool) => {
        const definition = tool.json_schema();
        return {
          name: tool.name,
          description: tool.description,
          input_schema: definition.parameters ?? { type: "object", properties: {} }
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async handle(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    try {
      if (request.method === "tools/list") {
        return ok(request.id, { tools: this.listTools() });
      }
      if (request.method === "tools/call") {
        const params = validateCallParams(request.params);
        const tool = this.tools.find((candidate) => candidate.name === params.name);
        if (!tool) {
          throw new MCPProtocolError(`Unknown tool: ${params.name}`, { metadata: { name: params.name } });
        }
        const context: ToolContext = {
          metadata: { transport: "mcp" },
          policy: new ToolPolicy()
        };
        const result = await tool.run(params.arguments ?? {}, context);
        return ok(request.id, result);
      }
      throw new MCPProtocolError(`Unknown method: ${request.method}`, { metadata: { method: request.method } });
    } catch (error) {
      return err(request.id, error);
    }
  }

  async handleSSERequest(request: Request): Promise<Response> {
    let payload: JSONRPCRequest;
    try {
      payload = (await request.json()) as JSONRPCRequest;
    } catch (error) {
      const response = err(0, new ValidationError("Invalid MCP request body", { cause: error }));
      return sseResponse(response);
    }
    return sseResponse(await this.handle(payload));
  }
}

function validateCallParams(value: unknown): CallToolParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("MCP tools/call params must be an object");
  }
  const params = value as Record<string, unknown>;
  if (typeof params.name !== "string" || params.name.length === 0) {
    throw new ValidationError("MCP tools/call params require a tool name");
  }
  if (params.arguments !== undefined && (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments))) {
    throw new ValidationError("MCP tools/call arguments must be an object");
  }
  return {
    name: params.name,
    arguments: (params.arguments ?? {}) as Record<string, unknown>
  };
}

function ok(id: number | string, result: unknown): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function err(id: number | string, error: unknown): JSONRPCResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof MCPProtocolError ? -32601 : -32000;
  const data =
    error && typeof error === "object" && "code" in error
      ? {
          code: (error as { code: string }).code,
          ...(error instanceof Error && "metadata" in error ? { metadata: (error as any).metadata } : {})
        }
      : undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  };
}

function sseResponse(response: JSONRPCResponse): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    }
  });
}
