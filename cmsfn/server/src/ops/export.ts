/**
 * Trigger ContentFn dataset export. Returns artifact in envelope.
 */

export interface ContentfnExportArtifact {
  formatVersion: number;
  dataset: string;
  exportedAt: string;
  schema: unknown;
  publishedDocs: unknown[];
  draftDocs: unknown[];
  assets: unknown[];
  revisions: unknown[];
}

export interface ExportOpsConfig {
  contentfnBaseUrl: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Call ContentFn POST /contentfn/datasets/export with { dataset }.
 * Returns envelope with artifact or ContentFn error.
 */
export async function contentfnExport(
  config: ExportOpsConfig,
  dataset: string
): Promise<
  | { ok: true; result: { artifact: ContentfnExportArtifact } }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
> {
  const base = normalizeBaseUrl(config.contentfnBaseUrl);
  const res = await fetch(`${base}/contentfn/datasets/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset }),
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
  return data as { ok: true; result: { artifact: ContentfnExportArtifact } };
}
