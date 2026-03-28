import type {
  InternalCrud,
  InternalColumnDef,
  InternalWhereClause,
} from '../../adapter/types.js';
import {
  assertInternalColumnDefs,
  assertInternalTableName,
  assertInternalWhereClauses,
  internalOperatorSql,
  normalizeInternalResultCount,
  parseInternalOrderBy,
  quoteInternalIdentifier,
} from '../internal-utils.js';

export type KyselyDialect = 'postgres' | 'mysql' | 'sqlite';

let kyselySql: any;
let kyselyImportError: unknown;
try {
  const mod = await import('kysely');
  kyselySql = mod.sql;
} catch (error) {
  kyselyImportError = error;
}

function buildWhereClause(
  where: InternalWhereClause[],
  dialect: KyselyDialect,
): { fragment: any; empty: boolean } {
  if (where.length === 0) {
    return { fragment: null, empty: true };
  }

  assertInternalWhereClauses(where);
  const sql = getKyselySql();

  function buildCondition(clause: InternalWhereClause): any {
    const fieldSql = sql.raw(quoteInternalIdentifier(clause.field, dialect));

    if (clause.value === null && clause.op === 'eq') {
      return sql`${fieldSql} IS NULL`;
    }

    if (clause.value === null && clause.op === 'ne') {
      return sql`${fieldSql} IS NOT NULL`;
    }

    return sql`${fieldSql} ${sql.raw(internalOperatorSql(clause.op))} ${clause.value}`;
  }

  let combined = buildCondition(where[0]);
  for (let i = 1; i < where.length; i++) {
    combined = sql`${combined} AND ${buildCondition(where[i])}`;
  }

  return { fragment: combined, empty: false };
}

function getKyselySql(): any {
  if (!kyselySql) {
    throw new Error(
      `kysely is required as a peerDependency to use Kysely internal CRUD helpers${kyselyImportError ? `: ${String(kyselyImportError)}` : ''}`,
    );
  }
  return kyselySql;
}

export function createKyselyInternalCrud(db: any, _dialect: KyselyDialect): InternalCrud {
  const sql = getKyselySql();
  const ensurePromises = new Map<string, Promise<void>>();

  return {
    async ensureTable(name: string, columns: InternalColumnDef[]): Promise<void> {
      assertInternalTableName(name);
      assertInternalColumnDefs(columns);

      if (ensurePromises.has(name)) return ensurePromises.get(name)!;

      const promise = (async () => {
        let builder = db.schema.createTable(name).ifNotExists();
        for (const col of columns) {
          const colType = col.type === 'text' ? 'text' : 'integer';
          if (col.primaryKey) {
            builder = builder.addColumn(col.name, colType, (cb: any) => cb.primaryKey());
          } else {
            builder = builder.addColumn(col.name, colType);
          }
        }
        await builder.execute();
      })();

      ensurePromises.set(name, promise);
      try {
        await promise;
      } catch (error) {
        ensurePromises.delete(name);
        throw error;
      }
    },

    async create(
      table: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      assertInternalTableName(table);
      const cols = Object.keys(data);
      cols.forEach((col) => assertInternalColumnDefs([{ name: col, type: 'text' }]));
      const vals = cols.map((k) => data[k]);
      const quotedColumns = cols.map((col) => quoteInternalIdentifier(col, _dialect)).join(', ');

      const query = sql`INSERT INTO ${sql.raw(quoteInternalIdentifier(table, _dialect))} (${sql.raw(quotedColumns)}) VALUES (${sql.join(
        vals.map((v: unknown) => sql`${v}`),
        sql`, `,
      )})`;

      await query.execute(db);
      if (data.id !== undefined && data.id !== null) {
        return (
          (await this.findOne(table, [{ field: 'id', op: 'eq', value: data.id }])) ??
          data
        );
      }
      return data;
    },

    async findOne(
      table: string,
      where: InternalWhereClause[],
    ): Promise<Record<string, unknown> | null> {
      assertInternalTableName(table);
      const { fragment, empty } = buildWhereClause(where, _dialect);

      const query = empty
        ? sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(quoteInternalIdentifier(table, _dialect))} LIMIT 1`
        : sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(quoteInternalIdentifier(table, _dialect))} WHERE ${fragment} LIMIT 1`;

      const result = await query.execute(db);
      return result.rows[0] ?? null;
    },

    async findMany(
      table: string,
      where: InternalWhereClause[],
      opts?: { orderBy?: string; limit?: number },
    ): Promise<Record<string, unknown>[]> {
      assertInternalTableName(table);
      const { fragment, empty } = buildWhereClause(where, _dialect);

      let query;
      if (empty) {
        query = sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(quoteInternalIdentifier(table, _dialect))}`;
      } else {
        query = sql<Record<string, unknown>>`SELECT * FROM ${sql.raw(quoteInternalIdentifier(table, _dialect))} WHERE ${fragment}`;
      }

      if (opts?.orderBy) {
        const order = parseInternalOrderBy(opts.orderBy);
        query = sql<Record<string, unknown>>`${query} ORDER BY ${sql.raw(quoteInternalIdentifier(order.field, _dialect))} ${sql.raw(order.direction)}`;
      }

      if (typeof opts?.limit === 'number') {
        query = sql<Record<string, unknown>>`${query} LIMIT ${Math.trunc(opts.limit)}`;
      }

      const result = await query.execute(db);
      return result.rows;
    },

    async update(
      table: string,
      where: InternalWhereClause[],
      data: Record<string, unknown>,
    ): Promise<number> {
      assertInternalTableName(table);
      const cols = Object.keys(data);
      cols.forEach((col) => assertInternalColumnDefs([{ name: col, type: 'text' }]));
      if (cols.length === 0) {
        return 0;
      }

      const setParts = cols.map((col) => sql`${sql.raw(quoteInternalIdentifier(col, _dialect))} = ${data[col]}`);
      const setClause = sql.join(setParts, sql`, `);

      const { fragment, empty } = buildWhereClause(where, _dialect);

      const query = empty
        ? sql`UPDATE ${sql.raw(quoteInternalIdentifier(table, _dialect))} SET ${setClause}`
        : sql`UPDATE ${sql.raw(quoteInternalIdentifier(table, _dialect))} SET ${setClause} WHERE ${fragment}`;

      const result = await query.execute(db);
      return normalizeInternalResultCount(result.numAffectedRows ?? 0);
    },

    async delete(
      table: string,
      where: InternalWhereClause[],
    ): Promise<number> {
      assertInternalTableName(table);
      const { fragment, empty } = buildWhereClause(where, _dialect);

      const query = empty
        ? sql`DELETE FROM ${sql.raw(quoteInternalIdentifier(table, _dialect))}`
        : sql`DELETE FROM ${sql.raw(quoteInternalIdentifier(table, _dialect))} WHERE ${fragment}`;

      const result = await query.execute(db);
      return normalizeInternalResultCount(result.numAffectedRows ?? 0);
    },
  };
}
