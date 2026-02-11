/**
 * Render MySQL migration script from plan.
 */

import type { MigrationPlan, MigrationContext } from "./types.js";

export function renderMySQL(plan: MigrationPlan, ctx: MigrationContext): string {
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
        const columns: string[] = [`\`id\` TEXT PRIMARY KEY`];

        for (const field of resource.fields) {
          const mysqlType = mapToMySQLType(field.type);
          const nullClause = field.required ? "NOT NULL" : "NULL";
          columns.push(`\`${field.name}\` ${mysqlType} ${nullClause}`);
        }

        lines.push(
          `CREATE TABLE \`${change.resource}\` (\n  ${columns.join(",\n  ")}\n);`,
        );
        break;
      }

      case "removeResource":
        lines.push(`DROP TABLE IF EXISTS \`${change.resource}\`;`);
        break;

      case "addField": {
        const nullClause = change.required ? "NOT NULL" : "NULL";
        const mysqlType = mapToMySQLType(change.type);
        lines.push(
          `ALTER TABLE \`${change.resource}\` ADD COLUMN \`${change.field}\` ${mysqlType} ${nullClause};`,
        );
        break;
      }

      case "removeField":
        lines.push(
          `ALTER TABLE \`${change.resource}\` DROP COLUMN \`${change.field}\`;`,
        );
        break;

      case "alterField":
        if (change.changes.type) {
          const newType = mapToMySQLType(change.changes.type);
          lines.push(
            `ALTER TABLE \`${change.resource}\` MODIFY COLUMN \`${change.field}\` ${newType};`,
          );
        }
        if (change.changes.required !== undefined) {
          const constraint = change.changes.required ? "NOT NULL" : "NULL";
          lines.push(
            `ALTER TABLE \`${change.resource}\` MODIFY COLUMN \`${change.field}\` ${constraint};`,
          );
        }
        break;

      case "addRelation": {
        const joinTablePrefix = ctx.joinTablePrefix ?? "__datafn_join_";
        if (change.type === "many-to-many") {
          const joinTable = `${joinTablePrefix}${change.from}_${change.to}`;
          lines.push(`-- Create join table for ${change.from} <-> ${change.to}`);
          lines.push(
            `CREATE TABLE IF NOT EXISTS \`${joinTable}\` (` +
              `\`${change.from}_id\` TEXT NOT NULL, ` +
              `\`${change.to}_id\` TEXT NOT NULL, ` +
              `PRIMARY KEY (\`${change.from}_id\`, \`${change.to}_id\`)` +
              `);`,
          );
        } else {
          const fkField = `${change.to}_id`;
          lines.push(
            `ALTER TABLE \`${change.from}\` ADD COLUMN \`${fkField}\` TEXT;`,
          );
        }
        break;
      }

      case "removeRelation": {
        const joinTablePrefix = ctx.joinTablePrefix ?? "__datafn_join_";
        const joinTable = `${joinTablePrefix}${change.from}_${change.to}`;
        lines.push(`DROP TABLE IF EXISTS \`${joinTable}\`;`);
        break;
      }

      case "addIndex": {
        const indexName = `idx_${change.resource}_${change.fields.join("_")}`;
        const columns = change.fields.map((f) => `\`${f}\``).join(", ");
        if (change.indexType === "search") {
          lines.push(
            `CREATE FULLTEXT INDEX \`${indexName}\` ON \`${change.resource}\` (${columns});`,
          );
        } else if (change.indexType === "vector") {
          lines.push(`-- Vector index not natively supported in MySQL`);
          lines.push(
            `CREATE INDEX \`${indexName}\` ON \`${change.resource}\` (${columns});`,
          );
        } else {
          lines.push(
            `CREATE INDEX \`${indexName}\` ON \`${change.resource}\` (${columns});`,
          );
        }
        break;
      }

      case "removeIndex": {
        const indexName = `idx_${change.resource}_${change.fields.join("_")}`;
        lines.push(`DROP INDEX \`${indexName}\` ON \`${change.resource}\`;`);
        break;
      }
    }
  }

  return lines.join("\n");
}

function mapToMySQLType(type: string): string {
  switch (type) {
    case "string":
      return "TEXT";
    case "boolean":
      return "BOOLEAN";
    case "number":
      return "INT";
    case "date":
      return "BIGINT";
    case "object":
      return "JSON";
    case "array":
      return "JSON";
    case "file":
      return "TEXT";
    default:
      return "TEXT";
  }
}
