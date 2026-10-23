/**
 * ContentFn storage schema (adapter-agnostic).
 * Maps to PLAN.md tables; adapters (e.g. @superfunctions/db) implement DDL/CRUD.
 */

import type { TableSchemaMap } from "@superfunctions/db";

export const CONTENTFN_TABLE_NAMES = {
  datasets: "contentfn_datasets",
  schema: "contentfn_schema",
  docsPublished: "contentfn_docs_published",
  docsDrafts: "contentfn_docs_drafts",
  revisions: "contentfn_revisions",
  assets: "contentfn_assets",
  webhooks: "contentfn_webhooks",
  webhookQueue: "contentfn_webhook_queue",
  events: "contentfn_events",
  rtSessions: "contentfn_rt_sessions",
} as const;

/**
 * Column definitions per table (logical schema; adapter maps to DDL).
 */
export interface TableDef {
  name: string;
  columns: Record<string, ColumnDef>;
}

export interface ColumnDef {
  type: "string" | "number" | "json" | "datetime" | "boolean";
  nullable?: boolean;
  primaryKey?: boolean;
}

export const contentfnDatasets: TableDef = {
  name: CONTENTFN_TABLE_NAMES.datasets,
  columns: {
    id: { type: "string", nullable: false },
    name: { type: "string", primaryKey: true },
    createdAt: { type: "datetime", nullable: false },
    deletedAt: { type: "datetime", nullable: true },
  },
};

export const contentfnSchema: TableDef = {
  name: CONTENTFN_TABLE_NAMES.schema,
  columns: {
    id: { type: "string", nullable: false },
    dataset: { type: "string", primaryKey: true },
    version: { type: "number", nullable: false },
    schemaJson: { type: "json", nullable: false },
    schemaHash: { type: "string", nullable: false },
    updatedAt: { type: "datetime", nullable: false },
  },
};

export const contentfnDocsPublished: TableDef = {
  name: CONTENTFN_TABLE_NAMES.docsPublished,
  columns: {
    id: { type: "string", primaryKey: true },
    dataset: { type: "string", nullable: false },
    documentId: { type: "string", nullable: false },
    type: { type: "string", nullable: false },
    docJson: { type: "json", nullable: false },
    rev: { type: "string", nullable: false },
    createdAt: { type: "datetime", nullable: false },
    updatedAt: { type: "datetime", nullable: false },
    publishedAt: { type: "datetime", nullable: true },
  },
};

export const contentfnDocsDrafts: TableDef = {
  name: CONTENTFN_TABLE_NAMES.docsDrafts,
  columns: {
    id: { type: "string", primaryKey: true },
    dataset: { type: "string", nullable: false },
    documentId: { type: "string", nullable: false },
    type: { type: "string", nullable: false },
    docJson: { type: "json", nullable: false },
    rev: { type: "string", nullable: false },
    createdAt: { type: "datetime", nullable: false },
    updatedAt: { type: "datetime", nullable: false },
  },
};

export const contentfnRevisions: TableDef = {
  name: CONTENTFN_TABLE_NAMES.revisions,
  columns: {
    id: { type: "string", primaryKey: true },
    dataset: { type: "string", nullable: false },
    docId: { type: "string", nullable: false },
    perspective: { type: "string", nullable: false },
    rev: { type: "string", nullable: false },
    timestamp: { type: "datetime", nullable: false },
    docJson: { type: "json", nullable: false },
  },
};

export const contentfnAssets: TableDef = {
  name: CONTENTFN_TABLE_NAMES.assets,
  columns: {
    id: { type: "string", primaryKey: true },
    dataset: { type: "string", nullable: false },
    assetId: { type: "string", nullable: false },
    contentType: { type: "string", nullable: false },
    filename: { type: "string", nullable: false },
    size: { type: "number", nullable: false },
    width: { type: "number", nullable: true },
    height: { type: "number", nullable: true },
    url: { type: "string", nullable: false },
    createdAt: { type: "datetime", nullable: false },
  },
};

export const contentfnWebhooks: TableDef = {
  name: CONTENTFN_TABLE_NAMES.webhooks,
  columns: {
    id: { type: "string", primaryKey: true },
    webhookId: { type: "string", nullable: false },
    dataset: { type: "string", nullable: false },
    url: { type: "string", nullable: false },
    secret: { type: "string", nullable: true },
    events: { type: "json", nullable: false },
    createdAt: { type: "datetime", nullable: false },
  },
};

