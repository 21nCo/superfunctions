/**
 * Render Postgres migration script from plan.
 */

import type { MigrationContext, MigrationPlan } from "./types.js";

export function renderPostgres(plan: MigrationPlan, ctx: MigrationContext): string {
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
          const pgType = mapToPgType(field.type);
          const nullClause = field.required ? "NOT NULL" : "NULL";
          columns.push(`"${field.name}" ${pgType} ${nullClause}`);
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
        const nullClause = change.required ? "NOT NULL" : "NULL";
        const pgType = mapToPgType(change.type);
        lines.push(
          `ALTER TABLE "${change.resource}" ADD COLUMN "${change.field}" ${pgType} ${nullClause};`,
        );
        break;
      }

      case "removeField":
        lines.push(
          `ALTER TABLE "${change.resource}" DROP COLUMN "${change.field}";`,
        );
        break;

      case "alterField":
        if (change.changes.type) {
          const newType = mapToPgType(change.changes.type);
          lines.push(
            `ALTER TABLE "${change.resource}" ALTER COLUMN "${change.field}" TYPE ${newType};`,
          );
        }
        if (change.changes.required !== undefined) {
          const constraint = change.changes.required
            ? "SET NOT NULL"
            : "DROP NOT NULL";
          lines.push(
            `ALTER TABLE "${change.resource}" ALTER COLUMN "${change.field}" ${constraint};`,
          );
        }
        break;

      case "addRelation": {
        if (change.type === "many-to-many") {
          const prefix = ctx.joinTablePrefix ?? "__datafn_join_";
          const tableName = `${prefix}${change.from}_${change.relation ?? change.to}`;
          const columns: string[] = [
            `"from" TEXT NOT NULL`,
            `"to" TEXT NOT NULL`,
          ];

          if (change.metadata) {
            for (const [key, value] of Object.entries(change.metadata)) {
              const metaType =
                typeof value === "string" ? mapToPgType(value) : "TEXT";
              columns.push(`"${key}" ${metaType}`);
            }
          }

          columns.push(`PRIMARY KEY ("from", "to")`);

          lines.push(`-- Create join table for ${change.from} -> ${change.to}`);
          lines.push(
            `CREATE TABLE "${tableName}" (\n  ${columns.join(",\n  ")}\n);`,
          );
        } else if (change.type === "one-to-many") {
          lines.push(
            `-- one-to-many relation: ${change.from} -> ${change.to} (FK on ${change.to} side)`,
          );
        }
        break;
      }

      case "removeRelation": {
        const relation = ctx.fromSchema?.relations?.find(
          (r) =>
            r.from === change.from &&
            r.to === change.to &&
            r.relation === change.relation,
        );

        if (relation?.type === "many-many") {
          const prefix = ctx.joinTablePrefix ?? "__datafn_join_";
          const tableName = `${prefix}${change.from}_${change.relation ?? change.to}`;
          lines.push(`-- Drop join table for ${change.from} -> ${change.to}`);
          lines.push(`DROP TABLE IF EXISTS "${tableName}";`);
        } else {
          lines.push(
            `-- Remove relation: ${change.from} -> ${change.to} (${change.relation})`,
          );
        }
        break;
      }

      case "addIndex": {
        const fieldList = change.fields.join("_");
        const indexName = `idx_${change.resource}_${fieldList}`;
        const columnList = change.fields.map((f) => `"${f}"`).join(", ");

        switch (change.indexType) {
          case "base":
            lines.push(
              `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${change.resource}" (${columnList});`,
            );
            break;
          case "search":
            lines.push(
              `-- Full-text search index on ${change.resource}(${columnList})`,
            );
            lines.push(
              `-- Consider: CREATE INDEX "${indexName}_fts" ON "${change.resource}" USING GIN (to_tsvector('english', ${columnList}));`,
            );
            break;
          case "vector":
            lines.push(
              `-- Vector index on ${change.resource}(${columnList})`,
            );
            lines.push(
              `-- Requires pgvector extension: CREATE INDEX "${indexName}_vec" ON "${change.resource}" USING ivfflat (${columnList} vector_cosine_ops);`,
            );
            break;
        }
        break;
      }

      case "removeIndex": {
        const fieldList = change.fields.join("_");
        const indexName = `idx_${change.resource}_${fieldList}`;
        lines.push(`DROP INDEX IF EXISTS "${indexName}";`);
        break;
      }
    }
  }

  return lines.join("\n");
}

function mapToPgType(type: string): string {
  switch (type) {
    case "string":
      return "TEXT";
    case "boolean":
      return "BOOLEAN";
    case "number":
      return "NUMERIC";
    case "date":
      return "BIGINT";
    case "object":
      return "JSONB";
    case "array":
      return "JSONB";
    case "file":
      return "TEXT";
    default:
      return "TEXT";
  }
}
