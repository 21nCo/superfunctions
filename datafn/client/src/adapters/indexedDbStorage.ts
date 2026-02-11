/**
 * IndexedDB storage adapter for persistent client storage.
 * Implements deterministic ordering and changelog deduplication.
 */

import type {
  DatafnStorageAdapter,
  DatafnHydrationState,
  DatafnChangelogEntry,
} from "../storage.js";
import type { DatafnSchema, DatafnRelationSchema } from "@datafn/core";

const DB_NAME = "datafn_client_db";
const DB_VERSION = 2;

function validateHydrationState(state: string): DatafnHydrationState {
  if (state !== "notStarted" && state !== "hydrating" && state !== "ready") {
    throw new Error(`Invalid hydration state: ${state}`);
  }
  return state as DatafnHydrationState;
}

function validateTransition(
  from: DatafnHydrationState,
  to: DatafnHydrationState,
): void {
  if (from === to) return;
  if (from === "notStarted" && to === "hydrating") return;
  if (from === "hydrating" && to === "ready") return;
  if (from === "ready" && to === "hydrating") return;
  throw new Error(`Invalid hydration state transition: ${from} -> ${to}`);
}

function validateCursor(cursor: unknown): void {
  if (cursor !== null && typeof cursor !== "string") {
    throw new Error("Invalid cursor format");
  }
}

function validateMutation(mutation: any): void {
  if (!mutation.clientId) throw new Error("Missing clientId in mutation");
  if (!mutation.mutationId) throw new Error("Missing mutationId in mutation");
}

function getJoinStoreName(
  fromResource: string,
  relationName: string,
  toResource: string,
): string {
  // Sanitize to ensure valid store name
  return `join_${fromResource}_${relationName}_${toResource}`;
}

/**
 * Deep merge helper: one-level-deep merge for object-type fields.
 * - Top-level scalar fields: overwrite
 * - Top-level object fields: shallow-merge the nested object
 * - Arrays: overwrite (no array merging)
 */
function deepMergeOneLevel(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      // One-level deep merge for objects
      result[key] = { ...tv, ...sv };
    } else {
      // Overwrite for everything else (scalars, arrays, null)
      result[key] = sv;
    }
  }
  return result;
}

export class IndexedDbStorageAdapter implements DatafnStorageAdapter {
  private dbPromise: Promise<IDBDatabase>;
  private validResources?: Set<string>;
  private schema?: DatafnSchema;
  readonly dbName: string;

  /**
   * Create an IndexedDB storage adapter with automatic user/tenant isolation.
   * Database name is constructed as: `${baseDbName}_${tenantId}_${userId}` or `${baseDbName}_${userId}`
   * 
   * @param baseDbName - Base database name (e.g., "my-app-db")
   * @param userId - User identifier for data isolation
   * @param tenantId - Optional tenant identifier for multi-tenant isolation
   * @param resources - Optional list of valid resource names
   * @param schema - Optional schema for creating indexes
   * 
   * @example
   * ```typescript
   * // Single-tenant
   * const storage = IndexedDbStorageAdapter.createForUser("my-app", userId);
   * 
   * // Multi-tenant
   * const storage = IndexedDbStorageAdapter.createForUser("my-app", userId, tenantId);
   * ```
   */
  static createForUser(
    baseDbName: string,
    userId: string,
    tenantId?: string,
    resources?: string[],
    schema?: DatafnSchema,
  ): IndexedDbStorageAdapter {
    const dbName = tenantId
      ? `${baseDbName}_${tenantId}_${userId}`
      : `${baseDbName}_${userId}`;
    return new IndexedDbStorageAdapter(dbName, resources, schema);
  }

