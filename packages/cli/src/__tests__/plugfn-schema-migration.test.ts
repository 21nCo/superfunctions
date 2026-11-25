import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldSchema, TableSchema } from '@superfunctions/db';
import { createPendingMigration, introspectCurrentTables } from '../commands/generate.js';
import type { SuperfunctionsConfig } from '../index.js';
import { createAdapterFromConfig, type AdapterConnection } from '../utils/adapter-helper.js';
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
function mysqlV7Snapshot(
  tables: TableSchema[],
  claimTokenLength: number,
  rowFormat = 'Dynamic',
): DatabaseTable[] {
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
    return { name: table.modelName, schema: 'app', rowFormat, columns, indexes, constraints: [] };
  });
}

/**
 * The information_schema rows a MySQL server returns for a snapshot, keyed by
 * the aliases introspectMySQL selects. `int` converts integer metadata the way
 * the client library does (mysql2 returns numbers; Prisma can return bigint).
 */
function informationSchemaRows(snapshot: DatabaseTable[], int: (value: number) => number | bigint) {
  return (sql: string, params: unknown[]): Record<string, unknown>[] => {
    if (sql.includes('SELECT DATABASE()')) return [{ database_name: 'app' }];
    // Only the connection's own database holds the plugfn tables.
    if (params[0] !== 'app') return [];
    if (sql.includes('information_schema.TABLES')) {
      return snapshot.map((table) => ({ table_name: table.name, row_format: table.rowFormat }));
    }
    const table = snapshot.find((candidate) => candidate.name === params[1]);
    if (!table) throw new Error(`unexpected introspection query: ${sql}`);
    if (sql.includes('information_schema.COLUMNS')) {
      return table.columns.map((column) => ({
        column_name: column.columnName,
        data_type: column.dataType,
        column_type: column.columnType,
        character_maximum_length: column.maxLength == null ? null : int(column.maxLength),
        extra: '',
        generation_expression: '',
        character_set_name: null,
        collation_name: null,
        column_comment: '',
        is_nullable: column.isNullable ? 'YES' : 'NO',
        column_default: null,
        column_key: column.isPrimaryKey ? 'PRI' : '',
      }));
    }
    if (sql.includes('information_schema.STATISTICS')) {
      return table.indexes.flatMap((index) =>
        index.columns.map((column, position) => ({
          name: index.name,
          table_name: table.name,
          non_unique: int(index.isUnique ? 0 : 1),
          column_name: column,
          sub_part: index.prefixLengths?.[position] == null ? null : int(index.prefixLengths[position]!),
          index_type: index.indexType,
        })),
      );
    }
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [];
    throw new Error(`unexpected introspection query: ${sql}`);
  };
}

/** The raw connection each adapter's CLI helper hands to introspection. */
function mysqlConnection(adapterType: 'drizzle' | 'kysely' | 'prisma', snapshot: DatabaseTable[]) {
  switch (adapterType) {
    case 'drizzle': {
      // mysql2/promise pool: query() resolves to [rows, fields].
      const rows = informationSchemaRows(snapshot, (value) => value);
      return { query: async (sql: string, params: unknown[]) => [rows(sql, params), []] };
    }
    case 'kysely': {
      // Callback mysql2 pool: query() reports through a callback and returns a
      // Query object, not a promise; promise() returns the promise pool.
      const rows = informationSchemaRows(snapshot, (value) => value);
      return {
        query: () => ({ on: () => undefined }),
        promise: () => ({ query: async (sql: string, params: unknown[]) => [rows(sql, params), []] }),
      };
    }
    case 'prisma': {
      // PrismaClient: no query(); raw SQL takes `?` parameters as arguments and
      // resolves to the rows, with integer metadata as bigint.
      const rows = informationSchemaRows(snapshot, (value) => BigInt(value));
      return { $queryRawUnsafe: async (sql: string, ...params: unknown[]) => rows(sql, params) };
    }
  }
}

