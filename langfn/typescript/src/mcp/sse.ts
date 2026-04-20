import { MCPProtocolError, MCPTransportError } from "../core/errors.js";
import type { JSONRPCRequest, JSONRPCResponse, MCPTransport } from "./types.js";
import { isJSONRPCResponse } from "./types.js";

export interface SSEMCPTransportOptions {
  url: string;
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
}

export class SSEMCPTransport implements MCPTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly headers?: HeadersInit;
  private nextId = 1;
  private readonly controllers = new Set<AbortController>();

  constructor(options: SSEMCPTransportOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers;
  }

  async request<TResult = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TResult> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const payload: JSONRPCRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params
    };

    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...(this.headers ?? {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new MCPTransportError("SSE transport returned a non-success status", {
          metadata: { status: response.status }
        });
      }

      const text = await response.text();
      const frame = parseSSEFrame(text);
      if (!isJSONRPCResponse(frame)) {
        throw new MCPProtocolError("Invalid SSE MCP response", {
          metadata: { frame }
        });
      }
      if (frame.error) {
        throw new MCPProtocolError(frame.error.message, {
          metadata: { error: frame.error }
        });
      }
      return frame.result as TResult;
    } finally {
      this.controllers.delete(controller);
    }
  }

  async close(): Promise<void> {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

function parseSSEFrame(text: string): JSONRPCResponse | unknown {
  const line = text
    .split("\n")
    .find((entry) => entry.startsWith("data:"));
  if (!line) {
    throw new MCPTransportError("SSE transport returned no data frame");
  }
  try {
    return JSON.parse(line.slice(5).trim()) as JSONRPCResponse;
  } catch (error) {
    throw new MCPProtocolError("Failed to parse SSE MCP payload", { cause: error });
  }
}
