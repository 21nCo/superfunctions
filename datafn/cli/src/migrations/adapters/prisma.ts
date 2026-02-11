import type { MigrationPlan, MigrationContext } from "../types.js";
import { renderPostgres } from "../render-postgres.js";
import { renderMySQL } from "../render-mysql.js";
import { renderSQLite } from "../render-sqlite.js";

export function generatePrismaMigration(plan: MigrationPlan, ctx: MigrationContext): string {
  // Prisma uses plain SQL files in migrations folder
  const sql = getSqlForDialect(plan, ctx);
  
  return `-- Prisma Migration
-- Provider: ${ctx.dialect}
-- Generated at: ${new Date().toISOString()}

${sql}
`;
}

function getSqlForDialect(plan: MigrationPlan, ctx: MigrationContext): string {
  switch (ctx.dialect) {
    case 'mysql': return renderMySQL(plan, ctx);
    case 'sqlite': return renderSQLite(plan, ctx);
    default: return renderPostgres(plan, ctx);
  }
}
