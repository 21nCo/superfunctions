import { queryWebhookAudit } from "./storage/webhookAudit.js";
import type { WebhookAuditQuery } from "@contentfn/core";
import { appendAudit, type AuditQuery, type queryAudit } from "./storage/audit.js";
import { atomicMutation } from "./storage/database.js";
import { randomUUID } from "node:crypto";
import { validateOptionalInput } from "./http/validateInput.js";
import { webhookDeliveries } from "./storage/webhooks.js";
import { eventStream } from "./realtime/sse.js";
import { executeIdempotent } from "./storage/idempotency.js";
import { schedulePublish, cancelScheduledPublish, processScheduledPublishes } from "./storage/schedules.js";
/**
 * Create ContentFn server: programmatic API + HTTP handler.
 */

import { InMemoryStorageBackend } from "./storage/storageBackend.js";
import type { Adapter } from "@superfunctions/db";
import { wrapWithSchema } from "@superfunctions/db/schema";
import { datasetCreate, datasetList, datasetDelete } from "./storage/datasets.js";
import { schemaUpsert, schemaGet } from "./storage/schemaStorage.js";
import { docCreate, docGet, docDelete, docPatch } from "./storage/docs.js";
import { docPublish, docUnpublish } from "./storage/publish.js";
import { listHistory, restoreRevision } from "./storage/revisions.js";
import { assetUpload, assetGet } from "./storage/assets.js";
import { webhookRegister, webhookList, webhookDelete } from "./storage/webhooks.js";
import { enqueueForEvent, processWebhookQueue } from "./webhooks/deliver.js";
import { exportDataset } from "./importExport/exportDataset.js";
import { importDataset } from "./importExport/importDataset.js";
import { executeCfql } from "./query/executeCfql.js";
import { createContentRouter, endpointHandlers, handleStatus } from "./http/router.js";
import { nodeHandler } from "./http/node-handler.js";
import { checkAuthorize } from "./auth/authorize.js";
import { err, type ContentfnEnvelope } from "@contentfn/core";
import { RealtimeServer, type AuthorizeFn } from "./realtime/server.js";
import type { ContentfnEvent } from "./storage/events.js";
import { resolveLimits, type ContentfnLimits } from "./limits/limits.js";
import { createLogger, type ContentfnLogSink } from "./logging/logger.js";
import { getContentfnSchema } from "./storage/schema.js";

export interface ContentfnServerConfig {
  db: Adapter;
  /** Host attests all legacy writers are stopped and schema4 DDL is installed. Not a distributed fence. */
  webhookAuditWriterSchemaVersion?: 4;
  /** Use native for database drivers that encode/decode JSON columns (PostgreSQL/MySQL). */
  jsonStorage?: "native" | "json-text";
  storage?: import("./storage/storageBackend.js").AssetStorageBackend;
  maxPayloadBytes?: number;
  authorize?: AuthorizeFn;
  context?: (request: Request) => unknown | Promise<unknown>;
  limits?: Partial<ContentfnLimits>;
  logSink?: ContentfnLogSink;
  search?: { enabled: boolean };
  webhooks?: { maxAttempts?: number; timeoutMs?: number };
}

