export { generateTypes } from "./codegen.js";

// Migration exports
export { diffSchemas } from "./migrations/diff.js";
export { renderPostgres } from "./migrations/render-postgres.js";
export { renderMySQL } from "./migrations/render-mysql.js";
export { renderSQLite } from "./migrations/render-sqlite.js";
export {
  generateDrizzleMigration,
  generatePrismaMigration,
  generateKyselyMigration,
} from "./migrations/adapters/index.js";
export type {
  MigrationPlan,
  MigrationChange,
  MigrationContext,
  RelationType,
  IndexType,
} from "./migrations/types.js";
