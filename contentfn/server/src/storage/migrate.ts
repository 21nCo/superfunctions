/**
 * Optional migration runner: ensures all ContentFn tables exist.
 * Adapters (e.g. @superfunctions/db) implement runMigration; this module defines the steps.
 */

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