export interface ContentfnServer {
  /** Programmatic API (datasets + schema + docs). */
  api: {
    audit: { webhooks: (input: WebhookAuditQuery) => ReturnType<typeof queryWebhookAudit>; query: (input: AuditQuery) => ReturnType<typeof queryAudit> };
    datasets: {
      create: (input: { dataset: string }) => ReturnType<typeof datasetCreate>;
      list: (input?: {}) => ReturnType<typeof datasetList>;
      delete: (input: { dataset: string }) => ReturnType<typeof datasetDelete>;
      export: (input: { dataset: string }) => ReturnType<typeof exportDataset>;
      import: (input: { dataset: string; artifact: unknown }) => ReturnType<typeof importDataset>;
    };
    schema: {
      upsert: (input: { dataset: string; schema: import("@contentfn/core").ContentfnSchema; migration?: { description: string } }) => ReturnType<typeof schemaUpsert>;
      get: (input: { dataset: string }) => ReturnType<typeof schemaGet>;
    };
    docs: {
      schedule: (input: { dataset: string; id: string; publishAt: string; ifRev?: string }) => ReturnType<typeof schedulePublish>;
      cancelSchedule: (input: { dataset: string; id: string }) => ReturnType<typeof cancelScheduledPublish>;
      list: (input: import("@contentfn/core").CfqlQuery) => ReturnType<typeof executeCfql>;
      query: (input: import("@contentfn/core").CfqlQuery) => ReturnType<typeof executeCfql>;
      create: (input: {
        dataset: string;
        id?: string;
        type: string;
        doc: Record<string, unknown>;
        asDraft?: boolean;
      }) => ReturnType<typeof docCreate>;
      get: (input: {
        dataset: string;
        id: string;
        perspective?: "published" | "draft" | "raw";
      }) => ReturnType<typeof docGet>;
      delete: (input: { dataset: string; id: string; purge?: boolean }) => ReturnType<typeof docDelete>;
      patch: (input: {
        dataset: string;
        id: string;
        ifRev?: string;
        ops: import("@contentfn/core").ContentfnPatchOp[];
      }) => ReturnType<typeof docPatch>;
      publish: (input: {
        dataset: string;
        id: string;
        ifRev?: string;
      }) => ReturnType<typeof docPublish>;
      unpublish: (input: {
        dataset: string;
        id: string;
        ifRev?: string;
      }) => ReturnType<typeof docUnpublish>;
      history: (input: {
        dataset: string;
        id: string;
        limit?: number;
        cursor?: string | null;
      }) => ReturnType<typeof listHistory>;
      restore: (input: {
        dataset: string;
        id: string;
        rev: string;
      }) => ReturnType<typeof restoreRevision>;
    };
    assets: {
      upload: (input: {
        dataset: string;
        filename: string;
        contentType: string;
        bytesBase64: string;
      }) => ReturnType<typeof assetUpload>;
      get: (input: {
        dataset: string;
        assetId: string;
      }) => ReturnType<typeof assetGet>;
    };
    webhooks: {
      deliveries: (input: { dataset: string; webhookId: string }) => ReturnType<typeof webhookDeliveries>;
      register: (input: {
        dataset: string;
        url: string;
        events: string[];
        secret?: string;
      }) => ReturnType<typeof webhookRegister>;
      list: (input: { dataset: string }) => ReturnType<typeof webhookList>;
      delete: (input: {
        dataset: string;
        webhookId: string;
      }) => ReturnType<typeof webhookDelete>;
    };
  };
  processScheduledPublishes: () => ReturnType<typeof processScheduledPublishes>;
  router: import("@superfunctions/http").Router;
  forContext: (context: unknown) => ContentfnServer["api"];
  processWebhookQueue: () => ReturnType<typeof processWebhookQueue>;
  realtime: RealtimeServer;
  /** HTTP request handler (Node.js IncomingMessage / ServerResponse). */
  handler: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>;
}

