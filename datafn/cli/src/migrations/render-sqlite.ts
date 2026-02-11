/**
 * Render SQLite migration script from plan.
 */

import type { MigrationPlan, MigrationContext } from "./types.js";

export function renderSQLite(plan: MigrationPlan, ctx: MigrationContext): string {
  const lines: string[] = [];

  for (const change of plan.changes) {
    switch (change.kind) {
      case "addResource": {
        const resource = ctx.toSchema.resources.find(
          (r) => r.name === change.resource,
        );
        if (!resource) {
          lines.push(`-- ERROR: Resource ${change.resource} not found in schema`);
          break;
        }

        lines.push(`-- Create table ${change.resource}`);
        const columns: string[] = [`"id" TEXT PRIMARY KEY`];

        for (const field of resource.fields) {
          const sqliteType = mapToSQLiteType(field.type);
          const nullClause = field.required ? "NOT NULL" : "";
          columns.push(`"${field.name}" ${sqliteType}${nullClause ? ` ${nullClause}` : ""}`);
        }

        lines.push(
          `CREATE TABLE "${change.resource}" (\n  ${columns.join(",\n  ")}\n);`,
        );
        break;
      }

      case "removeResource":
        lines.push(`DROP TABLE IF EXISTS "${change.resource}";`);
        break;

      case "addField": {
        const nullClause = change.required ? "NOT NULL" : "";
        const sqliteType = mapToSQLiteType(change.type);
        const parts = [
          `ALTER TABLE "${change.resource}" ADD COLUMN "${change.field}" ${sqliteType}`,
        ];
        if (nullClause) {
          parts[0] += ` ${nullClause}`;
        }
        lines.push(`${parts[0]};`);
        break;
      }

      case "removeField":
        lines.push(
          `ALTER TABLE "${change.resource}" DROP COLUMN "${change.field}";`,
        );
        break;

      case "alterField":
        if (change.changes.type) {
          lines.push(
            `-- SQLite does not support ALTER COLUMN TYPE. Table recreation required.`,
          );
          lines.push(
            `-- To change "${change.field}" to ${mapToSQLiteType(change.changes.type)}, manually recreate the table.`,
          );
        }
        if (change.changes.required !== undefined) {
          lines.push(
            `-- SQLite does not support ALTER COLUMN for NOT NULL changes. Table recreation required.`,
          );
          const constraint = change.changes.required ? "NOT NULL" : "NULL";
          lines.push(
            `-- To set "${change.field}" to ${constraint}, manually recreate the table.`,
          );
        }
        break;

      case "addRelation": {
        const joinTablePrefix = ctx.joinTablePrefix ?? "__datafn_join_";
        if (change.type === "many-to-many") {
          const joinTable = `${joinTablePrefix}${change.from}_${change.to}`;
          lines.push(`-- Create join table for many-to-many relation`);
          lines.push(`CREATE TABLE IF NOT EXISTS "${joinTable}" (`);
          lines.push(`  "${change.from}_id" TEXT NOT NULL,`);
          lines.push(`  "${change.to}_id" TEXT NOT NULL,`);
          lines.push(`  PRIMARY KEY ("${change.from}_id", "${change.to}_id"),`);
          lines.push(`  FOREIGN KEY ("${change.from}_id") REFERENCES "${change.from}"(id),`);
          lines.push(`  FOREIGN KEY ("${change.to}_id") REFERENCES "${change.to}"(id)`);
          lines.push(`);`);
        } else if (change.type === "one-to-many" || change.type === "one-to-one") {
          lines.push(
            `ALTER TABLE "${change.from}" ADD COLUMN "${change.to}_id" TEXT REFERENCES "${change.to}"(id);`,
          );
        }
        break;
      }

      case "removeRelation": {
        const joinTablePrefix = ctx.joinTablePrefix ?? "__datafn_join_";
        const joinTable = `${joinTablePrefix}${change.from}_${change.to}`;
        lines.push(`-- Remove relation (drop join table if exists, or drop FK column)`);
        lines.push(`DROP TABLE IF EXISTS "${joinTable}";`);
        break;
      }

      case "addIndex": {
        const indexName = `idx_${change.resource}_${change.fields.join("_")}`;
        const columns = change.fields.map((f) => `"${f}"`).join(", ");
        if (change.indexType === "search") {
          lines.push(
            `-- Full-text search index requires FTS extension (FTS5 recommended)`,
          );
          lines.push(
            `-- CREATE VIRTUAL TABLE "${change.resource}_fts" USING fts5(${columns}, content="${change.resource}");`,
          );
        } else if (change.indexType === "vector") {
          lines.push(
            `-- Vector index not natively supported in SQLite. Consider sqlite-vss extension.`,
          );
        } else {
          lines.push(
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${change.resource}" (${columns});`,
          );
        }
        break;
      }

      case "removeIndex": {
        const indexName = `idx_${change.resource}_${change.fields.join("_")}`;
        lines.push(`DROP INDEX IF EXISTS "${indexName}";`);
        break;
      }
    }
  }

  return lines.join("\n");
}

function mapToSQLiteType(type: string): string {
  switch (type) {
    case "string":
      return "TEXT";
    case "boolean":
      return "INTEGER"; // SQLite uses 0/1 for booleans
    case "number":
      return "INTEGER"; // or REAL for floats
    case "date":
      return "INTEGER"; // Store as timestamp
    case "object":
      return "TEXT"; // JSON as text
    case "array":
      return "TEXT"; // JSON as text
    case "file":
      return "TEXT";
    default:
      return "TEXT";
  }
}
