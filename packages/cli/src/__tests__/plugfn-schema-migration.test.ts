import { describe, expect, it } from 'vitest';
import type { FieldSchema, TableSchema } from '@superfunctions/db';
import { createPendingMigration } from '../commands/generate.js';
import type { DatabaseColumn, DatabaseTable } from '../utils/introspection.js';
import { getSchema, PLUGFN_SCHEMA_VERSION } from '../../../../plugfn/core/src/schema.js';

// The last schema version whose plugfn_sync_jobs.claim_token was VARCHAR(64)
// on dev. next shipped the same version with VARCHAR(768).
const V7_SCHEMA_VERSION = 7;
const DEV_V7_CLAIM_TOKEN_LENGTH = 64;
const NEXT_V7_CLAIM_TOKEN_LENGTH = 768;
// information_schema.COLUMNS.CHARACTER_MAXIMUM_LENGTH for a MySQL TEXT column.
const MYSQL_TEXT_REPORTED_LENGTH = 65_535;
// Key prefix the generators use when indexing a TEXT column.
const MYSQL_TEXT_INDEX_PREFIX = 191;

/** A column as introspectMySQL reports it from information_schema. */
function mysqlColumn(tableName: string, columnName: string, field: FieldSchema): DatabaseColumn {
  const base = {
    dialect: 'mysql' as const,
    tableName,
    columnName,
    isNullable: !field.required,
    defaultValue: null,
    isPrimaryKey: columnName === 'id',
    isUnique: false,
  };
  switch (field.type) {
    case 'string':
      return field.maxLength === undefined
        ? { ...base, dataType: 'text', columnType: 'text', maxLength: MYSQL_TEXT_REPORTED_LENGTH }
        : {
            ...base,
            dataType: 'varchar',
            columnType: `varchar(${field.maxLength})`,
            maxLength: field.maxLength,
          };
    case 'number':
      return { ...base, dataType: 'int', columnType: 'int', maxLength: null };
    case 'bigint':
      return { ...base, dataType: 'bigint', columnType: 'bigint', maxLength: null };
    case 'boolean':
      return { ...base, dataType: 'tinyint', columnType: 'tinyint(1)', maxLength: null };
    case 'json':
      return { ...base, dataType: 'json', columnType: 'json', maxLength: null };
    default:
      return { ...base, dataType: 'timestamp', columnType: 'timestamp', maxLength: null };
  }
}

/**
 * A MySQL database migrated to plugfn schema v7: every table, column and index
 * of the current schema, with plugfn_sync_jobs.claim_token at the given width.
 * TEXT key parts carry the prefix length MySQL reports in STATISTICS.SUB_PART.
 */
function mysqlV7Snapshot(tables: TableSchema[], claimTokenLength: number): DatabaseTable[] {
  return tables.map((table) => {
    const columns = Object.entries(table.fields).map(([name, field]) => {
      const columnName = field.fieldName ?? name;
      const v7Field =
        table.modelName === 'plugfn_sync_jobs' && columnName === 'claim_token'
          ? { ...field, maxLength: claimTokenLength }
          : field;
      return mysqlColumn(table.modelName, columnName, v7Field);
    });
    const prefixFor = (column: string) =>
      columns.find((candidate) => candidate.columnName === column)?.dataType === 'text'
        ? MYSQL_TEXT_INDEX_PREFIX
        : null;
    const indexes = [
      { name: 'PRIMARY', columns: ['id'], isUnique: true },
      ...(table.indexes ?? []).map((index) => ({
        name: index.name,
        columns: index.fields.map((fieldName) => table.fields[fieldName]?.fieldName ?? fieldName),
        isUnique: index.unique === true,
      })),
    ].map((index) => ({
      ...index,
      tableName: table.modelName,
      indexType: 'BTREE',
      prefixLengths: index.columns.map(prefixFor),
    }));
    return { name: table.modelName, schema: 'app', columns, indexes, constraints: [] };
  });
}