export function createContentfnServer(config: ContentfnServerConfig): ContentfnServer {
  const limits = resolveLimits(config.limits);
  const logger = createLogger(config.logSink);
  const db = wrapWithSchema(config.db, getContentfnSchema({ jsonStorage: config.jsonStorage }));

  const storage = {
    db,
    storage: config.storage ?? new InMemoryStorageBackend(),
    maxPayloadBytes: config.maxPayloadBytes ?? limits.maxPayloadBytes,
  };

  const routerConfig = {
    ...storage,
    webhookAuditWriterSchemaVersion: config.webhookAuditWriterSchemaVersion,
    authorize: config.authorize,
    limits,
    logger,
    ...limits,
    maxPayloadBytes: storage.maxPayloadBytes,
    search: config.search,
  };

  for (const [name, value] of Object.entries(config.webhooks ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`webhooks.${name} must be a positive safe integer`);
  }

  const realtimeServer = new RealtimeServer({ authorize: config.authorize });

  async function invoke(action: string, input: unknown, context?: unknown, idempotencyKey?: string): Promise<ContentfnEnvelope<unknown>> {
    try {
      if (input === null || typeof input !== "object" || Array.isArray(input)) return err("VALIDATION_FAILED", "Input must be an object", { path: "body" });
      const record = input as Record<string, unknown>;
      const invalidInput = validateOptionalInput(action, record);
      if (invalidInput) return invalidInput;
      const denied = await checkAuthorize(config.authorize, context, action, record);
      if (denied) return denied;
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > limits.maxPayloadBytes) return err("PAYLOAD_TOO_LARGE", "Input exceeds configured byte limit", {});
      if (action === "status") return handleStatus({ limits });
      if (action === "docs.patch" && Array.isArray(record.ops) && record.ops.length > limits.maxPatchOps) return err("VALIDATION_FAILED", "Patch operation limit exceeded", { path: "ops" });
      const endpoint = Object.values(endpointHandlers).find(endpoint => endpoint.action === action);
      if (!endpoint) return err("VALIDATION_FAILED", "Unknown operation", {});
      const subject = typeof context === "object" && context !== null && "subject" in context && typeof context.subject === "string" ? context.subject : undefined;
      const call = async (database: import("./storage/database.js").ContentfnDatabase): Promise<ContentfnEnvelope<unknown>> => {
        const response = await endpoint.handle({ ...routerConfig, db: database, actor: subject ? { subject } : undefined }, input);
        if (mutating && response.ok) await appendAudit(database, action, record, response.result, subject);
        return response;
      };
      let replayed = false;
      const mutating = /\.(create|delete|import|upsert|patch|publish|unpublish|restore|upload|register|schedule|cancelSchedule)$/.test(action);
      const result = idempotencyKey !== undefined && mutating ? await executeIdempotent(db, idempotencyKey, action, record, call, () => { replayed = true; }) : mutating ? await atomicMutation(db, call) : await call(db);
      if (result.ok && !replayed) {
        try {
        if (action === "datasets.delete") realtimeServer.broadcast({ eventId: randomUUID(), dataset: String(record.dataset), type: "dataset.deleted", timestamp: new Date().toISOString() });
        if (/^(docs\.(create|patch|delete|publish|unpublish|restore)|schema\.upsert)$/.test(action)) {
          logger.logMutation({ action, dataset: record.dataset as string, docId: record.id as string, actor: subject });
          const document = result.result as Record<string, unknown>;
          if (action.startsWith("docs.")) {
            const rows = await db.findMany({ model: "contentfn_events", where: [
              { field: "dataset", operator: "eq", value: record.dataset },
              { field: "type", operator: "eq", value: ({ "docs.create": "doc.created", "docs.patch": "doc.updated", "docs.restore": "doc.updated", "docs.publish": "doc.published", "docs.unpublish": "doc.unpublished", "docs.delete": "doc.deleted" } as Record<string, string>)[action] },
              ...(typeof document?._rev === "string" ? [{ field: "rev", operator: "eq" as const, value: document._rev }] : [{ field: "docId", operator: "eq" as const, value: String(record.id).replace(/^drafts\./, "") }]),
            ], orderBy: [{ field: "timestamp", direction: "desc" }] });
            if (rows[0]) realtimeServer.broadcast(rows[0] as unknown as ContentfnEvent);
          }
        }
        if (action === "assets.upload") logger.logAssetUpload({ dataset: record.dataset as string, size: Buffer.from(record.bytesBase64 as string, "base64").length, contentType: record.contentType as string });
        } catch { /* Delivery callbacks cannot turn a committed mutation into a failure. */ }
      }
      return result;
    } catch {
      return err("STORAGE_ERROR", "Content operation could not be completed", {});
    }
  }
  function forContext(context?: unknown): ContentfnServer["api"] {
    const api: Record<string, Record<string, (input?: unknown) => Promise<ContentfnEnvelope<unknown>>>> = {};
    for (const endpoint of Object.values(endpointHandlers)) {
      const [namespace, method] = endpoint.action === "query" ? ["docs", "query"] : endpoint.action.split(".");
      (api[namespace] ??= {})[method] = (input = {}) => invoke(endpoint.action, input, context);
    }
    api.docs.list = api.docs.query;
    return api as unknown as ContentfnServer["api"];
  }
  const router = createContentRouter(routerConfig, async (action, input, request) => invoke(action, input, config.context && request instanceof Request ? await config.context(request) : request, request instanceof Request ? request.headers.get("Idempotency-Key") ?? undefined : undefined), request => eventStream(request, { realtime: realtimeServer, authorize: config.authorize, context: config.context, logger, query: (query, context) => invoke("query", query, context) }));
  return {
    api: forContext(), forContext, router,
    processScheduledPublishes: () => processScheduledPublishes({ db, onPublished: async (dataset, document) => {
      const rows = await db.findMany({ model: "contentfn_events", where: [
        { field: "dataset", operator: "eq", value: dataset },
        { field: "type", operator: "eq", value: "doc.published" },
        { field: "rev", operator: "eq", value: document._rev },
      ] });
      for (const event of rows) realtimeServer.broadcast(event as unknown as ContentfnEvent);
      logger.logMutation({ action: "docs.publish", dataset, docId: String(document._id) });
    } }),
    processWebhookQueue: () => processWebhookQueue({ db, logger, ...config.webhooks }),
    realtime: realtimeServer,
    handler: nodeHandler(router),
  };
}
