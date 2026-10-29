/**
 * The published SQLite artifacts the conformance suite runs against.
 *
 * - `generated/authfn-schema.ts` is verbatim `@superfunctions/cli generate-schema
 *   --adapter drizzle --dialect sqlite` output for authfn with the password and
 *   api-keys plugins.
 * - `migrations/0000_authfn_sqlite.sql` is verbatim `drizzle-kit generate
 *   --name authfn_sqlite` output (Drizzle Kit 0.31.10) for that schema: the file
 *   Wrangler applies to D1. Drizzle Kit 0.31 needs a newer drizzle-orm than the
 *   0.35 this repository pins, so regenerate it in a scratch project.
 *
 * fixture.test.ts fails when the schema drifts from the CLI output or the
 * migration drifts from the schema.
 */

import migrationSql from './migrations/0000_authfn_sqlite.sql?raw';
import * as authFnSqliteSchema from './generated/authfn-schema.js';

export { authFnSqliteSchema };

/** Drizzle Kit separates statements with this marker; drizzle-kit migrate splits on it. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export const migrationStatements: string[] = splitMigration(migrationSql);

export function splitMigration(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
