import { MCPProtocolError } from "../core/errors.js";
import type { MCPTool, MCPTransport, ListToolsResult } from "./types.js";

export class MCPClient {
  constructor(readonly transport: MCPTransport) {}

  async listTools(): Promise<MCPTool[]> {
    const result = await this.transport.request<ListToolsResult | MCPTool[]>("tools/list", {});
    if (Array.isArray(result)) {
      return result;
    }
    if (result && Array.isArray(result.tools)) {
      return result.tools;
    }
    throw new MCPProtocolError("Invalid MCP tools/list response", {
      metadata: { result }
    });
  }

  async callTool<T = unknown>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    return await this.transport.request<T>("tools/call", {
      name,
      arguments: arguments_
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
