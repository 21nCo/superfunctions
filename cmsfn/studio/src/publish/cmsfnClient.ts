/**
 * Call CmsFn server publish/unpublish (gated by role + workflow).
 */

export interface CmsfnPublishConfig {
  apiUrl: string;
}

export interface CmsfnPublishResult {
  ok: true;
  result?: unknown;
}

export interface CmsfnPublishError {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * POST /cmsfn/publish — body: { dataset, id }. Returns envelope.
 */
export async function publishDoc(
  config: CmsfnPublishConfig,
  dataset: string,
  id: string
): Promise<CmsfnPublishResult | CmsfnPublishError> {
  const base = normalizeBaseUrl(config.apiUrl);
  const res = await fetch(`${base}/cmsfn/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset, id }),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details as Record<string, unknown>) ?? {},
      },
    };
  }
  return data as CmsfnPublishResult;
}

/**
 * POST /cmsfn/unpublish — body: { dataset, id }.
 */
export async function unpublishDoc(
  config: CmsfnPublishConfig,
  dataset: string,
  id: string
): Promise<CmsfnPublishResult | CmsfnPublishError> {
  const base = normalizeBaseUrl(config.apiUrl);
  const res = await fetch(`${base}/cmsfn/unpublish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset, id }),
  });
  const data = await res.json();
  if (!res.ok) {
    return {
      ok: false,
      error: {
        code: (data?.error?.code ?? "INTERNAL_ERROR") as string,
        message: (data?.error?.message ?? "Request failed") as string,
        details: (data?.error?.details as Record<string, unknown>) ?? {},
      },
    };
  }
  return data as CmsfnPublishResult;
}
