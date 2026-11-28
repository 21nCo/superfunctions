import { createCredentialRegistry, sanitizeRequestResult, WITHHELD, type CredentialRegistry } from "@apifn/core";
import type {
  Collection,
  CollectionItem,
  CookieJar,
  Environment,
  HttpClient,
  HttpClientResponse,
  HttpRedirectRecord,
  OpenCollectionRequest,
  RequestResult,
  RunOptions,
  RunReporter,
  RunReport,
} from "../types.js";
import { buildRunReport } from "../report.js";
import { createCookieJar, createFetchHttpClient } from "./http-client.js";
import { interpolateVariables, resolveVariableContext } from "../variables.js";
import {
  executePreRequestScript,
  executeTestScript,
  type ScriptRequestContext,
  type ScriptResponseContext,
} from "./script-sandbox.js";

const DEFAULT_TIMEOUT_MS = 30_000;
interface RequestEntry {
  item: CollectionItem;
  request: OpenCollectionRequest;
}

type RequestScripts = NonNullable<NonNullable<OpenCollectionRequest["runtime"]>["scripts"]>;

function sortItems(items: CollectionItem[]): CollectionItem[] {
  return [...items].sort((a, b) => {
    const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
    const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) {
      return aSeq - bSeq;
    }
    return a.name.localeCompare(b.name);
  });
}

function flattenRequestItems(items: CollectionItem[]): RequestEntry[] {
  const output: RequestEntry[] = [];

  function walk(nodes: CollectionItem[]): void {
    for (const node of sortItems(nodes)) {
      if (node.kind === "request" && node.request) {
        output.push({ item: node, request: node.request });
      }

      if (node.kind === "folder" && node.children) {
        walk(node.children);
      }
    }
  }

  walk(items);
  return output;
}

function getEnvironment(collection: Collection, env: string | Environment): Environment {
  if (typeof env !== "string") {
    return env;
  }

  const matched = collection.environments[env];
  if (!matched) {
    throw new Error(`Environment '${env}' not found`);
  }
  return matched;
}

function interpolateRequest(
  request: OpenCollectionRequest,
  context: Record<string, string>,
  processEnv: NodeJS.ProcessEnv
): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  warnings: string[];
} {
  const warnings: string[] = [];

  const urlInterpolated = interpolateVariables(request.http.url, context, { processEnv });
  warnings.push(...urlInterpolated.warnings);

  const headers: Record<string, string> = {};
  for (const header of request.http.headers ?? []) {
    const interpolated = interpolateVariables(header.value, context, { processEnv });
    warnings.push(...interpolated.warnings);
    headers[header.name] = interpolated.value;
  }

  let body: string | undefined;
  if (request.http.body?.data !== undefined) {
    const bodyInterpolated = interpolateVariables(request.http.body.data, context, {
      processEnv,
    });
    warnings.push(...bodyInterpolated.warnings);
    body = bodyInterpolated.value;
  }

  let url = urlInterpolated.value;
  const queryParams = request.http.params?.query ?? [];
  if (queryParams.length > 0) {
    const parsedUrl = new URL(urlInterpolated.value);
    for (const query of queryParams) {
      if (query.enabled === false) {
        continue;
      }
      const interpolated = interpolateVariables(query.value, context, { processEnv });
      warnings.push(...interpolated.warnings);
      parsedUrl.searchParams.set(query.name, interpolated.value);
    }
    url = parsedUrl.toString();
  }

  return {
    method: request.http.method,
    url,
    headers,
    body,
    warnings,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
      });
  });
}

/** Runs work that only records report data; a failure there never changes the run. */
function remember(work: () => void): void {
  try {
    work();
  } catch {
    // The report is sanitized again at its boundary; a value that could not be recorded is redacted by the text rules.
  }
}

