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

export interface ExportOpsConfig { contentfnBaseUrl: string }
export function contentfnExport(config: ExportOpsConfig, dataset: string) {
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/datasets/export", { dataset }, value => {
    if (!isRecord(value) || !isRecord(value.artifact)) return null;
    const a = value.artifact;
    if (a.formatVersion !== 1 || a.dataset !== dataset || typeof a.exportedAt !== "string" ||
      !("schema" in a) || !Array.isArray(a.publishedDocs) || !Array.isArray(a.draftDocs) ||
      !Array.isArray(a.assets) || !Array.isArray(a.revisions)) return null;
    const artifact: ContentfnExportArtifact = { formatVersion: a.formatVersion, dataset, exportedAt: a.exportedAt,
      schema: a.schema, publishedDocs: a.publishedDocs, draftDocs: a.draftDocs, assets: a.assets, revisions: a.revisions };
    return { artifact };
  });
}