/** The executable part of an up migration, without comments. */
function upStatements(adapterType: 'drizzle' | 'kysely' | 'prisma', content: string): string {
  const up = adapterType === 'kysely' ? content.slice(0, content.indexOf('export async function down')) : content;
  return up
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

type PendingMigration = ReturnType<typeof createPendingMigration>;

/** The v7 to v8 upgrade of a dev database whose claim_token is VARCHAR(64). */
function expectDevV7Widening(adapterType: 'drizzle' | 'kysely' | 'prisma', pending: PendingMigration): void {
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

      expectDevV7Widening(adapterType, pending);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The connection and config generate-migration works from. Drizzle and
   * Kysely name the database in their connection string; the PrismaClient
   * goes through createAdapterFromConfig, and its own datasource (database
   * "app") differs from DATABASE_URL.
   */
  async function commandConnection(
    adapterType: (typeof adapterTypes)[number],
    snapshot: DatabaseTable[],
  ): Promise<{ connection: AdapterConnection; config: SuperfunctionsConfig }> {
    const rawConnection = mysqlConnection(adapterType, snapshot);
    if (adapterType === 'prisma') {
      const prisma = { ...rawConnection, _activeProvider: 'mysql', $disconnect: async () => undefined };
      const config = { adapter: { type: 'prisma', prisma: { prisma } } } as unknown as SuperfunctionsConfig;
      return { connection: await createAdapterFromConfig(config), config };
    }
    const config = {
      adapter: {
        type: adapterType,
        [adapterType]: { dialect: 'mysql', connectionString: 'mysql://example.invalid:3306/app' },
      },
    } as unknown as SuperfunctionsConfig;
    return {
      connection: {
        adapter: {} as AdapterConnection['adapter'],
        dialect: 'mysql',
        rawConnection,
        close: async () => undefined,
      },
      config,
    };
  }

  it('introspects a dev v7 MySQL database through the generate command path and widens claim_token', async () => {
    // DATABASE_URL names another dialect or database than the PrismaClient's
    // datasource; the CLI must follow the client.
    for (const databaseUrl of ['postgresql://example.invalid:5432/otherdb', 'mysql://example.invalid:3306/otherdb']) {
      vi.stubEnv('DATABASE_URL', databaseUrl);
      for (const adapterType of adapterTypes) {
        const { connection, config } = await commandConnection(
          adapterType,
          mysqlV7Snapshot(schema.schemas, DEV_V7_CLAIM_TOKEN_LENGTH),
        );
        expect(connection.dialect, adapterType).toBe('mysql');
        const currentTables = await introspectCurrentTables(connection, adapterType, config);

        expect(currentTables.map((table) => table.name).sort(), adapterType).toEqual(
          schema.schemas.map((table) => table.modelName).sort(),
        );
        expectDevV7Widening(
          adapterType,
          createPendingMigration({
            adapterType,
            dialect: 'mysql',
            library,
            currentVersion: V7_SCHEMA_VERSION,
            currentTables,
          }),
        );
      }
    }
  });

  it('refuses the widening before any DDL on a COMPACT table whose key part would exceed 767 bytes', async () => {
    for (const adapterType of adapterTypes) {
      const { connection, config } = await commandConnection(
        adapterType,
        mysqlV7Snapshot(schema.schemas, DEV_V7_CLAIM_TOKEN_LENGTH, 'Compact'),
      );
      const currentTables = await introspectCurrentTables(connection, adapterType, config);

      expect(
        () =>
          createPendingMigration({
            adapterType,
            dialect: 'mysql',
            library,
            currentVersion: V7_SCHEMA_VERSION,
            currentTables,
          }),
        adapterType,
      ).toThrow(
        /plugfn_sync_jobs: its Compact row format limits index key parts to 767 bytes.*idx_plugfn_sync_jobs_claim_token \(claim_token VARCHAR\(768\)\).*ROW_FORMAT=DYNAMIC/,
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
