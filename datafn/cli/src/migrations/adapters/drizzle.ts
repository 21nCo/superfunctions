import type { MigrationPlan, MigrationContext } from "../types.js";
import { renderPostgres } from "../render-postgres.js";
import { renderMySQL } from "../render-mysql.js";
import { renderSQLite } from "../render-sqlite.js";

export function generateDrizzleMigration(plan: MigrationPlan, ctx: MigrationContext): string {
  // Drizzle uses up/down functions with raw SQL execute
  // Generate TypeScript migration file
  const sql = getSqlForDialect(plan, ctx);
  
  return `// Auto-generated Drizzle migration
import { sql } from 'drizzle-orm';

export async function up(db) {
  await db.execute(sql\`
${sql.split('\n').map(line => '    ' + line).join('\n')}
  \`);
}

export async function down(db) {
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
