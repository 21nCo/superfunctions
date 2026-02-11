import type { MigrationPlan, MigrationContext } from "../types.js";
import { renderPostgres } from "../render-postgres.js";
import { renderMySQL } from "../render-mysql.js";
import { renderSQLite } from "../render-sqlite.js";

export function generateKyselyMigration(plan: MigrationPlan, ctx: MigrationContext): string {
  // Kysely uses up/down functions with schema builder or raw SQL
  const sql = getSqlForDialect(plan, ctx);
  
  return `// Auto-generated Kysely migration
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
${sql.split('\n').filter(line => !line.startsWith('--')).map(line => {
    if (line.trim()) {
      return `  await sql\`${line.trim()}\`.execute(db);`;
    }
    return '';
  }).filter(Boolean).join('\n')}
}

export async function down(db: Kysely<any>): Promise<void> {
  // TODO: Add rollback logic
}
`;
}

function getSqlForDialect(plan: MigrationPlan, ctx: MigrationContext): string {
  switch (ctx.dialect) {
    case 'mysql': return renderMySQL(plan, ctx);
    case 'sqlite': return renderSQLite(plan, ctx);
    default: return renderPostgres(plan, ctx);
  }
}
