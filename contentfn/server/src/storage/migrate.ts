/**
 * Optional migration runner: ensures all ContentFn tables exist.
 * Adapters (e.g. @superfunctions/db) implement runMigration; this module defines the steps.
 */

import type { IndexSchema } from "@superfunctions/db";
import { ALL_TABLES, type TableDef } from "./schema.js";

export interface MigrationAdapter {
  /** Create table from TableDef if it does not exist. */
  createTableIfNotExists(table: TableDef): Promise<void>;
}

/**
 * Run baseline migration: create all contentfn_* tables if not present.
 */
export async function runContentfnMigrations(adapter: MigrationAdapter): Promise<void> {
  for (const table of ALL_TABLES) {
    await adapter.createTableIfNotExists(table);
  }
}

/** Upgrade existing schema3 queue tables before any schema4 writer starts.
 * The host adapter must implement idempotent DDL using its database's schema tools.
 * Baseline create-only adapters remain supported for fresh databases.
 */
export async function upgradeWebhookAuditSchema(adapter: {
  addColumnIfNotExists(table: string, name: string, column: import("./schema.js").ColumnDef): Promise<void>;
}): Promise<void> {
  const { contentfnWebhookQueue } = await import("./schema.js");
  for (const name of ["dataset", "destinationUrl", "updatedAt", "timestampKnown", "auditMetadataVersion"]) {
    await adapter.addColumnIfNotExists(contentfnWebhookQueue.name, name, contentfnWebhookQueue.columns[name]);
  }
}


/** Directional indexes cannot yet be represented by the shared schema CLI. */
export interface HistoryIndexDefinition extends IndexSchema {
  table: string;
  directions: Array<"asc" | "desc">;
}

/** A fresh descriptor so a host cannot mutate later migration instructions. */
export function getHistoryIndexDefinition(): HistoryIndexDefinition {
  return {
    name: "contentfn_revisions_history_v1", table: "contentfn_revisions", unique: false,
    fields: ["dataset", "docId", "timestamp", "rev", "id"],
    directions: ["asc", "asc", "desc", "asc", "asc"],
  };
}

/** Add/verify the ordered index on an existing or fresh revisions table.
 * The host uses its normal schema tools, must compare an existing same-name
 * index's fields/directions/uniqueness, and must reject an incompatible index.
 * Calling this hook starts no queries or background migration at construction.
 */
export async function upgradeHistoryIndexSchema(adapter: {
  ensureOrderedIndex(index: HistoryIndexDefinition): Promise<void>;
}): Promise<void> {
  await adapter.ensureOrderedIndex(getHistoryIndexDefinition());
}
