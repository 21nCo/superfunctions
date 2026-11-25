import { describe, expect, it } from 'vitest';
import type { FieldSchema, TableSchema } from '@superfunctions/db';
import { createPendingMigration } from '../commands/generate.js';
import type { DatabaseColumn, DatabaseTable } from '../utils/introspection.js';
import { getSchema, PLUGFN_SCHEMA_VERSION } from '../../../../plugfn/core/src/schema.js';

// The last schema version whose plugfn_sync_jobs.claim_token was VARCHAR(64).
const V7_SCHEMA_VERSION = 7;
const V7_CLAIM_TOKEN_LENGTH = 64;

// Unbounded strings are modelled as TEXT with no reported length so the snapshot
// matches the schema everywhere except claim_token. Introspected MySQL TEXT
// reports 65535, which the diff flags on plugfn's unbounded TEXT keys for any
// plugfn version step; that pre-existing gap is not part of this change.
function mysqlColumn(tableName: string, columnName: string, field: FieldSchema): DatabaseColumn {
  const base = {
    dialect: 'mysql' as const,
    tableName,
    columnName,
    isNullable: !field.required,
    defaultValue: null,
    isPrimaryKey: columnName === 'id',
    isUnique: columnName === 'id',
  };
  switch (field.type) {
    case 'string':
      return field.maxLength === undefined
        ? { ...base, dataType: 'text', columnType: 'text', maxLength: null }
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
      return { ...base, dataType: 'boolean', columnType: 'boolean', maxLength: null };
    case 'json':
      return { ...base, dataType: 'json', columnType: 'json', maxLength: null };
    default:
      return { ...base, dataType: 'timestamp', columnType: 'timestamp', maxLength: null };
  }
}

/**
 * A MySQL database migrated to plugfn schema v7: every table, column and index
 * of the current schema, except that claim_token still has its v7 width.
 */
function mysqlV7Snapshot(tables: TableSchema[]): DatabaseTable[] {
  return tables.map((table) => {
    const columns = Object.entries(table.fields).map(([name, field]) => {
      const columnName = field.fieldName ?? name;
      const v7Field =
        table.modelName === 'plugfn_sync_jobs' && columnName === 'claim_token'
          ? { ...field, maxLength: V7_CLAIM_TOKEN_LENGTH }
          : field;
      return mysqlColumn(table.modelName, columnName, v7Field);
    });
    const indexes = (table.indexes ?? []).map((index) => ({
      name: index.name,
      tableName: table.modelName,
      columns: index.fields.map((fieldName) => table.fields[fieldName]?.fieldName ?? fieldName),
      isUnique: index.unique === true,
    }));
    return {
      name: table.modelName,
      columns,
      indexes: [
        { name: 'PRIMARY', tableName: table.modelName, columns: ['id'], isUnique: true },
        ...indexes,
      ],
      constraints: [
        { name: 'PRIMARY', type: 'PRIMARY KEY' as const, tableName: table.modelName, columns: ['id'] },
      ],
    };
  });
}

describe('plugfn schema v8 migration', () => {
  const schema = getSchema();
  const library = { libraryName: 'plugfn', namespace: 'plugfn', version: schema.version, tables: schema.schemas };

  it('widens claim_token on an installed v7 MySQL database instead of reporting it up to date', () => {
    expect(PLUGFN_SCHEMA_VERSION).toBeGreaterThan(V7_SCHEMA_VERSION);

    for (const adapterType of ['drizzle', 'kysely'] as const) {
      const pending = createPendingMigration({
        adapterType,
        dialect: 'mysql',
        library,
        currentVersion: V7_SCHEMA_VERSION,
        currentTables: mysqlV7Snapshot(schema.schemas),
      });

      expect(pending).not.toBeNull();
      // Only claim_token changes: no table is created or dropped, no column is
      // added or removed, and the unique claim-token index is rebuilt with the
      // same columns around the widening, so existing rows are kept.
      expect(pending!.tableDiffs).toEqual([
        {
          tableName: 'plugfn_sync_jobs',
          action: 'alter',
          missingColumns: [],
          extraColumns: [],
          columnChanges: [
            expect.objectContaining({
              column: 'claim_token',
              change: 'maxLength changed from 64 to 768',
            }),
          ],
          missingIndexes: [],
          changedIndexes: [],
          rebuiltIndexes: [
            expect.objectContaining({
              name: 'idx_plugfn_sync_jobs_claim_token',
              current: expect.objectContaining({ columns: ['claim_token'], unique: true }),
              required: { columns: ['claim_token'], unique: true },
            }),
          ],
        },
      ]);

      // The up migration drops the claim-token index, widens the column,
      // recreates the same unique index and only then records the new version.
      const content = pending!.migrationFile.content;
      const upMigration = adapterType === 'kysely'
        ? content.slice(0, content.indexOf('export async function down'))
        : content;
      const statements = adapterType === 'kysely'
        ? [
            "dropIndex('idx_plugfn_sync_jobs_claim_token').on('plugfn_sync_jobs')",
            'ALTER TABLE plugfn_sync_jobs MODIFY COLUMN claim_token VARCHAR(768) NULL',
            'CREATE UNIQUE INDEX idx_plugfn_sync_jobs_claim_token ON plugfn_sync_jobs (claim_token)',
            `version: ${PLUGFN_SCHEMA_VERSION},`,
          ]
        : [
            'DROP INDEX idx_plugfn_sync_jobs_claim_token ON plugfn_sync_jobs',
            'ALTER TABLE plugfn_sync_jobs MODIFY COLUMN claim_token VARCHAR(768) NULL',
            'CREATE UNIQUE INDEX idx_plugfn_sync_jobs_claim_token ON plugfn_sync_jobs (claim_token)',
            `UPDATE _superfunctions_schema_versions SET version = ${PLUGFN_SCHEMA_VERSION}`,
          ];
      const positions = statements.map((statement) => upMigration.indexOf(statement));
      expect(positions.every((position) => position >= 0), content).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(content).not.toMatch(/DROP TABLE|CREATE TABLE|DROP COLUMN/i);
    }
  });

  it('reports a database already at the current version as up to date', () => {
    expect(
      createPendingMigration({
        adapterType: 'drizzle',
        dialect: 'mysql',
        library,
        currentVersion: PLUGFN_SCHEMA_VERSION,
        currentTables: mysqlV7Snapshot(schema.schemas),
      }),
    ).toBeNull();
  });
});