function readNumber(read: () => unknown): number | undefined {
  try {
    const value = read();
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copies what the report needs from a client response without letting a
 * throwing or malformed field reject the run or resend the request. A header
 * that cannot be read is withheld; when the header map or the redirects
 * cannot be read at all, the report withholds the body, because credentials
 * they carried could not be collected for scrubbing.
 */
function captureResponse(response: HttpClientResponse) {
  const warnings: string[] = [];
  const headers: Record<string, string> = {};
  let withheld = false;
  try {
    for (const name of Object.keys(response.headers ?? {})) {
      try {
        headers[name] = String(response.headers[name]);
      } catch {
        headers[name] = WITHHELD;
        warnings.push(`Response header '${name}' could not be read.`);
      }
    }
  } catch {
    withheld = true;
    warnings.push("Response headers could not be read; the response body is withheld from the report.");
  }
  let redirects: HttpRedirectRecord[] | undefined;
  try {
    redirects = response.redirects?.map((record) => ({
      status: record.status,
      url: String(record.url),
      location: String(record.location),
      duration: record.duration,
    }));
  } catch {
    withheld = true;
    warnings.push("Response redirects could not be read; the response body is withheld from the report.");
  }
  return { headers, redirects, withheld, warnings, size: readNumber(() => response.size), duration: readNumber(() => response.duration) };
}

function withheldResult(result: RequestResult): RequestResult {
  return {
    name: WITHHELD,
    path: result.path,
    method: result.method,
    url: WITHHELD,
    status: result.status,
    statusCode: result.statusCode,
    duration: result.duration,
    assertions: [],
    error: "Report redaction failed; request details were withheld.",
    request: { method: result.request.method, url: WITHHELD, headers: {} },
  };
}

function sanitizeResult(result: RequestResult, redactHeaders: string[], registry: CredentialRegistry): RequestResult {
  try {
    return sanitizeRequestResult(result, { redactHeaders, registry });
  } catch {
    return withheldResult(result);
  }
}

async function executeRequest(
  entry: RequestEntry,
  options: {
    collection: Collection;
    context: Record<string, string>;
    processEnv: NodeJS.ProcessEnv;
    timeout: number;
    retries: number;
    httpClient: HttpClient;
    cookieJar?: CookieJar;
    redactHeaders: string[];
    registry: CredentialRegistry;
    reporter?: RunReporter;
    isolateContext?: boolean;
    scripts: RequestScripts;
  }
): Promise<RequestResult> {
  options.reporter?.onRequestStart?.(entry.item);

  const requestContext = options.isolateContext ? { ...options.context } : options.context;
  const interpolated = interpolateRequest(entry.request, requestContext, options.processEnv);
  const mutableRequest: ScriptRequestContext = {
    method: interpolated.method,
    url: interpolated.url,
    headers: { ...interpolated.headers },
    body: interpolated.body,
  };
  const assertionResults: RequestResult["assertions"] = [];
  const { scripts, registry } = options;
  // Results leave the runner (reporters, the returned report) only through this boundary.
  const finish = (result: RequestResult): RequestResult => {
    const sanitized = sanitizeResult(result, options.redactHeaders, registry);
    options.reporter?.onRequestComplete?.(sanitized);
    return sanitized;
  };
  const snapshot = (): RequestResult["request"] => ({
    method: mutableRequest.method,
    url: mutableRequest.url,
    headers: { ...mutableRequest.headers },
    ...(mutableRequest.body === undefined ? {} : { body: mutableRequest.body }),
  });

  for (const script of scripts) {
    if (script.type !== "pre-request") {
      continue;
    }

    const preRequestResult = await executePreRequestScript({
      code: script.code,
      req: mutableRequest,
      env: requestContext,
      cookies: options.cookieJar,
    });

    if (preRequestResult.error) {
      const result: RequestResult = {
        name: entry.request.info.name,
        path: entry.item.path,
        method: mutableRequest.method,
        url: mutableRequest.url,
        status: "error",
        duration: 0,
        assertions: [],
        warnings: interpolated.warnings.length ? interpolated.warnings : undefined,
        error: preRequestResult.error.message,
        request: snapshot(),
      };
      return finish(result);
    }
  }

  const attempts: NonNullable<RequestResult["attempts"]> = [];
  let lastError: string | undefined;
  // The request as the runner sends it; scripts that run later cannot change what the report shows.
  const sent = snapshot();
  remember(() => registry.collectRequest(sent));

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const attemptNumber = attempt + 1;
    const startedAt = Date.now();
    let sentHeaders: Record<string, string> | undefined;
    let response: HttpClientResponse;
    let statusCode: number;
    let responseBody: string;

    try {
      response = await withTimeout(
        options.httpClient.send({
          method: mutableRequest.method,
          url: mutableRequest.url,
          headers: mutableRequest.headers,
          body: mutableRequest.body,
          timeout: options.timeout,
          followRedirects: entry.request.settings?.followRedirects,
          maxRedirects: entry.request.settings?.maxRedirects,
          onSent: (hop) => {
            sentHeaders ??= { ...hop.headers };
            remember(() => registry.collectRequest(hop));
          },
          onReceived: (hop) => remember(() => registry.collectResponse(hop)),
        }),
        options.timeout
      );
      statusCode = response.status;
      responseBody = response.body;
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        throw new Error("HTTP client returned an invalid status code");
      }
      if (typeof responseBody !== "string") {
        throw new Error("HTTP client returned a response body that is not a string");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      attempts.push({
        attempt: attemptNumber,
        duration: Date.now() - startedAt,
        error: message,
      });
      continue;
    }

    const captured = captureResponse(response);
    attempts.push({
      attempt: attemptNumber,
      statusCode,
      duration: captured.duration ?? Date.now() - startedAt,
    });
    remember(() => registry.collectResponse({ url: sent.url, headers: captured.headers, redirects: captured.redirects, body: responseBody }));

    if (statusCode >= 500 && attempt < options.retries) {
      continue;
    }

    const warnings = [...interpolated.warnings, ...captured.warnings];
    let result: RequestResult;
    try {
      const parsedResponseBody = (() => {
        try {
          return JSON.parse(responseBody);
        } catch {
          return responseBody;
        }
      })();
      const responseForScripts: ScriptResponseContext = {
        status: statusCode,
        headers: { ...captured.headers },
        body: parsedResponseBody,
        responseTime: captured.duration ?? 0,
      };

      for (const script of scripts) {
        if (script.type !== "tests" && script.type !== "post-response") {
          continue;
        }

        const testResult = await executeTestScript({
          code: script.code,
          req: mutableRequest,
          res: responseForScripts,
          env: requestContext,
          cookies: options.cookieJar,
          assertionResults,
        });

        if (testResult.error) {
          break;
        }
      }
      remember(() => registry.collectNamed(requestContext));

      const hasFailedAssertions = assertionResults.some((assertion) => !assertion.passed);
      const hasExpectedStatus = statusMatchesExpected(statusCode, entry.request.settings?.expectedStatus);
      result = {
        name: entry.request.info.name,
        path: entry.item.path,
        method: sent.method,
        url: sent.url,
        status: !hasExpectedStatus || hasFailedAssertions ? "failed" : "passed",
        statusCode,
        duration: Date.now() - startedAt,
        assertions: assertionResults,
        warnings: warnings.length ? warnings : undefined,
        attempts,
        request: { ...sent, headers: sentHeaders ?? sent.headers },
        response: {
          status: statusCode,
          headers: captured.headers,
          body: captured.withheld ? WITHHELD : responseBody,
          size: captured.size ?? responseBody.length,
          redirects: captured.redirects,
        },
      };
    } catch (error) {
      result = {
        name: entry.request.info.name,
        path: entry.item.path,
        method: sent.method,
        url: sent.url,
        status: "error",
        statusCode,
        duration: Date.now() - startedAt,
        assertions: assertionResults,
        warnings: warnings.length ? warnings : undefined,
        attempts,
        error: error instanceof Error ? error.message : String(error),
        request: { ...sent, headers: sentHeaders ?? sent.headers },
      };
    }
    return finish(result);
  }

  return finish({
    name: entry.request.info.name,
    path: entry.item.path,
    method: sent.method,
    url: sent.url,
    status: "error",
    duration: attempts[attempts.length - 1]?.duration ?? 0,
    assertions: assertionResults,
    warnings: interpolated.warnings.length ? interpolated.warnings : undefined,
    attempts,
    error: lastError ?? "Request failed",
    request: sent,
  });
}

function skippedResult(entry: RequestEntry): RequestResult {
  return {
    name: entry.request.info.name,
    path: entry.item.path,
    method: entry.request.http.method,
    url: entry.request.http.url,
    status: "skipped",
    duration: 0,
    assertions: [],
    request: {
      method: entry.request.http.method,
      url: entry.request.http.url,
      headers: {},
    },
  };
}

function patternMatches(value: string, pattern: string): boolean {
  if (pattern === value) {
    return true;
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function shouldRunEntry(entry: RequestEntry, options: Pick<RunOptions, "include" | "exclude">): boolean {
  const candidates = [
    entry.item.path,
    entry.item.name,
    entry.request.info.name,
    `${entry.request.http.method.toUpperCase()} ${entry.request.http.url}`,
  ];

  const included =
    !options.include ||
    options.include.length === 0 ||
    options.include.some((pattern) =>
      candidates.some((candidate) => patternMatches(candidate, pattern))
    );
  if (!included) {
    return false;
  }

  return !(options.exclude ?? []).some((pattern) =>
    candidates.some((candidate) => patternMatches(candidate, pattern))
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusMatchesExpected(status: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) {
    return status < 400;
  }
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

export async function runCollection(
  collection: Collection,
  options: RunOptions
): Promise<RunReport> {
  const startedAt = new Date();
  const environment = getEnvironment(collection, options.environment);
  const processEnv = options.processEnv ?? {};
  const collectionVariables =
    (collection as unknown as { variables?: Record<string, string> }).variables ?? {};
  const context = resolveVariableContext({
    overrides: options.overrides,
    environment: environment.variables,
    collection: collectionVariables,
  });

  const entries = flattenRequestItems(collection.items);
  const selected = new Map<RequestEntry, RequestScripts>();
  const includePaths = options.includePaths && new Set(options.includePaths);
  for (const entry of entries) {
    if (includePaths && !includePaths.has(entry.item.path)) continue;
    if (!shouldRunEntry(entry, options)) continue;
    const scripts = entry.request.runtime?.scripts ?? [];
    if (!Array.isArray(scripts)) {
      throw new Error(`Expected an array of collection scripts in '${entry.item.path}'.`);
    }
    if (scripts.length && options.allowScripts !== true) {
      throw new Error(
        `Collection scripts are disabled for '${entry.item.path}'. Set allowScripts to true only for trusted collections.`
      );
    }
    selected.set(entry, [...scripts]);
  }
  const reporter = options.reporter;
  reporter?.onStart?.(collection, options);

  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? 0;
  const cookieJar = options.cookieJar ?? createCookieJar();
  const httpClient = options.httpClient ?? createFetchHttpClient({ cookieJar });
  const redactList = [...(options.redactHeaders ?? [])];
  // One registry per run, seeded before the first send, so a credential is scrubbed wherever it appears later.
  const registry = createCredentialRegistry(redactList);
  remember(() => registry.collectNamed(context));
  remember(() => registry.collectNamed(processEnv));
  remember(() => {
    for (const cookie of cookieJar.toJSON()) registry.collectRequest({ headers: { cookie: `${cookie.name}=${cookie.value}` } });
  });
  const skip = (entry: RequestEntry): RequestResult => sanitizeResult(skippedResult(entry), redactList, registry);

  const results: Array<RequestResult | undefined> = new Array(entries.length);
  let bailTriggered = false;

  if (options.parallel) {
    const concurrency = Math.max(1, options.concurrency ?? 4);
    let pointer = 0;

    async function worker(): Promise<void> {
      while (pointer < entries.length) {
        const index = pointer;
        pointer += 1;

        if (options.bail && bailTriggered) {
          continue;
        }

        const entry = entries[index];
        const scripts = selected.get(entry);
        if (!scripts) {
          const skipped = skip(entry);
          results[index] = skipped;
          reporter?.onRequestComplete?.(skipped);
          continue;
        }

        const result = await executeRequest(entry, {
          collection,
          context,
          processEnv,
          timeout: entry.request.settings?.timeout ?? timeout,
          retries,
          httpClient,
          cookieJar,
          redactHeaders: redactList,
          registry,
          reporter,
          isolateContext: true,
          scripts,
        });

        results[index] = result;
        if (options.bail && (result.status === "failed" || result.status === "error")) {
          bailTriggered = true;
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } else {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (options.bail && bailTriggered) {
        results[index] = skip(entry);
        continue;
      }

      const scripts = selected.get(entry);
      if (!scripts) {
        const skipped = skip(entry);
        results[index] = skipped;
        reporter?.onRequestComplete?.(skipped);
        continue;
      }

      const result = await executeRequest(entry, {
        collection,
        context,
        processEnv,
        timeout: entry.request.settings?.timeout ?? timeout,
        retries,
        httpClient,
        cookieJar,
        redactHeaders: redactList,
        registry,
        reporter,
        scripts,
      });

      results[index] = result;

      if (options.bail && (result.status === "failed" || result.status === "error")) {
        bailTriggered = true;
      }

      if (options.delay && index < entries.length - 1) {
        await sleep(options.delay);
      }
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    if (!results[index]) {
      const skipped = skip(entries[index]);
      results[index] = skipped;
      reporter?.onRequestComplete?.(skipped);
    }
  }

  const completedAt = new Date();
  const report = buildRunReport({
    collectionName: collection.info.name,
    environment: environment.name,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    results: results as RequestResult[],
  });

  reporter?.onComplete?.(report);
  return report;
}
