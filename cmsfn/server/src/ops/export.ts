import { contentfnRequest, isRecord } from "../contentfn/response.js";
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

/** Structural transport check; ContentFn remains authoritative for schema/document validation. */
export function isExportArtifact(value: unknown): value is ContentfnExportArtifact {
  return isRecord(value) && value.formatVersion === 1 && typeof value.dataset === 'string' && value.dataset.length > 0
    && typeof value.exportedAt === 'string' && Number.isFinite(Date.parse(value.exportedAt))
    && (value.schema === null || isRecord(value.schema)) && Array.isArray(value.publishedDocs)
    && Array.isArray(value.draftDocs) && Array.isArray(value.assets) && Array.isArray(value.revisions);
}
export interface ExportOpsConfig { contentfnBaseUrl: string; headers?: NonNullable<RequestInit['headers']> }
export function contentfnExport(config: ExportOpsConfig, dataset: string) {
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/datasets/export", { dataset }, value => {
    if (!isRecord(value) || !isRecord(value.artifact)) return null;
    const a = value.artifact;
    if (!isExportArtifact(a) || a.dataset !== dataset) return null;
    const artifact: ContentfnExportArtifact = { formatVersion: a.formatVersion, dataset, exportedAt: a.exportedAt,
      schema: a.schema, publishedDocs: a.publishedDocs, draftDocs: a.draftDocs, assets: a.assets, revisions: a.revisions };
    return { artifact };
  }, { headers: config.headers, maxResponseBytes: 25 * 1024 * 1024, timeoutMs: 30_000, redirect: 'error' });
}
