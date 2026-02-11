import { createDatafnClient, IndexedDbStorageAdapter } from "@datafn/client";
import type { DatafnSchema, DatafnPlugin } from "@datafn/core";

// ---------------------------------------------------------------------------
// Schema — two resources + a many-many relation
// ---------------------------------------------------------------------------

export const schema: DatafnSchema = {
  resources: [
    {
      name: "todos",
      version: 1,
      idPrefix: "todo",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        { name: "text", type: "string", required: true, minLength: 1, maxLength: 500 },
        { name: "completed", type: "boolean", required: true, default: false },
        { name: "priority", type: "number", required: false, min: 1, max: 5, default: 3 },
        { name: "createdAt", type: "date", required: true },
        { name: "updatedAt", type: "date", required: true },
      ],
      indices: {
        base: ["createdAt", "completed"],
      },
    },
    {
      name: "categories",
      version: 1,
      idPrefix: "cat",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        { name: "name", type: "string", required: true, minLength: 1, maxLength: 100 },
        { name: "color", type: "string", required: true, default: "#646cff" },
        { name: "createdAt", type: "date", required: true },
      ],
      indices: {
        base: ["name"],
      },
    },
  ],
  relations: [
    {
      from: "todos",
      to: "categories",
      type: "many-many",
      relation: "tags",
      inverse: "todos",
    },
  ],
};

// ---------------------------------------------------------------------------
// Audit-log plugin — demonstrates the plugin system
// ---------------------------------------------------------------------------

export type AuditEntry = {
  timestamp: number;
  env: string;
  phase: string;
  detail: string;
};

/** Shared mutable log so the UI can display recent events. */
export const auditLog: AuditEntry[] = [];
const MAX_LOG = 50;

function pushAudit(entry: AuditEntry) {
  auditLog.unshift(entry);
  if (auditLog.length > MAX_LOG) auditLog.length = MAX_LOG;
}

const auditPlugin: DatafnPlugin = {
  name: "audit-log",
  runsOn: ["client"],

  afterMutation(_ctx, mutation, result) {
    const m = Array.isArray(mutation) ? mutation : [mutation];
    for (const mut of m) {
      const op = (mut as any).operation ?? "unknown";
      const resource = (mut as any).resource ?? "?";
      pushAudit({
        timestamp: Date.now(),
        env: "client",
        phase: "mutation",
        detail: `${op} on ${resource} → ${(result as any)?.ok ? "ok" : "err"}`,
      });
    }
  },

  afterSync(_ctx, phase, _payload, result) {
    pushAudit({
      timestamp: Date.now(),
      env: "client",
      phase: `sync:${phase}`,
      detail: `${(result as any)?.ok ? "ok" : "err"}`,
    });
  },
};

// ---------------------------------------------------------------------------
// Client factory — creates a client for a given mode
// ---------------------------------------------------------------------------

export type AppMode = "sync" | "local-only";

/**
 * Creates a fully configured DataFn client.
 *
 * Demonstrates:
 *  - Schema with two resources + many-many relation
 *  - IndexedDB offline storage
 *  - Plugin system (audit logger)
 *  - Sync vs local-only mode toggle
 *  - KV workflow (available via client.kv)
 *  - Signals (available via table.signal / client.kv.signal)
 */
export function makeClient(mode: AppMode = "sync") {
  return createDatafnClient({
    schema,
    clientId: getOrCreateClientId(),
    storage: new IndexedDbStorageAdapter("todo-app-db"),
    plugins: [auditPlugin],
    sync:
      mode === "local-only"
        ? { mode: "local-only" }
        : {
            mode: "sync",
            offlinability: true,
            remote: "http://localhost:3000/datafn",
            ws: false,
            pushInterval: 2000,
            pushBatchSize: 100,
            pushMaxRetries: 3,
            hydration: {
              bootResources: ["todos", "categories"],
            },
          },
  });
}

/** Persist a stable clientId in localStorage. */
function getOrCreateClientId(): string {
  const KEY = "datafn-todo-client-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = "client-" + crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Default client instance (sync mode)
// ---------------------------------------------------------------------------

export let client = makeClient("sync");

/**
 * Recreate the client with a different mode.
 * Returns the new client so the UI can re-bind.
 */
export function switchMode(mode: AppMode) {
  client = makeClient(mode);
  return client;
}
