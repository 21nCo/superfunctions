import type { IncomingMessage, ServerResponse } from "http";
import { handleDatasetsCreate, handleDatasetsList, handleDatasetsDelete } from "./endpoints/datasets.js";
import { handleSchemaUpsert, handleSchemaGet } from "./endpoints/schema.js";
import { handleDocsCreate, handleDocsGet, handleDocsDelete, handleDocsPatch } from "./endpoints/docs.js";
import { handleDocsPublish, handleDocsUnpublish } from "./endpoints/publish.js";
import { handleDocsHistory, handleDocsRestore } from "./endpoints/history.js";
import { handleQuery } from "./endpoints/query.js";
import { handleAssetsUpload, handleAssetsGet, handleAssetsList } from "./endpoints/assets.js";
import { handleWebhooksRegister, handleWebhooksList, handleWebhooksDelete } from "./endpoints/webhooks.js";
import { handleDatasetsExport, handleDatasetsImport } from "./endpoints/importExport.js";
import { handleStatus } from "./endpoints/status.js";
import type { DatasetsEndpointsConfig } from "./endpoints/datasets.js";
import type { SchemaEndpointsConfig } from "./endpoints/schema.js";
import type { DocsEndpointsConfig } from "./endpoints/docs.js";
import type { PublishEndpointsConfig } from "./endpoints/publish.js";
import type { HistoryEndpointsConfig } from "./endpoints/history.js";
import type { QueryEndpointsConfig } from "./endpoints/query.js";
import type { AssetsEndpointsConfig } from "./endpoints/assets.js";
import type { WebhooksEndpointsConfig } from "./endpoints/webhooks.js";
import type { ImportExportEndpointsConfig } from "./endpoints/importExport.js";
import { checkAuthorize, ACTIONS, type AuthorizeFn } from "../auth/authorize.js";
import type { ContentfnLimits } from "../limits/limits.js";
import type { ContentfnLogger } from "../logging/logger.js";

