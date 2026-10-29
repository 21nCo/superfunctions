import { readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnPasswordPlugin } from '@authfn/password';
import {
  generateDrizzleSchemaFile,
  generateLibraryAbstractSchema
} from '../../../../../packages/cli/src/utils/schema-generators.js';
import { getSchema } from '../../index.js';
import { authFnSqliteSchema, migrationStatements } from './fixture.js';

interface TableShape {
  columns: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean }>;
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
  foreignKeys: Array<{ columns: string[]; table: string; foreignColumns: string[] }>;
}

describe('authfn SQLite conformance fixture', () => {
  it('matches the current generate-schema --adapter drizzle --dialect sqlite output', async () => {
    const abstractSchema = await generateLibraryAbstractSchema(
      { getSchema },
      { plugins: [authFnPasswordPlugin(), authFnApiKeyPlugin()] }
    );
    // The CLI passes `config.namespace || libraryName` as the table prefix.
    const generated = generateDrizzleSchemaFile(abstractSchema, 'authfn', 'authfn', 'sqlite');
    const checkedIn = readFileSync(new URL('./generated/authfn-schema.ts', import.meta.url), 'utf8');
    expect(checkedIn).toBe(generated);
  });

  it('checks in a single initial migration for Wrangler to apply', () => {
    const files = readdirSync(new URL('./migrations/', import.meta.url)).filter((file) => file.endsWith('.sql'));
    expect(files).toEqual(['0000_authfn_sqlite.sql']);
  });

  it('migrates to exactly the tables, columns, indexes and foreign keys the generated schema declares', () => {
    const sqlite = new Database(':memory:');
    try {
      for (const statement of migrationStatements) sqlite.exec(statement);

      const declared = Object.fromEntries(
        Object.values(authFnSqliteSchema)
          .filter((value): value is SQLiteTable => is(value, SQLiteTable))
          .map((table) => {
            const config = getTableConfig(table);
            return [config.name, declaredShape(config)] as const;
          })
      );
      const migrated = Object.fromEntries(
        (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
          .map(({ name }) => [name, migratedShape(sqlite, name)] as const)
      );

      expect(Object.keys(declared).sort()).toEqual([
        'authfn_api_keys',
        'authfn_password_credentials',
        'authfn_sessions',
        'authfn_users'
      ]);
      expect(migrated).toEqual(declared);
    } finally {
      sqlite.close();
    }
  });
});

function declaredShape(config: ReturnType<typeof getTableConfig>): TableShape {
  return {
    columns: config.columns
      .map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        primaryKey: column.primary
      }))
      .sort(byName),
    indexes: config.indexes
      .map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        columns: index.config.columns.map((column) => (column as { name: string }).name)
      }))
      .sort(byName),
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        table: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((column) => column.name)
      };
    })
  };
}

function migratedShape(sqlite: Database.Database, table: string): TableShape {
  const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  const indexes = (sqlite.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>).filter((index) => index.origin === 'c');
  const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    id: number;
    table: string;
    from: string;
    to: string;
  }>;

  return {
    columns: columns
      .map((column) => ({
        name: column.name,
        type: column.type.toLowerCase(),
        // SQLite reports a PRIMARY KEY column as nullable unless NOT NULL is spelled out.
        notNull: column.notnull === 1,
        primaryKey: column.pk > 0
      }))
      .sort(byName),
    indexes: indexes
      .map((index) => ({
        name: index.name,
        unique: index.unique === 1,
        columns: (sqlite.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      }))
      .sort(byName),
    foreignKeys: [...new Set(foreignKeys.map((foreignKey) => foreignKey.id))].map((id) => {
      const parts = foreignKeys.filter((foreignKey) => foreignKey.id === id);
      return {
        columns: parts.map((part) => part.from),
        table: parts[0]!.table,
        foreignColumns: parts.map((part) => part.to)
      };
    })
  };
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}
