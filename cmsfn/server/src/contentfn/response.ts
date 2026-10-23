import { err, ok, type CmsfnEnvelope, type CmsfnErrorCode } from "cmsfn";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mappedCode(code: string): CmsfnErrorCode {
  switch (code) {
    case "AUTH_REQUIRED": case "PERMISSION_DENIED": case "VALIDATION_FAILED":
    case "PAYLOAD_TOO_LARGE": case "RATE_LIMITED": case "NOT_FOUND": case "CONFLICT":
    case "PREVIEW_NOT_CONFIGURED": case "CONTENTFN_UNAVAILABLE": case "INTERNAL_ERROR": return code;
    case "DATASET_NOT_FOUND": case "DOCUMENT_NOT_FOUND": case "SCHEMA_NOT_FOUND":
    case "ASSET_NOT_FOUND": case "WEBHOOK_NOT_FOUND": return "NOT_FOUND";
    case "DATASET_ALREADY_EXISTS": case "DOCUMENT_ALREADY_EXISTS":
    case "SCHEMA_VERSION_CONFLICT": case "REV_CONFLICT": return "CONFLICT";
    case "SCHEMA_INVALID": case "PATCH_INVALID": case "QUERY_INVALID": case "QUERY_TOO_COMPLEX": return "VALIDATION_FAILED";
    default: return "CONTENTFN_UNAVAILABLE";
  }
}

export interface ContentfnRequestOptions {
  headers?: NonNullable<RequestInit["headers"]>;
  maxResponseBytes?: number;
  timeoutMs?: number;
  redirect?: RequestInit["redirect"];
}

export async function responseJson(response: Response, maxBytes?: number): Promise<unknown> {
  if (maxBytes === undefined) return response.json();
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Upstream response too large");
  }
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("Upstream response too large");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Validate the transport envelope before projecting the endpoint's result. */
export async function contentfnRequest<T>(
  baseUrl: string, path: string, body: Record<string, unknown>,
  parseResult: (value: unknown) => T | null,
  options: ContentfnRequestOptions = {},
): Promise<CmsfnEnvelope<T>> {
  let response: Response;
  let data: unknown;
  try {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
      ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
      ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
    });
    data = await responseJson(response, options.maxResponseBytes);
  } catch {
    return err("CONTENTFN_UNAVAILABLE", "ContentFn request failed");
  }
  if (!isRecord(data)) return err("CONTENTFN_UNAVAILABLE", "Invalid ContentFn response", { upstreamStatus: response.status });
  if (data.ok === false) {
    const error = data.error;
    if (!isRecord(error) || typeof error.code !== "string" || !error.code ||
      typeof error.message !== "string" || !isRecord(error.details)) {
      return err("CONTENTFN_UNAVAILABLE", "Invalid ContentFn error response", { upstreamStatus: response.status });
    }
    const code = mappedCode(error.code);
    const details = { ...error.details, upstreamStatus: response.status,
      ...(code !== error.code ? { upstreamCode: error.code } : {}) };
    return err(code, error.message, details);
  }
  if (!response.ok || data.ok !== true) {
    return err("CONTENTFN_UNAVAILABLE", "Invalid ContentFn response", { upstreamStatus: response.status });
  }
  const result = parseResult(data.result);
  return result === null ? err("CONTENTFN_UNAVAILABLE", "Invalid ContentFn result", { upstreamStatus: response.status, failureKind: "invalid-result" }) : ok(result);
}

export function emptyResult(value: unknown): Record<string, never> | null {
  return isRecord(value) && Object.keys(value).length === 0 ? {} : null;
}
