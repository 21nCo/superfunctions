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
