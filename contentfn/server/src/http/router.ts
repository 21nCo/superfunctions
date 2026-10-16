import { webhookDeliveries } from "../storage/webhooks.js";
import { schedulePublish, cancelScheduledPublish } from "../storage/schedules.js";
import { createRouter as sharedRouter } from "@superfunctions/http/router";
import type { Router } from "@superfunctions/http";
import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";
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

export const endpointHandlers = {
  "/contentfn/webhooks/deliveries": { action: "webhooks.deliveries", handle: webhookDeliveries },
  "/contentfn/docs/schedule": { action: "docs.schedule", handle: schedulePublish },
  "/contentfn/docs/cancelSchedule": { action: "docs.cancelSchedule", handle: cancelScheduledPublish },
  "/contentfn/datasets/create": { action: ACTIONS.DATASETS_CREATE, handle: handleDatasetsCreate },
  "/contentfn/datasets/list": { action: ACTIONS.DATASETS_LIST, handle: handleDatasetsList },
  "/contentfn/datasets/delete": { action: ACTIONS.DATASETS_DELETE, handle: handleDatasetsDelete },
  "/contentfn/datasets/export": { action: ACTIONS.DATASETS_EXPORT, handle: handleDatasetsExport },
  "/contentfn/datasets/import": { action: ACTIONS.DATASETS_IMPORT, handle: handleDatasetsImport },
  "/contentfn/schema/upsert": { action: ACTIONS.SCHEMA_UPSERT, handle: handleSchemaUpsert },
  "/contentfn/schema/get": { action: ACTIONS.SCHEMA_GET, handle: handleSchemaGet },
  "/contentfn/docs/create": { action: ACTIONS.DOCS_CREATE, handle: handleDocsCreate },
  "/contentfn/docs/get": { action: ACTIONS.DOCS_GET, handle: handleDocsGet },
  "/contentfn/docs/delete": { action: ACTIONS.DOCS_DELETE, handle: handleDocsDelete },
  "/contentfn/docs/patch": { action: ACTIONS.DOCS_PATCH, handle: handleDocsPatch },
  "/contentfn/docs/publish": { action: ACTIONS.DOCS_PUBLISH, handle: handleDocsPublish },
  "/contentfn/docs/unpublish": { action: ACTIONS.DOCS_UNPUBLISH, handle: handleDocsUnpublish },
  "/contentfn/docs/history": { action: ACTIONS.DOCS_HISTORY, handle: handleDocsHistory },
  "/contentfn/docs/restore": { action: ACTIONS.DOCS_RESTORE, handle: handleDocsRestore },
  "/contentfn/query": { action: ACTIONS.QUERY, handle: handleQuery },
  "/contentfn/assets/upload": { action: ACTIONS.ASSETS_UPLOAD, handle: handleAssetsUpload },
  "/contentfn/assets/get": { action: ACTIONS.ASSETS_GET, handle: handleAssetsGet },
  "/contentfn/assets/list": { action: ACTIONS.ASSETS_LIST, handle: handleAssetsList },
  "/contentfn/webhooks/register": { action: ACTIONS.WEBHOOKS_REGISTER, handle: handleWebhooksRegister },
  "/contentfn/webhooks/list": { action: ACTIONS.WEBHOOKS_LIST, handle: handleWebhooksList },
  "/contentfn/webhooks/delete": { action: ACTIONS.WEBHOOKS_DELETE, handle: handleWebhooksDelete },
} as const;
export type ContentfnAction = typeof endpointHandlers[keyof typeof endpointHandlers]["action"] | "status";

export function createContentRouter(config: RouterConfig, invoke: (action: string, input: unknown, context?: unknown) => Promise<ContentfnEnvelope<unknown>>, streamEvents?: (request: Request) => Promise<Response>): Router {
  return sharedRouter({
    maxBodyBytes: config.limits.maxPayloadBytes,
    routes: [
      ...(streamEvents ? [{ method: "GET" as const, path: "/contentfn/events", handler: streamEvents }] : []),
      ...Object.entries(endpointHandlers).map(([path, endpoint]) => ({
        method: "POST" as const, path,
        handler: async (request: Request, context: { json: () => Promise<unknown> }) => {
          const input = await context.json();
          return Response.json(await invoke(endpoint.action, input, request));
        },
      })),
      ...(["GET", "POST"] as const).map(method => ({ method, path: "/contentfn/status", handler: async (request: Request) => Response.json(await invoke("status", {}, request)) })),
    ],
    onError: error => {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 413) return Response.json(err("PAYLOAD_TOO_LARGE", "Request exceeds configured byte limit", {}));
      if (error instanceof SyntaxError) return Response.json(err("VALIDATION_FAILED", "Invalid JSON body", {}), { status: 400 });
      return Response.json(err("INTERNAL_ERROR", "Request could not be completed", {}), { status: status === 404 || status === 405 ? status : 500 });
    },
  });
}

export { handleStatus };
