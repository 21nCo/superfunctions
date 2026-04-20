import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { MCPProtocolError, MCPTransportError } from "../core/errors.js";
import type { JSONRPCRequest, JSONRPCResponse, MCPStreamEndpoint, MCPTransport } from "./types.js";
import { isJSONRPCResponse } from "./types.js";

export interface StdioMCPTransportOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  streams?: MCPStreamEndpoint;
  closeTimeoutMs?: number;
}

export class StdioMCPTransport implements MCPTransport {
  private readonly closeTimeoutMs: number;
  private readonly options: StdioMCPTransportOptions;
  private child?: ChildProcessWithoutNullStreams;
  private endpoint?: MCPStreamEndpoint;
  private reader?: {
    on(event: "line", listener: (line: string) => void): void;
    on(event: "close", listener: () => void): void;
    close(): void;
  };
  private started = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();

  constructor(options: StdioMCPTransportOptions) {
    this.options = options;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 250;
  }

  async request<TResult = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TResult> {
    await this.start();
    const endpoint = this.endpoint;
    if (!endpoint) {
      throw new MCPTransportError("MCP stdio transport is not started");
    }

    const id = this.nextId++;
    const payload: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };
    const body = `${JSON.stringify(payload)}\n`;
    const writable = endpoint.output;

    return await new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writable.write(body, (error?: Error | null) => {
        if (error) {
          this.pending.delete(id);
          reject(new MCPTransportError("Failed to write MCP stdio request", { cause: error }));
        }
      });
    });
  }

  async close(): Promise<void> {
    const endpoint = this.endpoint ?? this.options.streams;
    const child = this.child;
    this.reader?.close();
    this.reader = undefined;

    for (const pending of this.pending.values()) {
      pending.reject(new MCPTransportError("MCP transport closed before a response was received"));
    }
    this.pending.clear();

    try {
      if (endpoint?.close) {
        await withTimeout(Promise.resolve(endpoint.close()), this.closeTimeoutMs, "MCP stream shutdown timed out");
      } else if (endpoint?.output && "end" in endpoint.output && typeof endpoint.output.end === "function") {
        await new Promise<void>((resolve) => {
          endpoint.output.end?.(resolve);
        });
      }

      if (child) {
        child.kill("SIGTERM");
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
          }),
          this.closeTimeoutMs,
          "MCP process shutdown timed out"
        );
      }
    } finally {
      this.child = undefined;
      this.endpoint = undefined;
      this.started = false;
    }
  }

  private async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.options.streams) {
      this.endpoint = this.options.streams;
    } else if (this.options.command) {
      this.child = spawn(this.options.command, this.options.args ?? [], {
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.endpoint = {
        input: this.child.stdout,
        output: this.child.stdin,
        close: async () => {
          this.child?.kill("SIGTERM");
        }
      };
    } else {
      throw new MCPTransportError("StdioMCPTransport requires command or streams");
    }

    this.reader = readline.createInterface({
      input: this.endpoint.input
    });
    this.reader.on("line", (line: string) => {
      this.handleLine(line);
    });
    this.reader.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new MCPTransportError("MCP transport closed"));
      }
      this.pending.clear();
    });
    this.started = true;
  }

  private handleLine(line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    if (!isJSONRPCResponse(response)) {
      return;
    }
    const pending = this.pending.get(Number(response.id));
    if (!pending) {
      return;
    }
    this.pending.delete(Number(response.id));
    if (response.error) {
      pending.reject(
        new MCPProtocolError(response.error.message, {
          metadata: { error: response.error }
        })
      );
      return;
    }
    pending.resolve(response.result);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new MCPTransportError(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
