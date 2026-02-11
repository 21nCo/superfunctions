/**
 * Trigger ContentFn dataset import. Validates target dataset; artifact shape validated by ContentFn.
 */

export interface ImportOpsConfig {
  contentfnBaseUrl: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Call ContentFn POST /contentfn/datasets/import with { dataset, artifact }.
 * ContentFn returns VALIDATION_FAILED for malformed artifact.
 * Returns envelope.
 */
export async function contentfnImport(
  config: ImportOpsConfig,
  input: { dataset: string; artifact: unknown }
): Promise<
  | { ok: true; result: Record<string, never> }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
> {
  const base = normalizeBaseUrl(config.contentfnBaseUrl);
  const res = await fetch(`${base}/contentfn/datasets/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset: input.dataset, artifact: input.artifact }),
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
  return data as { ok: true; result: Record<string, never> };
}