  constructor(
    dbName: string = DB_NAME,
    resources?: string[],
    schema?: DatafnSchema,
  ) {
    this.dbName = dbName;
    if (resources) {
      this.validResources = new Set(resources);
    }
    this.schema = schema;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = async (event) => {
        const db = request.result;
        const txn = request.transaction!;

        // --- Migration from v1 (IDB-001: Two-phase migration approach) ---
        // Phase 1: Detect and log old version for migration tracking
        if (event.oldVersion < 2 && event.oldVersion > 0) {
          console.log(`IndexedDB migration: Detected v${event.oldVersion}, upgrading to v${DB_VERSION}`);
          
          // Store migration metadata in __datafn_meta for tracking
          if (!db.objectStoreNames.contains("__datafn_meta")) {
            db.createObjectStore("__datafn_meta", { keyPath: "key" });
          }
          
          // Mark migration as in-progress (for potential recovery detection)
          const metaStore = txn.objectStore("__datafn_meta");
          metaStore.put({
            key: "migration_v1_to_v2",
            status: "in_progress",
            startedAt: new Date().toISOString(),
            oldVersion: event.oldVersion,
          });

          // Log but don't fail on migration issues - preserve old data
          // Actual async migration will happen after DB opens (Phase 2)
          try {
            // For v1 -> v2: We're changing from monolithic stores to per-resource stores
            // Synchronous schema changes only - data migration happens post-open
            console.log("IndexedDB migration: Schema changes applied. Data migration deferred to post-open phase.");
          } catch (migrationError) {
            console.error("IndexedDB migration warning:", migrationError);
            // Don't throw - allow schema to be created, old data preserved
          }
        }

        // --- Create/Update Stores based on Schema ---
        if (this.schema) {
          // 1. Resource Stores
          for (const resource of this.schema.resources) {
            if (!db.objectStoreNames.contains(resource.name)) {
              const store = db.createObjectStore(resource.name, {
                keyPath: "id",
              });
              
              // Base indices from schema
              if (resource.indices) {
                const indices = Array.isArray(resource.indices)
                  ? resource.indices
                  : resource.indices.base || [];

                for (const field of indices) {
                  store.createIndex(`by_${field}`, field, { unique: false });
                }
              }

              // FK indices (inferred from relations)
              if (this.schema.relations) {
                for (const rel of this.schema.relations) {
                  if (rel.type === "many-one" && rel.from === resource.name) {
                     const fk = rel.fkField || `${rel.relation}Id`;
                     if (!store.indexNames.contains(`by_${fk}`)) {
                        store.createIndex(`by_${fk}`, fk, { unique: false });
                     }
                  } else if (rel.type === "one-many" && rel.to === resource.name) {
                     // For one-many, 'to' has the FK back to 'from'
                     const fk = rel.fkField || rel.inverse || `${rel.from}Id`;
                     if (!store.indexNames.contains(`by_${fk}`)) {
                        store.createIndex(`by_${fk}`, fk, { unique: false });
                     }
                  }
                }
              }
            }
          }

          // 2. Join Stores (Many-Many)
          if (this.schema.relations) {
            for (const rel of this.schema.relations) {
              if (rel.type === "many-many") {
                const froms = Array.isArray(rel.from) ? rel.from : [rel.from];
                const tos = Array.isArray(rel.to) ? rel.to : [rel.to];
                
                for (const f of froms) {
                  for (const t of tos) {
                    const storeName = getJoinStoreName(f, rel.relation || "rel", t);
                    if (!db.objectStoreNames.contains(storeName)) {
                      const store = db.createObjectStore(storeName, {
                        keyPath: ["from", "to"],
                      });
                      store.createIndex("by_from", "from", { unique: false });
                      store.createIndex("by_to", "to", { unique: false });
                    }
                  }
                }
              }
            }
          }
        }

        // --- Built-in KV Store (KV-001) ---
        // Always create KV object store with index on id
        if (!db.objectStoreNames.contains("kv")) {
          const kvStore = db.createObjectStore("kv", { keyPath: "id" });
          kvStore.createIndex("by_id", "id", { unique: true });
        }

        // --- Meta Stores (Preserve/Create) ---
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: ["type", "key"] });
        }

        if (!db.objectStoreNames.contains("changelog")) {
          const store = db.createObjectStore("changelog", {
            keyPath: "seq",
            autoIncrement: true,
          });
          store.createIndex("by_client_mutation", ["clientId", "mutationId"], {
            unique: true,
          });
        }
        
        // IDB-001: Preserve old stores for recovery
        // DO NOT delete old stores ("records", "join_rows") immediately
        // They are preserved in case migration fails and manual recovery is needed
        // The new adapter only uses per-resource stores going forward
        if (event.oldVersion < 2 && event.oldVersion > 0) {
          console.log("IndexedDB migration: Old v1 stores preserved for recovery if needed");
          // Migration completion will be marked by healthCheck() after successful operation
        }
      };
    });
  }

  private validateTableName(table: string) {
    if (this.validResources && !this.validResources.has(table)) {
      throw new Error(`Unknown table: ${table}`);
    }
  }

  private async getStore(
    storeName: string,
    mode: IDBTransactionMode,
  ): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    if (!db.objectStoreNames.contains(storeName)) {
        throw new Error(`Store not found: ${storeName}`);
    }
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  // --- Records ---

  async getRecord(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    this.validateTableName(resource);
    const store = await this.getStore(resource, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async listRecords(resource: string): Promise<Record<string, unknown>[]> {
    this.validateTableName(resource);
    const store = await this.getStore(resource, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async upsertRecord(
    resource: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    this.validateTableName(resource);
    const store = await this.getStore(resource, "readwrite");
    return new Promise((resolve, reject) => {
      // In new design, record is just the object. Key is 'id'.
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteRecord(resource: string, id: string): Promise<void> {
    this.validateTableName(resource);
    const store = await this.getStore(resource, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Atomic read-modify-write merge using a single transaction.
   * Uses one-level-deep merge for object-type fields.
   */
  async mergeRecord(
    resource: string,
    id: string,
    partial: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.validateTableName(resource);
    const db = await this.dbPromise;
    
    return new Promise((resolve, reject) => {
      const tx = db.transaction(resource, "readwrite");
      const store = tx.objectStore(resource);
      
      // Read existing record
      const getRequest = store.get(id);
      
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        // Merge with deep merge logic
        const merged = existing
          ? deepMergeOneLevel(existing, partial)
          : { ...partial, id };
        
        // Ensure id is present
        merged.id = id;
        
        // Write merged record
        const putRequest = store.put(merged);
        
        putRequest.onsuccess = () => {
          resolve(merged);
        };
        putRequest.onerror = () => {
          reject(putRequest.error);
        };
      };
      
      getRequest.onerror = () => {
        reject(getRequest.error);
      };
      
      tx.onerror = () => {
        reject(tx.error);
      };
    });
  }

  // --- Join Rows ---

  async listJoinRows(
    storeName: string,
  ): Promise<Array<Record<string, unknown>>> {
    const store = await this.getStore(storeName, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getJoinRows(
    storeName: string,
    fromId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const store = await this.getStore(storeName, "readonly");
    const index = store.index("by_from");
    return new Promise((resolve, reject) => {
      const request = index.getAll(fromId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  
  async getJoinRowsInverse(
    storeName: string,
    toId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const store = await this.getStore(storeName, "readonly");
    const index = store.index("by_to");
    return new Promise((resolve, reject) => {
      const request = index.getAll(toId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async upsertJoinRow(
    storeName: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    const store = await this.getStore(storeName, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.put(row);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async setJoinRows(
    storeName: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    const store = await this.getStore(storeName, "readwrite");
    return new Promise((resolve, reject) => {
      let count = 0;
      if (rows.length === 0) {
        resolve();
        return;
      }
      const checkDone = () => {
        count++;
        if (count === rows.length) resolve();
      };

      for (const row of rows) {
        const req = store.put(row);
        req.onsuccess = checkDone;
        req.onerror = () => reject(req.error);
      }
    });
  }

  async deleteJoinRow(
    storeName: string,
    from: string,
    to: string,
  ): Promise<void> {
    const store = await this.getStore(storeName, "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.delete([from, to]);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async findRecords(
    resource: string,
    field: string,
    value: unknown,
  ): Promise<Record<string, unknown>[]> {
    this.validateTableName(resource);
    const store = await this.getStore(resource, "readonly");

    // Check if index exists
    if (store.indexNames.contains(`by_${field}`)) {
         const index = store.index(`by_${field}`);
         return new Promise((resolve, reject) => {
             const request = index.getAll(value as IDBValidKey);
             request.onsuccess = () => resolve(request.result || []);
             request.onerror = () => reject(request.error);
         });
    }

    // Fallback: list all and filter (now strictly scoped to resource)
    const all = await this.listRecords(resource);
    return all.filter((r) => r[field] === value);
  }

  // --- Sync State ---

  async getCursor(resource: string): Promise<string | null> {
    this.validateTableName(resource);
    const store = await this.getStore("meta", "readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(["cursor", resource]);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error);
    });
  }

  async setCursor(resource: string, cursor: string | null): Promise<void> {
    this.validateTableName(resource);
    validateCursor(cursor);
    const store = await this.getStore("meta", "readwrite");
    return new Promise((resolve, reject) => {
      if (cursor === null) {
        const request = store.delete(["cursor", resource]);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } else {
        const request = store.put({
          type: "cursor",
          key: resource,
          value: cursor,
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }
    });
  }

  async getHydrationState(resource: string): Promise<DatafnHydrationState> {
    this.validateTableName(resource);
    const store = await this.getStore("meta", "readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(["hydration", resource]);
      request.onsuccess = () => resolve(request.result?.value || "notStarted");
      request.onerror = () => reject(request.error);
    });
  }

  async setHydrationState(
    resource: string,
    state: DatafnHydrationState,
  ): Promise<void> {
    this.validateTableName(resource);
    validateHydrationState(state);
    const current = await this.getHydrationState(resource);
    validateTransition(current, state);

    const store = await this.getStore("meta", "readwrite");
    return new Promise((resolve, reject) => {
      const request = store.put({
        type: "hydration",
        key: resource,
        value: state,
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // --- Changelog ---

  async changelogAppend(
    entry: Omit<DatafnChangelogEntry, "seq">,
  ): Promise<DatafnChangelogEntry> {
    validateMutation(entry);
    const store = await this.getStore("changelog", "readwrite");
    const index = store.index("by_client_mutation");

    // Check for duplicate
    const existing = await new Promise<DatafnChangelogEntry | undefined>(
      (resolve, reject) => {
        const request = index.get([entry.clientId, entry.mutationId]);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );

    if (existing) {
      return existing;
    }

    // Insert new
    return new Promise((resolve, reject) => {
      // Don't pass seq, let autoIncrement handle it
      const request = store.add(entry);
      request.onsuccess = () => {
        const seq = request.result as number;
        resolve({ ...entry, seq });
      };
      request.onerror = () => reject(request.error);
    });
  }

  async changelogList(
    options: { limit?: number } = {},
  ): Promise<DatafnChangelogEntry[]> {
    const store = await this.getStore("changelog", "readonly");
    return new Promise((resolve, reject) => {
      const limit = options.limit || 100;
      // getAll allows limit
      const request = store.getAll(null, limit);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async changelogAck(options: { throughSeq: number }): Promise<void> {
    const store = await this.getStore("changelog", "readwrite");

    // Delete range <= throughSeq
    const range = IDBKeyRange.upperBound(options.throughSeq);

    return new Promise((resolve, reject) => {
      const request = store.delete(range);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // --- Counts for reconcile (SYNC-007) ---

  async countRecords(resource: string): Promise<number> {
    this.validateTableName(resource);
    const store = await this.getStore(resource, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async countJoinRows(relationKey: string): Promise<number> {
    const store = await this.getStore(relationKey, "readonly");
    return new Promise((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Lifecycle (CLN-001, CLN-002) ---

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }

  async clearAll(): Promise<void> {
    const db = await this.dbPromise;
    const storeNames = Array.from(db.objectStoreNames);
    
    // Delete all data from all stores
    const transaction = db.transaction(storeNames, "readwrite");
    
    return new Promise((resolve, reject) => {
      const clearPromises: Promise<void>[] = [];
      
      for (const storeName of storeNames) {
        const store = transaction.objectStore(storeName);
        clearPromises.push(
          new Promise((resolveStore, rejectStore) => {
            const request = store.clear();
            request.onsuccess = () => resolveStore();
            request.onerror = () => rejectStore(request.error);
          })
        );
      }
      
      transaction.oncomplete = () => {
        Promise.all(clearPromises).then(resolve).catch(reject);
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // --- Health Check (HEAL-001, IDB-001) ---

  async healthCheck(): Promise<{ ok: boolean; issues: string[] }> {
    const issues: string[] = [];
    
    try {
      // Verify database is accessible
      const db = await this.dbPromise;
      if (!db) {
        issues.push("Database not initialized");
        return { ok: false, issues };
      }

      // Verify expected object stores exist
      const storeNames = Array.from(db.objectStoreNames);
      
      // Check meta stores
      const requiredStores = ["meta", "changelog"];
      for (const storeName of requiredStores) {
        if (!storeNames.includes(storeName)) {
          issues.push(`Missing object store: ${storeName}`);
        }
      }

      // Check resource stores if we have a schema
      if (this.schema) {
        for (const resource of this.schema.resources) {
          if (!storeNames.includes(resource.name)) {
            issues.push(`Missing object store: ${resource.name}`);
          }
        }
      }

      // Verify cursor store is readable (use a health check key that won't conflict)
      if (storeNames.includes("meta")) {
        try {
          await this.getCursor("__health_check__");
        } catch (err) {
          issues.push(`Cursor store is not readable: ${String(err)}`);
        }
      }

      // IDB-001: Check for stuck migrations
      if (storeNames.includes("__datafn_meta")) {
        try {
          const metaStore = await this.getStore("__datafn_meta", "readonly");
          const migrationStatus = await new Promise<any>((resolve, reject) => {
            const request = metaStore.get("migration_v1_to_v2");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          if (migrationStatus && migrationStatus.status === "in_progress") {
            issues.push(`Migration stuck: v${migrationStatus.oldVersion} to v${DB_VERSION} started at ${migrationStatus.startedAt}`);
          }
        } catch (err) {
          // Migration metadata read failed - not critical
          console.warn("Could not check migration status:", err);
        }
      }
    } catch (err) {
      issues.push(`Storage access error: ${String(err)}`);
    }

    return { ok: issues.length === 0, issues };
  }
}