export const contentfnWebhookQueue: TableDef = {
  name: CONTENTFN_TABLE_NAMES.webhookQueue,
  columns: {
    id: { type: "string", primaryKey: true },
    eventId: { type: "string", nullable: false },
    webhookId: { type: "string", nullable: false },
    attempt: { type: "number", nullable: false },
    nextRunAt: { type: "datetime", nullable: false },
    status: { type: "string", nullable: false },
    lastError: { type: "string", nullable: true },
    dataset: { type: "string", nullable: true },
    destinationUrl: { type: "string", nullable: true },
    updatedAt: { type: "datetime", nullable: true },
    timestampKnown: { type: "boolean", nullable: true },
    auditMetadataVersion: { type: "number", nullable: true },
  },
};

export const contentfnEvents: TableDef = {
  name: CONTENTFN_TABLE_NAMES.events,
  columns: {
    id: { type: "string", primaryKey: true },
    eventId: { type: "string", nullable: false },
    dataset: { type: "string", nullable: false },
    type: { type: "string", nullable: false },
    timestamp: { type: "datetime", nullable: false },
    actor: { type: "json", nullable: true },
    docId: { type: "string", nullable: true },
    rev: { type: "string", nullable: true },
    changedPaths: { type: "json", nullable: true },
  },
};

export const contentfnRtSessions: TableDef = {
  name: CONTENTFN_TABLE_NAMES.rtSessions,
  columns: {
    id: { type: "string", primaryKey: true },
    connectionId: { type: "string", nullable: false },
    subject: { type: "string", nullable: true },
    datasetScopes: { type: "json", nullable: true },
  },
};

export const contentfnSchedules: TableDef = {
  name: "contentfn_schedules", columns: {
    id: { type: "string", primaryKey: true }, dataset: { type: "string", nullable: false },
    documentId: { type: "string", nullable: false }, publishAt: { type: "datetime", nullable: false },
    ifRev: { type: "string", nullable: false }, status: { type: "string", nullable: false }, lastError: { type: "string", nullable: true },
  },
};
export const contentfnIdempotency: TableDef = {
  name: "contentfn_idempotency", columns: {
    id: { type: "string", primaryKey: true }, dataset: { type: "string", nullable: false },
    requestHash: { type: "string", nullable: false }, responseJson: { type: "json", nullable: false }, createdAt: { type: "datetime", nullable: false },
  },
};
export const contentfnAudit: TableDef = {
  name: "contentfn_audit", columns: {
    id: { type: "string", primaryKey: true }, dataset: { type: "string", nullable: false },
    action: { type: "string", nullable: false }, actor: { type: "json", nullable: true },
    targetIds: { type: "json", nullable: false }, timestamp: { type: "datetime", nullable: false },
  },
};
export const ALL_TABLES: TableDef[] = [
  contentfnAudit,
  contentfnIdempotency,
  contentfnSchedules,
  contentfnDatasets,
  contentfnSchema,
  contentfnDocsPublished,
  contentfnDocsDrafts,
  contentfnRevisions,
  contentfnAssets,
  contentfnWebhooks,
  contentfnWebhookQueue,
  contentfnEvents,
  contentfnRtSessions,
];

/** Runtime schema used to normalize values before they reach an app-supplied adapter. */
export function getContentfnSchema(options: { jsonStorage?: "native" | "json-text" } = {}): TableSchemaMap {
  if (options.jsonStorage !== undefined && !["native", "json-text"].includes(options.jsonStorage)) throw new TypeError("jsonStorage must be native or json-text");
  return Object.fromEntries(
    ALL_TABLES.map((table) => [
      table.name,
      {
        modelName: table.name,
        fields: Object.fromEntries(
          Object.entries(table.columns).map(([name, column]) => [
            name,
            {
              type: column.type === "datetime" ? "datetime" : column.type,
              required: column.nullable !== true,
              ...(column.type === "json" ? { jsonStorageType: options.jsonStorage ?? "json-text" as const } : {}),
              ...(column.type === "datetime"
                ? { dateValueType: "iso-string" as const, dateStorageType: "iso-text" as const }
                : {}),
            },
          ])
        ),
      },
    ])
  );
}

/** Physical schema contract consumed by the shared Superfunctions schema CLI. */
export function getSchema(config: { jsonStorage?: "native" | "json-text" } = {}): { version: number; schemas: import("@superfunctions/db").TableSchema[] } {
  const runtime = getContentfnSchema(config);
  return {
    version: 4,
    schemas: ALL_TABLES.map(table => ({
      ...runtime[table.name],
      fields: Object.fromEntries(Object.entries(runtime[table.name].fields).map(([name, field]) => [name,
        field.type === "json" && field.jsonStorageType === "json-text" ? { type: "string" as const, required: field.required } : { ...field, ...(field.type === "string" && (table.columns[name].primaryKey || name === "id") ? { maxLength: 64 } : {}) },
      ])),
      indexes: [{ name: `${table.name}_identity`, fields: Object.entries(table.columns).filter(([, column]) => column.primaryKey).map(([name]) => name), unique: true }].filter(index => index.fields.length > 0),
    })),
  };
}
