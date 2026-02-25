import { createDatafnClient, IndexedDbStorageAdapter } from "@datafn/client";
import type { DatafnPlugin } from "@datafn/core";

// ---------------------------------------------------------------------------
// Schema — two resources + a many-many relation
// ---------------------------------------------------------------------------

export const schema = {
  resources: [
    {
      name: "todos",
      version: 1,
      idPrefix: "todo",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        {
          name: "text",
          type: "string",
          required: true,
          minLength: 1,
          maxLength: 500,
        },
        { name: "completed", type: "boolean", required: true, default: false },
        {
          name: "priority",
          type: "number",
          required: false,
          min: 1,
          max: 5,
          default: 3,
        },
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
        {
          name: "name",
          type: "string",
          required: true,
          minLength: 1,
          maxLength: 100,
        },
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
// Mode type
// ---------------------------------------------------------------------------

export type AppMode = "sync" | "local-only";

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

function makeSyncConfig(mode: AppMode) {
  if (mode === "local-only") {
    return { mode: "local-only" as const };
  }
  return {
    mode: "sync" as const,
    offlinability: true,
    remote: "http://localhost:3001/datafn",
    ws: false,
    pushInterval: 2000,
    pushBatchSize: 100,
    pushMaxRetries: 3,
    hydration: {
      bootResources: ["todos", "categories"],
    },
  };
}

// ---------------------------------------------------------------------------
// Unified client — stable Proxy reference with built-in mode switching
// ---------------------------------------------------------------------------

export const client = createDatafnClient({
  schema,
  clientId: getOrCreateClientId(),
  storage: IndexedDbStorageAdapter.create({ dbName: "todo-app-db", schema }),
  plugins: [auditPlugin],
  sync: makeSyncConfig("sync"),
});

/**
 * Switch the client between sync and local-only mode.
 * Creates a fresh storage adapter on each switch (same IndexedDB name, new connection).
 * Sync is auto-started by switchContext when switching to "sync" mode.
 */
export async function switchMode(mode: AppMode): Promise<void> {
  console.log("[DEBUG] switchMode called with mode:", mode);
  await client.switchContext({
    sync: makeSyncConfig(mode),
    storage: IndexedDbStorageAdapter.create({ dbName: "todo-app-db", schema }),
  });
}
