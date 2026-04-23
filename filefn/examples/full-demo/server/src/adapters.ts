import type { Adapter, AdapterCapabilities } from "@superfunctions/db";

const FAKE_DB_CAPABILITIES: AdapterCapabilities = {
  types: {
    json: true,
    dates: true,
    booleans: true,
    bigint: false,
    uuid: false,
    enum: false,
  },
  operations: {
    batch: false,
    upsert: true,
    streaming: false,
    fulltext: false,
    returning: false,
  },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: false, indexes: false },
  advanced: {
    customIdGeneration: false,
    numericIds: false,
    schemaNamespaces: false,
    customTypes: false,
  },
};

export function createFakeDbAdapter(): Adapter {
  const tables = new Map<string, Map<string, any>>();
  let idCounter = 1;

  function getTable(model: string): Map<string, any> {
    if (!tables.has(model)) tables.set(model, new Map());
    return tables.get(model)!;
  }

  function matchesWhere(record: any, where: any[]): boolean {
    if (!where) return true;
    for (const clause of where) {
      const value = record[clause.field];
      switch (clause.operator) {
        case "eq":
          if (value !== clause.value) return false;
          break;
        case "ne":
          if (value === clause.value) return false;
          break;
        default:
          throw new Error(`Unsupported where operator: ${clause.operator}`);
      }
    }
    return true;
  }

  return {
    id: "fake",
    name: "fake",
    version: "1.0.0",
    capabilities: FAKE_DB_CAPABILITIES,
    async create(params: any) {
      const table = getTable(params.model);
      const id =
        params.data.uploadSessionId ||
        params.data.versionId ||
        params.data.fileId ||
        params.data.permissionId ||
        `id_${idCounter++}`;
      const record = { ...params.data, _id: id };
      table.set(id, record);
      return record;
    },
    async findOne(params: any) {
      const table = getTable(params.model);
      for (const record of table.values()) {
        if (matchesWhere(record, params.where)) return record;
      }
      return null;
    },
    async findMany(params: any) {
      const table = getTable(params.model);
      const results: any[] = [];
      for (const record of table.values()) {
        if (
          !params.where ||
          params.where.length === 0 ||
          matchesWhere(record, params.where)
        ) {
          results.push(record);
        }
      }
      if (
        params.orderBy?.some(
          (o: any) => o.field === "createdAt" && o.direction === "desc",
        )
      ) {
        results.sort((a, b) => {
          const da = new Date(a.createdAt).getTime();
          const db = new Date(b.createdAt).getTime();
          return db - da;
        });
      }
      return results.slice(0, params.limit || results.length);
    },
    async update(params: any) {
      const table = getTable(params.model);
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          const updated = { ...record, ...params.data };
          table.set(id, updated);
          return updated;
        }
      }
      return null;
    },
    async delete(params: any) {
      const table = getTable(params.model);
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          table.delete(id);
          return;
        }
      }
    },
    async createMany(this: any, params: any) {
      const created = [];
      for (const data of params.data) {
        created.push(await this.create({ ...params, data }));
      }
      return created;
    },
    async updateMany(params: any) {
      const table = getTable(params.model);
      let count = 0;
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          table.set(id, { ...record, ...params.data });
          count++;
        }
      }
      return count;
    },
    async deleteMany(params: any) {
      const table = getTable(params.model);
      let count = 0;
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          table.delete(id);
          count++;
        }
      }
      return count;
    },
    async upsert(this: any, params: any) {
      const existing = await this.findOne({
        model: params.model,
        where: params.where,
        namespace: params.namespace,
      });
      if (existing) {
        return await this.update({
          model: params.model,
          where: params.where,
          data: params.update,
          namespace: params.namespace,
        });
      }
      return await this.create({
        model: params.model,
        data: params.create,
        namespace: params.namespace,
      });
    },
    async count(params: any) {
      const table = getTable(params.model);
      let count = 0;
      for (const record of table.values()) {
        if (matchesWhere(record, params.where)) {
          count++;
        }
      }
      return count;
    },
    async transaction(callback: any) {
      return callback(this as any);
    },
    async initialize() {},
    async isHealthy() {
      return { healthy: true, uptime: 0 };
    },
    async close() {},
    async getSchemaVersion() {
      return 0;
    },
    async setSchemaVersion() {},
    async validateSchema() {
      return { valid: true };
    },
  } as unknown as Adapter;
}
