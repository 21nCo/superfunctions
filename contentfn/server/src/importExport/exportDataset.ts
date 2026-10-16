import type { ContentfnDatabase as Adapter } from "../storage/database.js";
import type { ContentfnEnvelope, ContentfnDocument } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";
import { datasetExists } from "../storage/datasets.js";
import { schemaHash } from "../hash/schemaHash.js";
import {
  ARTIFACT_FORMAT_VERSION,
  type ContentfnExportArtifact,
  type AssetMetadataRecord,
  type RevisionRecord,
} from "./format.js";

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export interface ExportConfig {
  db: Adapter;
}

export async function exportDataset(
  config: ExportConfig,
  input: { dataset: string }
): Promise<ContentfnEnvelope<{ dataset: string; exportedAt: string; artifact: ContentfnExportArtifact }>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const schemaRow = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.schema,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });

  let schemaRecord: ContentfnExportArtifact["schema"] = null;
  if (schemaRow) {
    const s = schemaRow as { version: number; schemaJson: unknown; schemaHash: string };
    schemaRecord = {
      version: s.version,
      schemaHash: s.schemaHash,
      schemaJson: s.schemaJson as ContentfnExportArtifact["schema"] extends null ? never : NonNullable<ContentfnExportArtifact["schema"]>["schemaJson"],
    };
  }

  const publishedRows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });
  const publishedDocs = (publishedRows as Array<{ docJson: ContentfnDocument; id: string }>)
    .map((r) => r.docJson)
    .sort((a, b) => compareText(a._id, b._id));

  const draftRows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.docsDrafts,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });
  const draftDocs = (draftRows as Array<{ docJson: ContentfnDocument; id: string }>)
    .map((r) => r.docJson)
    .sort((a, b) => compareText(a._id, b._id));

  const assetRows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.assets,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });
  const assets: AssetMetadataRecord[] = (assetRows as Array<{
    assetId: string;
    contentType: string;
    filename: string;
    size: number;
    width: number | null;
    height: number | null;
    url: string;
    createdAt: string;
  }>)
    .map((r) => ({
      assetId: r.assetId,
      contentType: r.contentType,
      filename: r.filename,
      size: r.size,
      width: r.width,
      height: r.height,
      url: r.url,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => compareText(a.assetId, b.assetId));

  const revisionRows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.revisions,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });
  const revisions: RevisionRecord[] = (revisionRows as Array<{
    docId: string;
    perspective: string;
    rev: string;
    timestamp: string;
    docJson: ContentfnDocument;
  }>)
    .map((r) => ({
      docId: r.docId,
      perspective: r.perspective,
      rev: r.rev,
      timestamp: r.timestamp,
      docJson: r.docJson,
    }))
    .sort((a, b) => {
      const docCmp = compareText(a.docId, b.docId);
      if (docCmp !== 0) return docCmp;
      return compareText(a.timestamp, b.timestamp) || compareText(a.perspective, b.perspective) || compareText(a.rev, b.rev);
    });

  const artifact: ContentfnExportArtifact = {
    formatVersion: ARTIFACT_FORMAT_VERSION,
    dataset: input.dataset,
    exportedAt: nowISO(),
    schema: schemaRecord,
    publishedDocs,
    draftDocs,
    assets,
    revisions,
  };

  return ok({ dataset: input.dataset, exportedAt: artifact.exportedAt, artifact });
}
