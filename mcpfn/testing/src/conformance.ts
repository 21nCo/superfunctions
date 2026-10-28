import { terminateConformanceRunner, terminateConformanceRunnerOnExit } from "./conformance-process.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import {
  acquireRemoteCredential,
  redactRemoteCredential,
  validateRemoteCredentialHeaders,
  type McpFnRemoteCredential,
  type McpFnRemoteCredentialProvider,
} from "./remote-target.js";
import {
  normalizeMcpFnReportFailure,
  type McpFnReportFailure,
} from "./reports.js";

const ownedConformanceSignalHandlers = new Set<() => void>();
function hasForeignSignalHandler(signal: "SIGINT" | "SIGTERM"): boolean {
  return process.listeners(signal).some(listener => !ownedConformanceSignalHandlers.has(listener as () => void));
}

export const OFFICIAL_CONFORMANCE_VERSION = "0.1.16";

export interface OfficialConformanceOptions {
  url: string;
  suite?: "active" | "all" | "pending";
  scenario?: string;
  expectedFailures?: string;
  outputDir?: string;
  specVersion?: string;
  verbose?: boolean;
  cwd?: string;
  stdio?: "inherit" | "pipe";
  /** Runner deadline in milliseconds (1..2,147,483,647); defaults to 120,000. */
  timeoutMs?: number;
  /** Cancels the runner and its owned process group. */
  signal?: AbortSignal;
  /** Environment names removed before spawning the upstream runner. */
  sensitiveEnvironmentVariables?: readonly string[];
}

export interface OfficialConformanceResult {
  formatVersion: 1;
  kind: "mcpfn.official-conformance-report";
  ok: boolean;
  suiteVersion: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: McpFnReportFailure;
  /** Credential cleanup failure, separate from the upstream runner diagnosis. */
  cleanupFailure?: McpFnReportFailure;
}

export interface AuthenticatedConformanceProxy {
  /** Loopback URL to pass to the official conformance runner. */
  url: string;
  close(): Promise<void>;
}

export interface AuthenticatedConformanceProxyOptions {
  /** Fixed loopback MCP URL. Requests cannot select a different origin or path. */
  url: string;
  /** Headers injected into requests using the proxy's own authority. Values are never logged. */
  headers: HeadersInit;
}

export interface AuthenticatedOfficialConformanceOptions extends OfficialConformanceOptions {
  /** Preferred typed credential lifecycle. */
  credential?: McpFnRemoteCredential | McpFnRemoteCredentialProvider;
  /** Backward-compatible static header input. Prefer credential. */
  headers?: HeadersInit;
}

function validateAuthenticatedConformanceUrl(url: string): { upstream: URL; hostname: string } {
  const upstream = new URL(url);
  if (!["http:", "https:"].includes(upstream.protocol)) {
    throw new TypeError(
      "Authenticated conformance upstream must use HTTP or HTTPS",
    );
  }
  if (upstream.username || upstream.password || upstream.hash) {
    throw new TypeError(
      "Authenticated conformance upstream must not contain userinfo or a fragment",
    );
  }
  const hostname = normalizeLoopbackHostname(upstream.hostname);
  if (!hostname) {
    throw new TypeError(
      "Authenticated conformance upstream must use a literal loopback address",
    );
  }
  return { upstream, hostname };
}

/**
 * Start a loopback-only streaming proxy for runners that cannot send auth
 * headers. Authenticated requests use one fixed upstream authority and path.
 * Host-manipulation probes are forwarded without injected credentials.
 */
