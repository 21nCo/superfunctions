import type { Adapter, AdapterCapabilities } from "@superfunctions/db";
import type {
  StorageAdapter,
  StorageAdapterCapabilities,
  StorageObjectStat,
  SignedUrlConstraints,
} from "@superfunctions/storage";

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
          break;
      }
    }
    return true;
  }

  return {
    id: "fake",
    name: "fake",
    version: "1.0.0",
    capabilities: FAKE_DB_CAPABILITIES,
    async create(params) {
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
    async findOne(params) {
      const table = getTable(params.model);
      for (const record of table.values()) {
        if (matchesWhere(record, params.where)) return record;
      }
      return null;
    },
    async findMany(params) {
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
    async update(params) {
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
    async delete(params) {
      const table = getTable(params.model);
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          table.delete(id);
          return;
        }
      }
    },
    async createMany(params) {
      return [];
    },
    async updateMany(params) {
      return 0;
    },
    async deleteMany(params) {
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
    async upsert(params) {
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
    async count(params) {
      return 0;
    },
    async transaction(callback) {
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
  } as Adapter;
}

const FAKE_STORAGE_CAPABILITIES: StorageAdapterCapabilities = {
  signedUploadUrls: true,
  signedDownloadUrls: true,
  multipart: true, // we will support basic multipart
  proxyStreamingUpload: false,
  proxyStreamingDownload: false,
};

export interface MemoryStorage extends StorageAdapter {
  // Custom method to direct-write
  directWrite(key: string, data: Uint8Array): void;
  directRead(key: string): Uint8Array | undefined;
}

export function createMemoryStorage(): MemoryStorage {
  const files = new Map<string, { content: Uint8Array }>();

  return {
    name: "local",
    capabilities: FAKE_STORAGE_CAPABILITIES,

    // Custom methods
    directWrite(key, data) {
      files.set(key, { content: data });
    },
    directRead(key) {
      return files.get(key)?.content;
    },

    // Interface methods
    async statObject(input) {
      const f = files.get(input.key);
      if (!f) throw new Error("Not found");
      return {
        key: input.key,
        size: f.content.length,
        etag: "etag",
      };
    },

    async deleteObject(input) {
      files.delete(input.key);
    },

    async signUploadUrl(input) {
      return {
        url: `http://localhost:3000/_storage/upload/${Buffer.from(input.key).toString("base64")}`,
        // method: 'PUT', // The interface returns { url, headers }
        // Wait, check interface again. Promise<{ url: string; headers?: Record<string, string> }>
        headers: {
          "Content-Type":
            input.constraints?.contentType || "application/octet-stream",
        },
      };
    },

    async signDownloadUrl(input) {
      return {
        url: `http://localhost:3000/_storage/download/${Buffer.from(input.key).toString("base64")}`,
        headers: {},
      };
    },

    async createMultipartUpload(input) {
      return { uploadId: "multi-" + Date.now() };
    },

    async signMultipartUploadPartUrl(input) {
      return {
        url: `http://localhost:3000/_storage/upload/${Buffer.from(input.key).toString("base64")}`,
        headers: {},
      };
    },

    async completeMultipartUpload(input) {
      // In this fake implementation, we assume the client uploaded to the same key via the signed URL
      // So standard upload logic already put the content there.
      // We just verify it exists.
      if (!files.has(input.key)) {
        // If not, creates empty? Or throws?
        // For demo simplicity, assume success.
        files.set(input.key, { content: Buffer.from("multipart-merged") });
      }
    },

    async abortMultipartUpload(input) {},
  };
}
