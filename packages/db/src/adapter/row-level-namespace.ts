/**
 * Row-level namespace isolation wrapper for database adapters.
 *
 * Wraps a DatabaseAdapter to automatically inject namespace filtering on reads
 * and stamp namespace on writes, providing tenant/user-level data isolation.
 */

import type {
  Adapter,
  RowLevelNamespaceConfig,
  WhereClause,
} from './types.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class NamespaceRequiredError extends Error {
  public readonly code = 'NAMESPACE_REQUIRED';

  constructor() {
    super('Row-level namespace is enabled but no namespace was provided');
    this.name = 'NamespaceRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Resolved config (all defaults applied)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  columnName: string;
  mandatory: boolean;
}

function resolveConfig(config: RowLevelNamespaceConfig): ResolvedConfig {
  return {
    columnName: config.columnName ?? '__ns',
    mandatory: config.mandatory ?? true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNamespace(
  ns: string | undefined | null,
  mandatory: boolean,
): asserts ns is string {
  if (mandatory && (!ns || ns === '')) {
    throw new NamespaceRequiredError();
  }
}

function namespaceWhereClause(col: string, ns: string): WhereClause {
  return { field: col, operator: 'eq', value: ns };
}

function prependWhere(
  existing: WhereClause[] | undefined,
  clause: WhereClause,
): WhereClause[] {
  return [clause, ...(existing ?? [])];
}

function stripColumn<T>(record: T, col: string): T {
  if (!record || typeof record !== 'object') return record;
  const copy = { ...record } as Record<string, unknown>;
  delete copy[col];
  return copy as T;
}

function stripColumnFromArray<T>(records: T[], col: string): T[] {
  return records.map((r) => stripColumn(r, col));
}

function stampData(
  data: Record<string, any>,
  col: string,
  ns: string,
): Record<string, any> {
  return { ...data, [col]: ns };
}

function removeColumnFromData(
  data: Record<string, any>,
  col: string,
): Record<string, any> {
  if (!(col in data)) return data;
  const copy = { ...data };
  delete copy[col];
  return copy;
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an Adapter with row-level namespace isolation.
 *
 * When enabled:
 * - Reads: `__ns` WHERE clause is prepended to every query.
 * - Writes: `__ns` is stamped into create data.
 * - Updates: `__ns` is stripped from update data (immutable).
 * - Outputs: `__ns` is stripped from all returned records.
 * - Internal CRUD (`adapter.internal`) is NOT affected.
 */
export function wrapWithRowLevelNamespace(
  adapter: Adapter,
  config: RowLevelNamespaceConfig,
): Adapter {
  if (!config.enabled) return adapter;

  const { columnName: col, mandatory } = resolveConfig(config);

  const wrapped: Adapter = {
    // --- Pass-through metadata ---
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    capabilities: adapter.capabilities,

    // --- Pass-through internal (NOT wrapped) ---
    internal: adapter.internal,

    // --- CRUD ---

    async create(params) {
      assertNamespace(params.namespace, mandatory);
      const data = stampData(params.data, col, params.namespace!);
      const result = await adapter.create({ ...params, data });
      return stripColumn(result, col);
    },

    async createMany(params) {
      assertNamespace(params.namespace, mandatory);
      const data = params.data.map((d) => stampData(d, col, params.namespace!));
      const results = await adapter.createMany({ ...params, data });
      return stripColumnFromArray(results, col);
    },

    async findOne(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      const result = await adapter.findOne({ ...params, where });
      return result ? stripColumn(result, col) : null;
    },

    async findMany(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      const results = await adapter.findMany({ ...params, where });
      return stripColumnFromArray(results, col);
    },

    async update(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      const data = removeColumnFromData(params.data, col);
      const result = await adapter.update({ ...params, where, data });
      return stripColumn(result, col);
    },

    async updateMany(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      const data = removeColumnFromData(params.data, col);
      return adapter.updateMany({ ...params, where, data });
    },

    async delete(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      return adapter.delete({ ...params, where });
    },

    async deleteMany(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      return adapter.deleteMany({ ...params, where });
    },

    async upsert(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      const create = stampData(params.create, col, params.namespace!);
      const update = removeColumnFromData(params.update, col);
      const result = await adapter.upsert({
        ...params,
        where,
        create,
        update,
      });
      return stripColumn(result, col);
    },

    async count(params) {
      assertNamespace(params.namespace, mandatory);
      const where = prependWhere(
        params.where,
        namespaceWhereClause(col, params.namespace!),
      );
      return adapter.count({ ...params, where });
    },

    // --- Transaction: wrap child adapter ---
    async transaction(callback) {
      return adapter.transaction(async (trx) => {
        // Wrap the transaction adapter with the same namespace filtering
        const wrappedTrx = wrapWithRowLevelNamespace(
          trx as unknown as Adapter,
          config,
        ) as unknown as typeof trx;
        return callback(wrappedTrx);
      });
    },

    // --- Lifecycle pass-through ---
    initialize: () => adapter.initialize(),
    isHealthy: () => adapter.isHealthy(),
    close: () => adapter.close(),

    // --- Schema management pass-through ---
    getSchemaVersion: (ns) => adapter.getSchemaVersion(ns),
    setSchemaVersion: (ns, v) => adapter.setSchemaVersion(ns, v),
    validateSchema: (s) => adapter.validateSchema(s),

    // Optional schema creation
    createSchema: adapter.createSchema
      ? (params) => adapter.createSchema!(params)
      : undefined,
  };

  return wrapped;
}