export async function createAuthenticatedConformanceProxy(
  options: AuthenticatedConformanceProxyOptions,
): Promise<AuthenticatedConformanceProxy> {
  const { upstream, hostname } = validateAuthenticatedConformanceUrl(options.url);
  const protocol = upstream.protocol === "https:" ? "https:" : "http:";
  const port = upstream.port === "" ? undefined : Number(upstream.port);
  const requestPath = `${upstream.pathname}${upstream.search}`;
  const injected = validateRemoteCredentialHeaders(options.headers);
  const activeRequests = new Set<ReturnType<typeof httpRequest>>();
  const activeSockets = new Set<Socket>();
  let proxyAuthority: string | undefined;
  const server = createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith("/")) {
      outgoing.writeHead(400).end();
      return;
    }
    const headers: IncomingHttpHeaders = { ...incoming.headers };
    delete headers.connection;
    const usesProxyAuthority = incoming.headers.host === proxyAuthority;
    injected.forEach((value, name) => {
      const normalizedName = name.toLowerCase();
      delete headers[normalizedName];
      if (usesProxyAuthority) headers[normalizedName] = value;
    });
    // Authenticated traffic is pinned to the upstream Host. Host-manipulation
    // probes retain their hostile value, but never receive injected credentials.
    if (usesProxyAuthority) headers.host = upstream.host;
    const transport = protocol === "https:" ? httpsRequest : httpRequest;
    const proxied = transport(
      {
        protocol,
        hostname,
        port,
        path: requestPath,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    activeRequests.add(proxied);
    proxied.once("close", () => activeRequests.delete(proxied));
    proxied.once("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.once("aborted", () => proxied.destroy());
    incoming.pipe(proxied);
  });
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Authenticated conformance proxy did not bind a TCP port");
  }
  const url = new URL(
    upstream.pathname + upstream.search,
    `http://127.0.0.1:${address.port}`,
  );
  proxyAuthority = url.host;
  let closePromise: Promise<void> | undefined;
  return {
    url: url.toString(),
    close: () => {
      closePromise ??= (async () => {
        for (const request of activeRequests) request.destroy();
        for (const socket of activeSockets) socket.destroy();
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      })();
      return closePromise;
    },
  };
}

