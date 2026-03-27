import type { InternalCrud, InternalColumnDef } from '../../adapter/types.js';

const TABLE_NAME_RE = /^__datafn_[a-z0-9_]+$/;

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

function buildWhereSQL(
  where: Array<{ field: string; op: string; value: unknown }>,
): { clause: string; params: unknown[] } {
  if (where.length === 0) return { clause: '', params: [] };

  const parts: string[] = [];
  const params: unknown[] = [];
  for (const w of where) {
    parts.push(`${w.field} ${mapOp(w.op)} ?`);
    params.push(w.value);
  }

  return { clause: ` WHERE ${parts.join(' AND ')}`, params };
}

export function createPrismaInternalCrud(prisma: any): InternalCrud {
  const ensuredTables = new Set<string>();

  return {
    async ensureTable(name: string, columns: InternalColumnDef[]): Promise<void> {
      if (!TABLE_NAME_RE.test(name)) {
        throw new Error(`ensureTable: table name must start with "__datafn_": "${name}"`);
      }

      if (ensuredTables.has(name)) return;

      const colDefs = columns.map((col) => {
        const sqlType = col.type === 'text' ? 'TEXT' : 'INTEGER';
        const pk = col.primaryKey ? ' PRIMARY KEY' : '';
        return `${col.name} ${sqlType}${pk}`;
      });

      const ddl = `CREATE TABLE IF NOT EXISTS ${name} (${colDefs.join(', ')})`;
      await prisma.$executeRawUnsafe(ddl);
      ensuredTables.add(name);
    },

    async create(
      table: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const cols = Object.keys(data);
      const placeholders = cols.map(() => '?').join(', ');
      const vals = cols.map((k) => data[k]);

      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      await prisma.$executeRawUnsafe(sql, ...vals);
      return data;
    },

    async findOne(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
    ): Promise<Record<string, unknown> | null> {
      const { clause, params } = buildWhereSQL(where);
      const sql = `SELECT * FROM ${table}${clause} LIMIT 1`;
      const rows: Record<string, unknown>[] = await prisma.$queryRawUnsafe(sql, ...params);
      return rows[0] ?? null;
    },

    async findMany(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
      opts?: { orderBy?: string; limit?: number },
    ): Promise<Record<string, unknown>[]> {
      const { clause, params } = buildWhereSQL(where);
      let sql = `SELECT * FROM ${table}${clause}`;

      if (opts?.orderBy) {
        const desc = opts.orderBy.startsWith('-');
        const field = desc ? opts.orderBy.slice(1) : opts.orderBy;
        sql += ` ORDER BY ${field} ${desc ? 'DESC' : 'ASC'}`;
      }

      if (typeof opts?.limit === 'number') {
        sql += ` LIMIT ${opts.limit}`;
      }

      return await prisma.$queryRawUnsafe(sql, ...params);
    },

    async update(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
      data: Record<string, unknown>,
    ): Promise<number> {
      const cols = Object.keys(data);
      const setParts = cols.map((col) => `${col} = ?`);
      const setParams = cols.map((k) => data[k]);

      const { clause, params: whereParams } = buildWhereSQL(where);
      const sql = `UPDATE ${table} SET ${setParts.join(', ')}${clause}`;

      return await prisma.$executeRawUnsafe(sql, ...setParams, ...whereParams);
    },

    async delete(
      table: string,
      where: Array<{ field: string; op: string; value: unknown }>,
    ): Promise<number> {
      const { clause, params } = buildWhereSQL(where);
      const sql = `DELETE FROM ${table}${clause}`;

      return await prisma.$executeRawUnsafe(sql, ...params);
    },
  };
}
