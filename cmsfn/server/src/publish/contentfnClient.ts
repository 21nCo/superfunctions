/**
 * Server-side ContentFn client for publish flow: get draft, publish, unpublish.
 * Uses fetch to config.contentfn.baseUrl.
 */

import type { ContentfnDocument, ContentfnEnvelope } from "@contentfn/core";

export interface ContentfnClientConfig {
  baseUrl: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Get draft document to read _cms.state. Id can be base or drafts.*.
 */
export async function getDraftDoc(
  config: ContentfnClientConfig,
  dataset: string,
  id: string
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  const base = normalizeBaseUrl(config.baseUrl);
  const draftId = id.startsWith("drafts.") ? id : `drafts.${id}`;
  const res = await fetch(`${base}/contentfn/docs/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset, id: draftId, perspective: "draft" }),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details ?? {}) as Record<string, unknown>,
      },
    };
  }
  return data as ContentfnEnvelope<ContentfnDocument>;
}

/**
 * Call ContentFn docs/publish. Id can be base or drafts.*.
 */
export async function contentfnPublish(
  config: ContentfnClientConfig,
  dataset: string,
  id: string,
  ifRev?: string
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  const base = normalizeBaseUrl(config.baseUrl);
  const body: Record<string, unknown> = { dataset, id };
  if (ifRev) body.ifRev = ifRev;
  const res = await fetch(`${base}/contentfn/docs/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details ?? {}) as Record<string, unknown>,
      },
    };
  }
  return data as ContentfnEnvelope<ContentfnDocument>;
}

/**
 * Call ContentFn docs/unpublish.
 */
export async function contentfnUnpublish(
  config: ContentfnClientConfig,
  dataset: string,
  id: string
): Promise<ContentfnEnvelope<Record<string, never>>> {
  const base = normalizeBaseUrl(config.baseUrl);
  const publishedId = id.startsWith("drafts.") ? id.substring(7) : id;
  const res = await fetch(`${base}/contentfn/docs/unpublish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset, id: publishedId }),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details ?? {}) as Record<string, unknown>,
      },
    };
  }
  return data as ContentfnEnvelope<Record<string, never>>;
}