function normalizeLoopbackHostname(
  hostname: string,
): string | undefined {
  const parts = hostname.split(".");
  if (parts.length === 4 && parts[0] === "127" && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return hostname;
  if (hostname === "[::1]") return "::1";
  return undefined;
}

function npxInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npx", args };
  const npmExecPath = process.env.npm_execpath;
  const candidates = [
    npmExecPath ? path.join(path.dirname(npmExecPath), "npx-cli.js") : undefined,
    path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npx-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npx-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npxCli = candidates.find((candidate) => existsSync(candidate));
  if (!npxCli) {
    throw new Error("Unable to locate npm's npx-cli.js for the official MCP conformance runner");
  }
  return { command: process.execPath, args: [npxCli, ...args] };
}

export function buildOfficialConformanceArgs(
  options: OfficialConformanceOptions,
): string[] {
  const args = [
    "--yes",
    `@modelcontextprotocol/conformance@${OFFICIAL_CONFORMANCE_VERSION}`,
    "server",
    "--url",
    options.url,
  ];
  if (options.suite) args.push("--suite", options.suite);
  if (options.scenario) args.push("--scenario", options.scenario);
  if (options.expectedFailures) {
    args.push("--expected-failures", options.expectedFailures);
  }
  if (options.outputDir) args.push("--output-dir", options.outputDir);
  if (options.specVersion) args.push("--spec-version", options.specVersion);
  if (options.verbose) args.push("--verbose");
  return args;
}

export function buildOfficialConformanceEnvironment(
  sensitiveNames: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  const sensitive = new Set(sensitiveNames.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (sensitive.has(name.toLowerCase())) delete environment[name];
  }
  environment.PATH = [path.dirname(process.execPath), environment.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  return environment;
}

export async function runOfficialConformance(options: OfficialConformanceOptions): Promise<OfficialConformanceResult> {
  return runConformance(options, value => String(redactOAuthValue(value, { maxStringLength: 262_144 })));
}

async function runConformance(
  options: OfficialConformanceOptions,
  redactOutput: (value: string) => string,
): Promise<OfficialConformanceResult> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor < 22) {
    throw new Error(
      `Official MCP conformance ${OFFICIAL_CONFORMANCE_VERSION} requires Node.js 22 or newer; current runtime is ${process.versions.node}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Conformance timeoutMs must be an integer from 1 through 2147483647");
  }
  if (options.signal?.aborted) return failedConformance("Official conformance was aborted");
  const args = buildOfficialConformanceArgs(options);
  const invocation = npxInvocation(args);
  const childEnvironment = buildOfficialConformanceEnvironment(options.sensitiveEnvironmentVariables);

  return await new Promise<OfficialConformanceResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: process.platform !== "win32",
      cwd: options.cwd,
      env: childEnvironment,
      stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let stopping = false;
    let termination: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("exit", onExit);
      ownedConformanceSignalHandlers.delete(onSigint);
      ownedConformanceSignalHandlers.delete(onSigterm);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
    };
    const finish = (code: number | null, forcedMessage?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (forcedMessage !== undefined) {
        resolve(failedConformance(forcedMessage));
        return;
      }
      let safeStdout = "";
      let safeStderr = "";
      try {
        safeStdout = redactOutput(stdout);
        safeStderr = redactOutput(stderr);
      } catch {
        resolve(failedConformance("Conformance output omitted because credential redaction exceeded its bounds"));
        return;
      }
      const exitCode = code ?? 1;
      const failure = exitCode === 0 ? undefined : normalizeMcpFnReportFailure(
        new Error(safeStderr || safeStdout || `Official conformance exited ${exitCode}`), "upstream-conformance",
      );
      resolve({ formatVersion: 1, kind: "mcpfn.official-conformance-report", ok: exitCode === 0,
        suiteVersion: OFFICIAL_CONFORMANCE_VERSION, exitCode, stdout: safeStdout, stderr: safeStderr,
        ...(failure ? { failure } : {}),
      });
    };
    const stop = (message: string) => {
      if (settled || stopping) return termination ?? Promise.resolve();
      stopping = true;
      // Wait for bounded group cleanup even when the wrapper emits close first.
      termination = terminateConformanceRunner(child).finally(() => finish(1, message));
      return termination;
    };
    const onExit = () => terminateConformanceRunnerOnExit(child);
    const onAbort = () => { void stop("Official conformance was aborted"); };
    const onProcessSignal = (signal: "SIGINT" | "SIGTERM") => {
      // once() listeners may already be removed while their async shutdown is
      // still running. Remember foreign handlers seen before or during dispatch.
      const hostOwnsShutdown = foreignAtRegistration[signal] || hasForeignSignalHandler(signal);
      void stop(`Official conformance interrupted by ${signal}`).finally(() => {
        // Existing application handlers already received the original signal. If
        // none remain, restore Node's default termination after group cleanup.
        if (!hostOwnsShutdown && process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    const onSigint = () => onProcessSignal("SIGINT");
    const onSigterm = () => onProcessSignal("SIGTERM");
    const onError = (error: Error) => {
      if (!stopping) void stop(String(redactOAuthValue(error.message)));
    };
    const onClose = (code: number | null) => {
      if (stopping || settled) return;
      stopping = true;
      // A wrapper may exit while descendants with detached stdio remain alive.
      termination = terminateConformanceRunner(child).finally(() => finish(code));
    };
    const capture = (chunk: string, stream: "stdout" | "stderr") => {
      if (settled || stopping) return;
      capturedBytes += Buffer.byteLength(chunk, "utf8");
      if (capturedBytes > 262_144) {
        stdout = ""; stderr = "";
        void stop("Conformance output exceeded its capture limit");
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    const onStdout = (chunk: string) => capture(chunk, "stdout");
    const onStderr = (chunk: string) => capture(chunk, "stderr");
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    const foreignAtRegistration = { SIGINT: hasForeignSignalHandler("SIGINT"), SIGTERM: hasForeignSignalHandler("SIGTERM") };
    ownedConformanceSignalHandlers.add(onSigint);
    ownedConformanceSignalHandlers.add(onSigterm);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.once("exit", onExit);
    timer = setTimeout(() => stop(`Official conformance timed out after ${timeoutMs}ms`), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Cover cancellation between the initial check and listener registration.
    if (options.signal?.aborted) onAbort();
  });
}

function failedConformance(message: string): OfficialConformanceResult {
  const failure = normalizeMcpFnReportFailure(new Error(message), "upstream-conformance");
  return { formatVersion: 1, kind: "mcpfn.official-conformance-report", ok: false,
    suiteVersion: OFFICIAL_CONFORMANCE_VERSION, exitCode: 1, stdout: "", stderr: failure.message, failure };
}

const retainedConformanceCleanup = new WeakMap<Error, () => Promise<void>>();

/** Cleanup failed after retries. Retain this error and call retryCleanup(). */
export class McpFnConformanceCleanupError extends Error {
  constructor(release: () => Promise<void>, readonly result?: OfficialConformanceResult) {
    super("Authenticated conformance credential cleanup failed; retry cleanup");
    this.name = "McpFnConformanceCleanupError";
    retainedConformanceCleanup.set(this, release);
  }
  async retryCleanup(): Promise<void> {
    const release = retainedConformanceCleanup.get(this);
    if (!release) return;
    try { await release(); }
    catch { throw this; }
    retainedConformanceCleanup.delete(this);
  }
}

/**
 * Run the pinned official suite against an authenticated MCP endpoint.
 * Always captures stdio (even when inherit is requested) to redact credentials.
 * outputDir is rejected before acquisition; only the returned redacted result is safe to persist.
 */
export async function runAuthenticatedOfficialConformance(
  options: AuthenticatedOfficialConformanceOptions,
): Promise<OfficialConformanceResult> {
  if (options.outputDir !== undefined) throw new TypeError("Authenticated conformance does not support outputDir; serialize the redacted result instead");
  const { headers, credential, ...conformance } = options;
  if ((headers === undefined) === (credential === undefined)) {
    throw new TypeError("Provide exactly one of credential or headers for authenticated conformance");
  }
  if (options.signal?.aborted) return failedConformance("Official conformance was aborted");
  validateAuthenticatedConformanceUrl(conformance.url);
  const lease = await acquireRemoteCredential(
    credential ?? { headers: headers! },
    {
      url: conformance.url,
      requestId: randomUUID(),
    },
  );
  let proxy: AuthenticatedConformanceProxy | undefined;
  let result: OfficialConformanceResult | undefined;
  let operationFailure: { error: Error } | undefined;
  const safeFailure = (error: unknown): { error: Error } => {
    let message = "Authenticated conformance operation failed";
    try { message = redactRemoteCredential(lease.credential, error instanceof Error ? error.message : String(error)); }
    catch { /* Keep a safe fallback if redaction exceeds its budget. */ }
    return { error: new Error(message) };
  };
  try {
    proxy = await createAuthenticatedConformanceProxy({
      url: conformance.url,
      headers: lease.credential.headers,
    });
    result = redactRemoteCredential(lease.credential, await runConformance({ ...conformance, stdio: "pipe", url: proxy.url }, value => String(redactRemoteCredential(lease.credential, value))), { preserveKeys: true });
  } catch (error) {
    operationFailure = safeFailure(error);
  }
  try { await proxy?.close(); }
  catch (error) { operationFailure ??= safeFailure(error); }
  let released = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await lease.release(); released = true; break; } catch { /* Retry transient revocation failure. */ }
  }
  if (!released) {
    const message = "Authenticated conformance credential cleanup failed; retry cleanup";
    const cleanupFailure = normalizeMcpFnReportFailure(new Error(message), lease.cleanupPhase());
    const failedResult = result ? { ...result, ok: false, exitCode: result.exitCode || 1,
      cleanupFailure,
      ...(result.failure ? {} : { failure: cleanupFailure }),
    } : undefined;
    throw new McpFnConformanceCleanupError(() => lease.release(), failedResult);
  }
  if (operationFailure) throw operationFailure.error;
  if (!result) throw new Error("Conformance produced no result");
  return result;
}
