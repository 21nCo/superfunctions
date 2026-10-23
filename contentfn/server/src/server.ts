/**
 * Create ContentFn server: programmatic API + HTTP handler.
 */

import { wrapWithSchema, type Adapter } from "@superfunctions/db";
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
import { createRouter } from "./http/router.js";
import { RealtimeServer, type AuthorizeFn } from "./realtime/server.js";
import type { ContentfnEvent } from "./storage/events.js";
import { resolveLimits, type ContentfnLimits } from "./limits/limits.js";
import { createLogger, type ContentfnLogSink } from "./logging/logger.js";
import { getContentfnSchema } from "./storage/schema.js";

export interface ContentfnServerConfig {
  db: Adapter;
  storage?: import("./storage/storageBackend.js").AssetStorageBackend;
  maxPayloadBytes?: number;
  authorize?: AuthorizeFn;
  limits?: Partial<ContentfnLimits>;
  logSink?: ContentfnLogSink;
}

export interface ContentfnServer {
  /** Programmatic API (datasets + schema + docs). */
  api: {
    datasets: {
      create: (input: { dataset: string }) => ReturnType<typeof datasetCreate>;
      list: (input?: {}) => ReturnType<typeof datasetList>;
      delete: (input: { dataset: string }) => ReturnType<typeof datasetDelete>;
      export: (input: { dataset: string }) => ReturnType<typeof exportDataset>;
      import: (input: { dataset: string; artifact: unknown }) => ReturnType<typeof importDataset>;
    };
    schema: {
      upsert: (input: { dataset: string; schema: import("@contentfn/core").ContentfnSchema }) => ReturnType<typeof schemaUpsert>;
      get: (input: { dataset: string }) => ReturnType<typeof schemaGet>;
    };
    docs: {
      list: (input: import("@contentfn/core").CfqlQuery) => ReturnType<typeof executeCfql>;
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
  processWebhookQueue: () => ReturnType<typeof processWebhookQueue>;
  realtime: RealtimeServer;
  /** HTTP request handler (Node.js IncomingMessage / ServerResponse). */
  handler: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>;
}

export function createContentfnServer(config: ContentfnServerConfig): ContentfnServer {
  const limits = resolveLimits(config.limits);
  const logger = createLogger(config.logSink);
  const db = wrapWithSchema(config.db, getContentfnSchema());

  const storage = {
    db,
    storage: config.storage,
    maxPayloadBytes: config.maxPayloadBytes ?? limits.maxPayloadBytes,
  };

  const routerConfig = {
    ...storage,
    authorize: config.authorize,
    limits,
    logger,
  };

  const realtimeServer = new RealtimeServer({ authorize: config.authorize });

  async function getLatestEvent(
    dataset: string,
    type: string,
    docId: string
  ): Promise<ContentfnEvent | null> {
    const events = await db.findMany({
      model: "contentfn_events",
      where: [
        { field: "dataset", operator: "eq" as const, value: dataset },
        { field: "type", operator: "eq" as const, value: type },
        { field: "docId", operator: "eq" as const, value: docId },
      ],
      orderBy: [{ field: "timestamp", direction: "desc" }],
    });
    return events.length > 0 ? (events[0] as ContentfnEvent) : null;
  }

  async function publishWithWebhooks(input: {
    dataset: string;
    id: string;
    ifRev?: string;
  }) {
    const result = await docPublish(storage, input);
    if (result.ok) {
      const event = await getLatestEvent(input.dataset, "doc.published", result.result._id);
      if (event) {
        await enqueueForEvent({ db }, event);
        realtimeServer.broadcast(event);
      }
    }
    return result;
  }

  async function unpublishWithWebhooks(input: {
    dataset: string;
    id: string;
    ifRev?: string;
  }) {
    const result = await docUnpublish(storage, input);
    if (result.ok) {
      const publishedId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;
      const event = await getLatestEvent(input.dataset, "doc.unpublished", publishedId);
      if (event) {
        await enqueueForEvent({ db }, event);
        realtimeServer.broadcast(event);
      }
    }
    return result;
  }

  return {
    api: {
      datasets: {
        create: (input) => datasetCreate(storage, input),
        list: (input = {}) => datasetList(storage, input),
        delete: (input) => datasetDelete(storage, input),
        export: (input) => exportDataset(storage, input),
        import: (input) => importDataset(storage, input),
      },
      schema: {
        upsert: (input) => schemaUpsert(storage, input),
        get: (input) => schemaGet(storage, input),
      },
      docs: {
        list: (input) => executeCfql({
          db,
          maxQueryLimit: limits.maxQueryLimit,
          maxExpandDepth: limits.maxExpandDepth,
          maxFilterDepth: limits.maxFilterDepth,
        }, input),
        create: (input) => docCreate(storage, input),
        get: (input) => docGet(storage, input),
        delete: (input) => docDelete(storage, input),
        patch: (input) => {
          if (input.ops.length > limits.maxPatchOps) {
            return Promise.resolve({
              ok: false as const,
              error: {
                code: "VALIDATION_FAILED" as const,
                message: `Patch ops count ${input.ops.length} exceeds limit ${limits.maxPatchOps}`,
                details: { count: input.ops.length, limit: limits.maxPatchOps },
              },
            });
          }
          return docPatch(storage, input);
        },
        publish: (input) => publishWithWebhooks(input),
        unpublish: (input) => unpublishWithWebhooks(input),
        history: (input) => listHistory(storage, input),
        restore: (input) => restoreRevision(storage, input),
      },
      assets: {
        upload: (input) => assetUpload(storage, input),
        get: (input) => assetGet(storage, input),
      },
      webhooks: {
        register: (input) => webhookRegister(storage, input),
        list: (input) => webhookList(storage, input),
        delete: (input) => webhookDelete(storage, input),
      },
    },
    processWebhookQueue: () => processWebhookQueue({ db }),
    realtime: realtimeServer,
    handler: createRouter(routerConfig),
  };
}