export interface RouterConfig extends DatasetsEndpointsConfig, SchemaEndpointsConfig, DocsEndpointsConfig, PublishEndpointsConfig, HistoryEndpointsConfig, QueryEndpointsConfig, AssetsEndpointsConfig, WebhooksEndpointsConfig, ImportExportEndpointsConfig {
  authorize?: AuthorizeFn;
  limits: ContentfnLimits;
  logger: ContentfnLogger;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBodyRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const PATH_TO_ACTION: Record<string, string> = {
  "/contentfn/datasets/create": ACTIONS.DATASETS_CREATE,
  "/contentfn/datasets/list": ACTIONS.DATASETS_LIST,
  "/contentfn/datasets/delete": ACTIONS.DATASETS_DELETE,
  "/contentfn/datasets/export": ACTIONS.DATASETS_EXPORT,
  "/contentfn/datasets/import": ACTIONS.DATASETS_IMPORT,
  "/contentfn/schema/upsert": ACTIONS.SCHEMA_UPSERT,
  "/contentfn/schema/get": ACTIONS.SCHEMA_GET,
  "/contentfn/docs/create": ACTIONS.DOCS_CREATE,
  "/contentfn/docs/get": ACTIONS.DOCS_GET,
  "/contentfn/docs/delete": ACTIONS.DOCS_DELETE,
  "/contentfn/docs/patch": ACTIONS.DOCS_PATCH,
  "/contentfn/docs/publish": ACTIONS.DOCS_PUBLISH,
  "/contentfn/docs/unpublish": ACTIONS.DOCS_UNPUBLISH,
  "/contentfn/docs/history": ACTIONS.DOCS_HISTORY,
  "/contentfn/docs/restore": ACTIONS.DOCS_RESTORE,
  "/contentfn/query": ACTIONS.QUERY,
  "/contentfn/assets/upload": ACTIONS.ASSETS_UPLOAD,
  "/contentfn/assets/get": ACTIONS.ASSETS_GET,
  "/contentfn/assets/list": ACTIONS.ASSETS_LIST,
  "/contentfn/webhooks/register": ACTIONS.WEBHOOKS_REGISTER,
  "/contentfn/webhooks/list": ACTIONS.WEBHOOKS_LIST,
  "/contentfn/webhooks/delete": ACTIONS.WEBHOOKS_DELETE,
};

export function createRouter(config: RouterConfig) {
  return async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "";
    const path = req.url?.split("?")[0] ?? "";

    if (path === "/contentfn/status" && (method === "GET" || method === "POST")) {
      const denied = await checkAuthorize(config.authorize, undefined, ACTIONS.STATUS, {});
      if (denied) {
        sendJson(res, 200, denied);
        return;
      }
      const envelope = handleStatus({ limits: config.limits });
      sendJson(res, 200, envelope);
      return;
    }

    if (method !== "POST") {
      sendJson(res, 405, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Method not allowed",
          details: {},
        },
      });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBodyRaw(req);
    } catch {
      sendJson(res, 400, {
        ok: false,
        error: { code: "VALIDATION_FAILED", message: "Failed to read body", details: {} },
      });
      return;
    }

    if (rawBody.length > config.limits.maxPayloadBytes) {
      sendJson(res, 200, {
        ok: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `Request body size ${rawBody.length} exceeds limit ${config.limits.maxPayloadBytes}`,
          details: { size: rawBody.length, limit: config.limits.maxPayloadBytes },
        },
      });
      return;
    }

    let body: unknown;
    try {
      body = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch {
      sendJson(res, 400, {
        ok: false,
        error: { code: "VALIDATION_FAILED", message: "Invalid JSON body", details: {} },
      });
      return;
    }

    const action = PATH_TO_ACTION[path];
    if (action) {
      const denied = await checkAuthorize(
        config.authorize,
        undefined,
        action,
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
      );
      if (denied) {
        sendJson(res, 200, denied);
        return;
      }
    }

    try {
      if (path === "/contentfn/datasets/create") {
        const envelope = await handleDatasetsCreate(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/datasets/list") {
        const envelope = await handleDatasetsList(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/datasets/delete") {
        const envelope = await handleDatasetsDelete(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/schema/upsert") {
        const envelope = await handleSchemaUpsert(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/schema/get") {
        const envelope = await handleSchemaGet(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/create") {
        config.logger.logMutation({ action: "docs.create", dataset: (body as any)?.dataset, docId: (body as any)?.id });
        const envelope = await handleDocsCreate(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/get") {
        const envelope = await handleDocsGet(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/delete") {
        config.logger.logMutation({ action: "docs.delete", dataset: (body as any)?.dataset, docId: (body as any)?.id });
        const envelope = await handleDocsDelete(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/patch") {
        const b = body as Record<string, unknown>;
        if (Array.isArray(b.ops) && b.ops.length > config.limits.maxPatchOps) {
          sendJson(res, 200, {
            ok: false,
            error: {
              code: "VALIDATION_FAILED",
              message: `Patch ops count ${b.ops.length} exceeds limit ${config.limits.maxPatchOps}`,
              details: { count: b.ops.length, limit: config.limits.maxPatchOps },
            },
          });
          return;
        }
        config.logger.logMutation({ action: "docs.patch", dataset: b.dataset as string, docId: b.id as string });
        const envelope = await handleDocsPatch(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/publish") {
        config.logger.logMutation({ action: "docs.publish", dataset: (body as any)?.dataset, docId: (body as any)?.id });
        const envelope = await handleDocsPublish(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/unpublish") {
        config.logger.logMutation({ action: "docs.unpublish", dataset: (body as any)?.dataset, docId: (body as any)?.id });
        const envelope = await handleDocsUnpublish(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/history") {
        const envelope = await handleDocsHistory(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/docs/restore") {
        const envelope = await handleDocsRestore(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/query") {
        const envelope = await handleQuery(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/assets/upload") {
        const b = body as Record<string, unknown>;
        config.logger.logAssetUpload({
          dataset: b.dataset as string,
          size: typeof b.bytesBase64 === "string" ? b.bytesBase64.length : 0,
          contentType: b.contentType as string,
        });
        const envelope = await handleAssetsUpload(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/assets/get") {
        const envelope = await handleAssetsGet(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/assets/list") {
        const envelope = await handleAssetsList(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/webhooks/register") {
        const envelope = await handleWebhooksRegister(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/webhooks/list") {
        const envelope = await handleWebhooksList(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/webhooks/delete") {
        const envelope = await handleWebhooksDelete(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/datasets/export") {
        const envelope = await handleDatasetsExport(config, body);
        sendJson(res, 200, envelope);
        return;
      }
      if (path === "/contentfn/datasets/import") {
        const envelope = await handleDatasetsImport(config, body);
        sendJson(res, 200, envelope);
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Not found",
          details: {},
        },
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Internal error",
          details: {},
        },
      });
    }
  };
}
