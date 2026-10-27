import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { generateSdk, SDK_TARGETS, writeSdk, type SdkGenerationResult } from "../src/index.js";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(PACKAGE_DIR, "fixtures");

export function readJson<T = any>(file: string): T {
  return JSON.parse(readFileSync(path.isAbsolute(file) ? file : path.join(FIXTURES, file), "utf8")) as T;
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function fixtureCatalog(): any {
  return readJson("catalog/catalog.json");
}

export function fixtureConfig(): any {
  return readJson("typescript/sdk.config.json");
}

export function generate(catalog: unknown = fixtureCatalog(), config: unknown = fixtureConfig()): SdkGenerationResult {
  return generateSdk({ catalog, config, targets: SDK_TARGETS });
}

const temporary: string[] = [];

export function tempDir(prefix = "apifn-sdk-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Type-checks and emits a generated package with its own tsconfig; returns the diagnostics as text. */
export function compile(packageDir: string): string[] {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(packageDir, "tsconfig.json"), {}, host)!;
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emitted = program.emit();
  return [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].map((diagnostic) => {
    const where = diagnostic.file ? `${path.relative(packageDir, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1} ` : "";
    return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
}

/** Generates the fixture SDK into a temp directory, compiles it and imports its entry point. */
export async function buildFixtureSdk(config: unknown = fixtureConfig(), catalog: unknown = fixtureCatalog()): Promise<{ dir: string; sdk: any }> {
  const dir = tempDir();
  const result = generate(catalog, config);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const written = await writeSdk(dir, result);
  if (!written.ok) throw new Error(JSON.stringify(written.diagnostics));
  const errors = compile(dir);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const sdk = await import(pathToFileURL(path.join(dir, "dist/index.js")).href);
  return { dir, sdk };
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Close the connection without a response. */
  destroy?: boolean;
  /** Wait before answering. */
  delayMs?: number;
}

/** A local HTTP server answering requests from a queue and recording what it received. */
export class FixtureServer {
  readonly requests: RecordedRequest[] = [];
  #queue: ScriptedResponse[] = [];
  #server: Server | null = null;
  #sockets = new Set<import("node:net").Socket>();
  baseUrl = "";

  async start(): Promise<void> {
    this.#server = createServer((request, response) => void this.#handle(request, response));
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address() as import("node:net").AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  reset(responses: ScriptedResponse[] = []): void {
    this.requests.length = 0;
    this.#queue = [...responses];
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = request.url ?? "/";
    const mark = url.indexOf("?");
    this.requests.push({
      method: request.method ?? "",
      path: mark === -1 ? url : url.slice(0, mark),
      query: mark === -1 ? "" : url.slice(mark + 1),
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    const next = this.#queue.shift() ?? { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    if (next.delayMs) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    if (next.destroy) {
      request.socket.destroy();
      return;
    }
    if (response.destroyed) return;
    response.writeHead(next.status ?? 200, next.headers ?? {});
    response.end(next.body ?? "");
  }
}

/** Builds a generated client's params object from a vector's wire-level parameters. */
export function paramsFor(catalog: any, operationId: string, vector: { parameters?: Record<string, Record<string, unknown>>; body?: unknown; bodyBytes?: number[] }): Record<string, unknown> {
  const operation = catalog.operations.find((candidate: any) => candidate.id === operationId);
  if (!operation) throw new Error(`unknown operation ${operationId}`);
  const params: Record<string, unknown> = {};
  for (const [location, values] of Object.entries(vector.parameters ?? {})) {
    for (const [name, value] of Object.entries(values)) {
      const parameter = operation.parameters.find((candidate: any) => candidate.in === location && candidate.name === name);
      if (!parameter) throw new Error(`${operationId} has no ${location} parameter ${name}`);
      params[camel(name)] = value;
    }
  }
  if ("body" in vector) params.body = vector.body;
  if (vector.bodyBytes) params.body = new Uint8Array(vector.bodyBytes);
  return params;
}

function camel(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((word, index) => (index === 0 ? word[0].toLowerCase() + word.slice(1) : word[0].toUpperCase() + word.slice(1))).join("");
}

export function methodFor(catalog: any, operationId: string): string {
  return catalog.operations.find((candidate: any) => candidate.id === operationId).name;
}

/** A success response in the operation's first documented media type, so request vectors can ignore the response. */
export function okResponse(catalog: any, operationId: string): ScriptedResponse {
  const operation = catalog.operations.find((candidate: any) => candidate.id === operationId);
  const success = operation.responses.find((response: any) => response.kind === "success");
  const content = success?.contents[0];
  if (!content) return { status: Number(success?.status ?? 204) };
  const json = /json$/.test(content.mediaType);
  return { status: Number(success.status), headers: { "content-type": content.mediaType }, body: json ? "{}" : "ok" };
}