/** The executable part of an up migration, without comments. */
function upStatements(adapterType: 'drizzle' | 'kysely' | 'prisma', content: string): string {
  const up = adapterType === 'kysely' ? content.slice(0, content.indexOf('export async function down')) : content;
  return up
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('plugfn schema v8 migration', () => {
  const schema = getSchema();
  const library = { libraryName: 'plugfn', namespace: 'plugfn', version: schema.version, tables: schema.schemas };
  const adapterTypes = ['drizzle', 'kysely', 'prisma'] as const;

  it('widens a dev v7 claim_token in place, keeping its unique index and unchanged TEXT columns', () => {
    expect(PLUGFN_SCHEMA_VERSION).toBeGreaterThan(V7_SCHEMA_VERSION);

    for (const adapterType of adapterTypes) {
      const pending = createPendingMigration({
        adapterType,
        dialect: 'mysql',
        library,
        currentVersion: V7_SCHEMA_VERSION,
        currentTables: mysqlV7Snapshot(schema.schemas, DEV_V7_CLAIM_TOKEN_LENGTH),
      });

      expect(pending).not.toBeNull();
      // TEXT columns reported as 65535 match their unbounded schema strings, so
      // only claim_token changes. Its unique index is not dropped: MySQL keeps a
      // full-column index through a VARCHAR widening, so uniqueness is enforced
      // for the whole upgrade.
      expect(pending!.tableDiffs).toEqual([
        {
          tableName: 'plugfn_sync_jobs',
          action: 'alter',
          missingColumns: [],
          extraColumns: [],
          columnChanges: [
            expect.objectContaining({
              column: 'claim_token',
              change: `maxLength changed from ${DEV_V7_CLAIM_TOKEN_LENGTH} to ${NEXT_V7_CLAIM_TOKEN_LENGTH}`,
            }),
          ],
          missingIndexes: [],
          changedIndexes: [],
          rebuiltIndexes: [],
        },
      ]);

      const up = upStatements(adapterType, pending!.migrationFile.content);
      expect(up, adapterType).toContain(
        `ALTER TABLE plugfn_sync_jobs MODIFY COLUMN claim_token VARCHAR(${NEXT_V7_CLAIM_TOKEN_LENGTH}) NULL`,
      );
      expect(up.match(/MODIFY COLUMN/g), adapterType).toHaveLength(1);
      expect(up, adapterType).not.toMatch(/DROP TABLE|CREATE TABLE|DROP COLUMN|ADD COLUMN|dropIndex|INDEX/i);
      expect(up.indexOf('MODIFY COLUMN')).toBeLessThan(
        up.search(new RegExp(`version\\s*[:=]\\s*${PLUGFN_SCHEMA_VERSION}\\b`)),
      );
    }
  });

  it('only records the new version on a next v7 database whose claim_token is already widened', () => {
    for (const adapterType of adapterTypes) {
      const pending = createPendingMigration({
        adapterType,
        dialect: 'mysql',
        library,
        currentVersion: V7_SCHEMA_VERSION,
        currentTables: mysqlV7Snapshot(schema.schemas, NEXT_V7_CLAIM_TOKEN_LENGTH),
      });

      expect(pending).not.toBeNull();
      expect(pending!.tableDiffs).toEqual([]);
      const up = upStatements(adapterType, pending!.migrationFile.content);
      expect(up, adapterType).not.toMatch(/ALTER TABLE|MODIFY COLUMN|INDEX|dropIndex|CREATE TABLE|DROP TABLE/i);
      expect(up, adapterType).toMatch(new RegExp(`version\\s*[:=]\\s*${PLUGFN_SCHEMA_VERSION}\\b`));
    }
  });

  it('reports a database already at the current version as up to date', () => {
    expect(
      createPendingMigration({
        adapterType: 'drizzle',
        dialect: 'mysql',
        library,
        currentVersion: PLUGFN_SCHEMA_VERSION,
        currentTables: mysqlV7Snapshot(schema.schemas, NEXT_V7_CLAIM_TOKEN_LENGTH),
      }),
    ).toBeNull();
  });
});
