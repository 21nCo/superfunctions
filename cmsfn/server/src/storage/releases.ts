/**
 * CmsFn release storage via @superfunctions/db adapter.
 * Table: cmsfn_releases (releaseId, dataset, name, publishAt, docIds, createdAt, updatedAt).
 * List order: createdAt desc, releaseId asc.
 */

import type { Adapter } from "@superfunctions/db";
import { cmsfnStorageAdapter } from "./schema.js";
import type { CmsfnEnvelope, CmsfnRelease } from "cmsfn";
import { ok, err } from "cmsfn";
import { randomUUID } from "node:crypto";
import { MAX_DOCS_PER_RELEASE } from "../limits/limits.js";

export const CMSFN_RELEASES_TABLE = "cmsfn_releases";

export interface ReleasesStorageConfig {
  db: Adapter;
}

interface ReleaseRow {
  releaseId: string;
  dataset: string;
  name: string;
  publishAt: string | null;
  docIds: string[];
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Create a release. Returns releaseId.
 */
export async function createRelease(
  config: ReleasesStorageConfig,
  input: { dataset: string; name: string; publishAt?: string | null }
): Promise<CmsfnEnvelope<{ releaseId: string }>> {
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!dataset) return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  if (!name) return err("VALIDATION_FAILED", "name is required", { path: "name" });
  const publishAt =
    input.publishAt === undefined || input.publishAt === null
      ? null
      : typeof input.publishAt === "string"
        ? input.publishAt.trim() || null
        : null;

  const releaseId = randomUUID();
  const now = nowIso();
  const row: ReleaseRow = {
    releaseId,
    dataset,
    name,
    publishAt,
    docIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await cmsfnStorageAdapter(config.db).create({
    model: CMSFN_RELEASES_TABLE,
    data: row,
  });
  return ok({ releaseId });
}

/**
 * List releases for dataset. Order: createdAt desc, releaseId asc.
 */
export async function listReleases(
  config: ReleasesStorageConfig,
  input: { dataset: string }
): Promise<CmsfnEnvelope<{ releases: CmsfnRelease[] }>> {
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  if (!dataset) return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });

  const rows = await cmsfnStorageAdapter(config.db).findMany({
    model: CMSFN_RELEASES_TABLE,
    where: [{ field: "dataset", operator: "eq", value: dataset }],
    orderBy: [
      { field: "createdAt", direction: "desc" },
      { field: "releaseId", direction: "asc" },
    ],
  });
  const releases: CmsfnRelease[] = (rows as ReleaseRow[]).map((r) => ({
    releaseId: r.releaseId,
    dataset: r.dataset,
    name: r.name,
    publishAt: r.publishAt,
    docIds: Array.isArray(r.docIds) ? r.docIds : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return ok({ releases });
}

/**
 * Get one release by dataset and releaseId.
 */
export async function getRelease(
  config: ReleasesStorageConfig,
  input: { dataset: string; releaseId: string }
): Promise<CmsfnRelease | null> {
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  const releaseId = typeof input.releaseId === "string" ? input.releaseId.trim() : "";
  if (!dataset || !releaseId) return null;

  const row = await cmsfnStorageAdapter(config.db).findOne({
    model: CMSFN_RELEASES_TABLE,
    where: [
      { field: "dataset", operator: "eq", value: dataset },
      { field: "releaseId", operator: "eq", value: releaseId },
    ],
  });
  if (!row || typeof row !== "object") return null;
  const r = row as ReleaseRow;
  return {
    releaseId: r.releaseId,
    dataset: r.dataset,
    name: r.name,
    publishAt: r.publishAt,
    docIds: Array.isArray(r.docIds) ? r.docIds : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Add a doc to a release. Rejects if release not found or docIds would exceed max.
 */
export async function addDocToRelease(
  config: ReleasesStorageConfig,
  input: { dataset: string; releaseId: string; docId: string }
): Promise<CmsfnEnvelope<Record<string, never>>> {
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  const releaseId = typeof input.releaseId === "string" ? input.releaseId.trim() : "";
  const docId = typeof input.docId === "string" ? input.docId.trim() : "";
  if (!dataset) return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  if (!releaseId) return err("VALIDATION_FAILED", "releaseId is required", { path: "releaseId" });
  if (!docId) return err("VALIDATION_FAILED", "docId is required", { path: "docId" });

  // updatedAt is the shared mutation token. A strict monotonic value avoids
  // two changes in one millisecond accepting the same observed version.
  for (let attempt = 0; attempt < 8; attempt++) {
    const release = await getRelease(config, { dataset, releaseId });
    if (!release) return err("NOT_FOUND", "Release not found", { releaseId });
    const observed = Date.parse(release.updatedAt);
    if (!Number.isFinite(observed) || new Date(observed).toISOString() !== release.updatedAt || observed >= 8_640_000_000_000_000) {
      return err("CONFLICT", "Release version timestamp is invalid");
    }
    const docIds = [...release.docIds];
    if (docIds.includes(docId)) return ok({});
    if (docIds.length >= MAX_DOCS_PER_RELEASE) return err("VALIDATION_FAILED", "Release has reached max document count", { path: "docId", limit: MAX_DOCS_PER_RELEASE });
    docIds.push(docId);
    docIds.sort();
    const updatedAt = new Date(Math.max(Date.now(), observed + 1)).toISOString();
    const changed = await cmsfnStorageAdapter(config.db).updateMany({
      model: CMSFN_RELEASES_TABLE,
      where: [
        { field: "dataset", operator: "eq", value: dataset },
        { field: "releaseId", operator: "eq", value: releaseId },
        { field: "updatedAt", operator: "eq", value: release.updatedAt },
      ],
      data: { docIds, updatedAt },
    });
    if (changed === 1) return ok({});
    if (changed !== 0) return err("CONFLICT", "Release update was not uniquely identified");
  }
  return err("CONFLICT", "Release changed concurrently; refresh and retry");
}
