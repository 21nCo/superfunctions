import type { InternalCrud, InternalColumnDef } from '../../adapter/types.js';

export type DrizzleDialect = 'postgres' | 'mysql' | 'sqlite';

let drizzleSql: any;
try {
  const mod = await import('drizzle-orm');
  drizzleSql = mod.sql;
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

  let combined = drizzleSql`${drizzleSql.raw(where[0].field)} ${drizzleSql.raw(mapOp(where[0].op))} ${where[0].value}`;
  for (let i = 1; i < where.length; i++) {
    const w = where[i];
    combined = drizzleSql`${combined} AND ${drizzleSql.raw(w.field)} ${drizzleSql.raw(mapOp(w.op))} ${w.value}`;
  }

  return { fragment: combined, empty: false };
}

export function createDrizzleInternalCrud(db: any, dialect: DrizzleDialect): InternalCrud {
  const ensurePromises = new Map<string, Promise<void>>();

  const TABLE_NAME_RE = /^__datafn_[a-z0-9_]+$/;

  // Dialect-aware execution helpers
  const isSQLite = dialect === 'sqlite';

  async function executeRaw(query: any): Promise<any> {
    if (isSQLite && typeof db.run === 'function') {
      // SQLite (better-sqlite3): use db.run()
      return await db.run(query);
    } else {
      // Postgres/MySQL: use db.execute()
      return await db.execute(query);
    }
  }

  async function queryRaw(query: any): Promise<any[]> {
    if (isSQLite && typeof db.all === 'function') {
      // SQLite (better-sqlite3): use db.all()
      return await db.all(query);
    } else {
      // Postgres/MySQL: use db.execute() which returns rows directly or in .rows property
      const result = await db.execute(query);
      // For Postgres, result is an array of rows directly
      // For MySQL, result might be { rows } or just the array
      return Array.isArray(result) ? result : (result?.rows ?? []);
    }
  }

  return {
    async ensureTable(name: string, columns: InternalColumnDef[]): Promise<void> {
      if (!TABLE_NAME_RE.test(name)) {
        throw new Error(`ensureTable: table name must start with "__datafn_": "${name}"`);
      }

      // Use a promise-based lock to prevent concurrent DDL for the same table.
      // Without this, concurrent calls pass the guard before any completes,
      // causing PostgreSQL pg_type duplicate key errors on CREATE TABLE IF NOT EXISTS.
      if (ensurePromises.has(name)) return ensurePromises.get(name);

      const promise = (async () => {
        const colDefs = columns.map((col) => {
          const sqlType = col.type === 'text' ? 'TEXT' : 'INTEGER';
          const pk = col.primaryKey ? ' PRIMARY KEY' : '';
          return `${col.name} ${sqlType}${pk}`;
        });

        const ddl = `CREATE TABLE IF NOT EXISTS ${name} (${colDefs.join(', ')})`;
        await executeRaw(drizzleSql.raw(ddl));
      })();

      ensurePromises.set(name, promise);
      return promise;
    },

    async create(
      table: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const cols = Object.keys(data);
      const vals = cols.map((k) => data[k]);

      const query = drizzleSql`INSERT INTO ${drizzleSql.raw(table)} (${drizzleSql.raw(cols.join(', '))}) VALUES (${drizzleSql.join(
        vals.map((v) => drizzleSql`${v}`),
        drizzleSql`, `,
      )})`;

      await executeRaw(query);
      return data;
    },

    async findOne(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
    ): Promise<Record<string, unknown> | null> {
      const { fragment, empty } = buildWhereClause(where);

      const query = empty
        ? drizzleSql`SELECT * FROM ${drizzleSql.raw(table)} LIMIT 1`
        : drizzleSql`SELECT * FROM ${drizzleSql.raw(table)} WHERE ${fragment} LIMIT 1`;

      const rows = await queryRaw(query);
      return rows[0] ?? null;
    },

    async findMany(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
      opts?: { orderBy?: string; limit?: number },
    ): Promise<Record<string, unknown>[]> {
      const { fragment, empty } = buildWhereClause(where);

      let query;
      if (empty) {
        query = drizzleSql`SELECT * FROM ${drizzleSql.raw(table)}`;
      } else {
        query = drizzleSql`SELECT * FROM ${drizzleSql.raw(table)} WHERE ${fragment}`;
      }

      if (opts?.orderBy) {
        const desc = opts.orderBy.startsWith('-');
        const field = desc ? opts.orderBy.slice(1) : opts.orderBy;
        const dir = desc ? 'DESC' : 'ASC';
        query = drizzleSql`${query} ORDER BY ${drizzleSql.raw(field)} ${drizzleSql.raw(dir)}`;
      }

      if (typeof opts?.limit === 'number') {
        query = drizzleSql`${query} LIMIT ${opts.limit}`;
      }

      return await queryRaw(query);
    },

    async update(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
      data: Record<string, unknown>,
    ): Promise<number> {
      const cols = Object.keys(data);

      const setParts = cols.map((col) => drizzleSql`${drizzleSql.raw(col)} = ${data[col]}`);
      const setClause = drizzleSql.join(setParts, drizzleSql`, `);

      const { fragment, empty } = buildWhereClause(where);

      const query = empty
        ? drizzleSql`UPDATE ${drizzleSql.raw(table)} SET ${setClause}`
        : drizzleSql`UPDATE ${drizzleSql.raw(table)} SET ${setClause} WHERE ${fragment}`;

      const result = await executeRaw(query);
      return (result as any)?.changes ?? (result as any)?.rowsAffected ?? (result as any)?.rowCount ?? 0;
    },

    async delete(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
    ): Promise<number> {
      const { fragment, empty } = buildWhereClause(where);

      const query = empty
        ? drizzleSql`DELETE FROM ${drizzleSql.raw(table)}`
        : drizzleSql`DELETE FROM ${drizzleSql.raw(table)} WHERE ${fragment}`;

      const result = await executeRaw(query);
      return (result as any)?.changes ?? (result as any)?.rowsAffected ?? (result as any)?.rowCount ?? 0;
    },
  };
}
