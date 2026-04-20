export interface MCPTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface JSONRPCRequest<TParams = Record<string, unknown>> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: TParams;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: TResult;
  error?: JSONRPCError;
}

export interface MCPTransport {
  request<TResult = unknown>(method: string, params?: Record<string, unknown>): Promise<TResult>;
  close(): Promise<void>;
}

export interface ListToolsResult {
  tools: MCPTool[];
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPStreamEndpoint {
  input: unknown;
  output: {
    write(chunk: string, callback?: (error?: Error | null) => void): void;
    end?(callback?: () => void): void;
  };
  close?: () => Promise<void> | void;
}

export function isJSONRPCResponse(value: unknown): value is JSONRPCResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && ("id" in candidate);
}
