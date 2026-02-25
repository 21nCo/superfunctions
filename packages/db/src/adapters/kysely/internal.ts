import type { InternalCrud, InternalColumnDef } from '../../adapter/types.js';

export type KyselyDialect = 'postgres' | 'mysql' | 'sqlite';

let kyselySql: any;
try {
  const mod = await import('kysely');
  kyselySql = mod.sql;
} catch {}

const OP_MAP: Record<string, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

function mapOp(op: string): string {
  const mapped = OP_MAP[op];
  if (!mapped) throw new Error(`Unsupported internal CRUD operator: ${op}`);
  return mapped;
}

function buildWhereClause(
  where: Array<{ field: string; op: string; value: unknown }>,
): { fragment: any; empty: boolean } {
  if (where.length === 0) {
    return { fragment: null, empty: true };
  }

  let combined = kyselySql`${kyselySql.raw(where[0].field)} ${kyselySql.raw(mapOp(where[0].op))} ${where[0].value}`;
  for (let i = 1; i < where.length; i++) {
    const w = where[i];
    combined = kyselySql`${combined} AND ${kyselySql.raw(w.field)} ${kyselySql.raw(mapOp(w.op))} ${w.value}`;
  }

  return { fragment: combined, empty: false };
}

export function createKyselyInternalCrud(db: any, _dialect: KyselyDialect): InternalCrud {
  const ensuredTables = new Set<string>();

  const TABLE_NAME_RE = /^__datafn_[a-z0-9_]+$/;

  return {
    async ensureTable(name: string, columns: InternalColumnDef[]): Promise<void> {
      if (!TABLE_NAME_RE.test(name)) {
        throw new Error(`ensureTable: table name must start with "__datafn_": "${name}"`);
      }

      if (ensuredTables.has(name)) return;

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
      ensuredTables.add(name);
    },

    async create(
      table: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const cols = Object.keys(data);
      const vals = cols.map((k) => data[k]);

      const query = kyselySql`INSERT INTO ${kyselySql.raw(table)} (${kyselySql.raw(cols.join(', '))}) VALUES (${kyselySql.join(
        vals.map((v: unknown) => kyselySql`${v}`),
        kyselySql`, `,
      )})`;

      await query.execute(db);
      return data;
    },

    async findOne(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
    ): Promise<Record<string, unknown> | null> {
      const { fragment, empty } = buildWhereClause(where);

      const query = empty
        ? kyselySql<Record<string, unknown>>`SELECT * FROM ${kyselySql.raw(table)} LIMIT 1`
        : kyselySql<Record<string, unknown>>`SELECT * FROM ${kyselySql.raw(table)} WHERE ${fragment} LIMIT 1`;

      const result = await query.execute(db);
      return result.rows[0] ?? null;
    },

    async findMany(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
      opts?: { orderBy?: string; limit?: number },
    ): Promise<Record<string, unknown>[]> {
      const { fragment, empty } = buildWhereClause(where);

      let query;
      if (empty) {
        query = kyselySql<Record<string, unknown>>`SELECT * FROM ${kyselySql.raw(table)}`;
      } else {
        query = kyselySql<Record<string, unknown>>`SELECT * FROM ${kyselySql.raw(table)} WHERE ${fragment}`;
      }

      if (opts?.orderBy) {
        const desc = opts.orderBy.startsWith('-');
        const field = desc ? opts.orderBy.slice(1) : opts.orderBy;
        const dir = desc ? 'DESC' : 'ASC';
        query = kyselySql<Record<string, unknown>>`${query} ORDER BY ${kyselySql.raw(field)} ${kyselySql.raw(dir)}`;
      }

      if (typeof opts?.limit === 'number') {
        query = kyselySql<Record<string, unknown>>`${query} LIMIT ${opts.limit}`;
      }

      const result = await query.execute(db);
      return result.rows;
    },

    async update(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
      data: Record<string, unknown>,
    ): Promise<number> {
      const cols = Object.keys(data);

      const setParts = cols.map((col) => kyselySql`${kyselySql.raw(col)} = ${data[col]}`);
      const setClause = kyselySql.join(setParts, kyselySql`, `);

      const { fragment, empty } = buildWhereClause(where);

      const query = empty
        ? kyselySql`UPDATE ${kyselySql.raw(table)} SET ${setClause}`
        : kyselySql`UPDATE ${kyselySql.raw(table)} SET ${setClause} WHERE ${fragment}`;

      const result = await query.execute(db);
      return Number(result.numAffectedRows ?? 0);
    },

    async delete(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
    ): Promise<number> {
      const { fragment, empty } = buildWhereClause(where);

      const query = empty
        ? kyselySql`DELETE FROM ${kyselySql.raw(table)}`
        : kyselySql`DELETE FROM ${kyselySql.raw(table)} WHERE ${fragment}`;

      const result = await query.execute(db);
      return Number(result.numAffectedRows ?? 0);
    },
  };
}
