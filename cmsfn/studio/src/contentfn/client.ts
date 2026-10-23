/**
 * Typed ContentFn HTTP client: query, schema, docs.
 */

import type {
  CfqlQuery,
  CfqlResultPage,
  ContentfnEnvelope,
  ContentfnErrorCode,
  ContentfnSchema,
  ContentfnDocument,
  ContentfnPatchInput,
} from "@contentfn/core";

export interface ContentfnClientConfig {
  baseUrl: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseEnvelopeError(data: unknown): { code: ContentfnErrorCode; message: string; details: Record<string, unknown> } {
  const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
  return {
    code: (err?.code ?? "INTERNAL_ERROR") as ContentfnErrorCode,
    message: (err?.message ?? "Request failed") as string,
    details: (err?.details ?? {}) as Record<string, unknown>,
  };
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<ContentfnEnvelope<T>> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    return { ok: false, error: parseEnvelopeError(data) };
  }
  return data as ContentfnEnvelope<T>;
}

/**
 * Run a CFQL query. POST to {baseUrl}/contentfn/query.
 */
export async function queryContentfn(
  config: ContentfnClientConfig,
  query: CfqlQuery
): Promise<ContentfnEnvelope<CfqlResultPage>> {
  const base = normalizeBaseUrl(config.baseUrl);
  return postJson<CfqlResultPage>(base, "/contentfn/query", query);
}

/**
 * Get schema for dataset. POST { dataset } to /contentfn/schema/get.
 */
export async function getSchema(
  config: ContentfnClientConfig,
  dataset: string
): Promise<ContentfnEnvelope<ContentfnSchema>> {
  const base = normalizeBaseUrl(config.baseUrl);
  return postJson<ContentfnSchema>(base, "/contentfn/schema/get", { dataset });
}

/**
 * Get document. POST { dataset, id, perspective? } to /contentfn/docs/get.
 */
export async function getDoc(
  config: ContentfnClientConfig,
  input: { dataset: string; id: string; perspective?: "draft" | "published" | "raw" }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  const base = normalizeBaseUrl(config.baseUrl);
  return postJson<ContentfnDocument>(base, "/contentfn/docs/get", {
    dataset: input.dataset,
    id: input.id,
    perspective: input.perspective,
  });
}

/**
 * Patch document. POST ContentfnPatchInput to /contentfn/docs/patch.
 */
export async function patchDoc(
  config: ContentfnClientConfig,
  input: ContentfnPatchInput
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  const base = normalizeBaseUrl(config.baseUrl);
  return postJson<ContentfnDocument>(base, "/contentfn/docs/patch", input);
}

export interface AssetListItem {
  assetId: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/**
 * Upload asset. POST to /contentfn/assets/upload. Body: dataset, filename, contentType, bytesBase64.
 */
export async function uploadAsset(
  config: ContentfnClientConfig,
  input: {
    dataset: string;
    filename: string;
    contentType: string;
    bytesBase64: string;
  }
): Promise<ContentfnEnvelope<{ assetId: string; url: string }>> {
  const base = normalizeBaseUrl(config.baseUrl);
  return postJson<{ assetId: string; url: string }>(base, "/contentfn/assets/upload", input);
}

/**
 * List assets. POST to /contentfn/assets/list. Deterministic order: createdAt desc, assetId asc.
 */
export async function listAssets(
  config: ContentfnClientConfig,
  input: { dataset: string; limit?: number; offset?: number }
): Promise<ContentfnEnvelope<{ assets: AssetListItem[] }>> {
  const base = normalizeBaseUrl(config.baseUrl);
  return postJson<{ assets: AssetListItem[] }>(base, "/contentfn/assets/list", input);
}
