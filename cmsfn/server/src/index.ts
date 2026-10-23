/**
 * @cmsfn/server — CmsFn HTTP server (status, roles, preview, releases, etc.).
 */

import { executeDueReleases, PUBLISH_REPLAY_CAPABILITY, type ReleaseExecutorConfig } from "./releases/executor.js";
export { executeDueReleases } from "./releases/executor.js";
export type { ReleaseExecutorConfig, ReleaseExecutionIdentity, DueReleaseResult } from "./releases/executor.js";
import type { IncomingMessage, ServerResponse } from "http";
import { fetchContentfnStatus, resolveStatusHeaders, BASE_CAPABILITIES, type ContentfnStatusResult } from "./contentfn/statusClient.js";
import { err, ok } from "cmsfn";
import { createServer } from "http";
import type { CmsfnEnvelope, CmsfnStudioConfig } from "cmsfn";
import type { Adapter } from "@superfunctions/db";
import { handleStatus } from "./http/status.js";
import { handleRolesList, handleRolesUpsert, handleRolesDelete } from "./http/roles.js";
import { handlePublish, handleUnpublish } from "./http/publish.js";
import { handlePreviewToken } from "./http/preview.js";
import {
  handleReleasesCreate,
  handleReleasesList,
  handleReleasesAdd,
  handleReleasesPublish,
} from "./http/releases.js";
import { handleOpsExport, handleOpsImport } from "./http/ops.js";
import { handleAuditEvents, handleAuditWebhooks } from "./http/audit.js";
import type { CmsfnRole } from "cmsfn";

export type {
  CmsfnEnvelope,
  CmsfnErrorCode,
  CmsfnError,
  CmsfnRole,
  CmsfnRelease,
  CmsfnReleasePublishResult,
  CmsfnStatusResult,
  CmsfnPreviewTokenResult,
  CmsfnAuditEvent,
  CmsfnWebhookDeliveryStatus,
  CmsfnServerAPI,
} from "cmsfn";

export { backfillReleaseSchedules } from "./releases/migrate.js";
export { getCmsfnStorageSchema } from "./storage/schema.js";

/** Server config: studio config plus optional status auth and roles. */
export interface CmsfnServerConfig extends CmsfnStudioConfig {
  /** If set, called for GET /cmsfn/status; return true to allow, false to deny. */
  contentfnStatusHeaders?: () => NonNullable<RequestInit['headers']> | Promise<NonNullable<RequestInit['headers']>>;
  authorizeStatus?: (req: IncomingMessage) => Promise<boolean>;
  /** Required for role endpoints. When set, POST /cmsfn/roles/* are registered. */
  db?: Adapter;
  /** Role CRUD requires explicit true; missing, false or failed authorization denies access before body parsing. */
  authorizeRoles?: (req: IncomingMessage) => Promise<boolean>;
  /** If set, used by permission checks (e.g. publish, preview token) to load roles for the request. */
  getRolesForSubject?: (req: IncomingMessage) => Promise<CmsfnRole[]>;
  /** Required for preview token when config.preview?.enabled; used to sign tokens. */
  previewSecret?: string;
  /** Host assertion that additive storage migration/backfill completed and old writers drained. */
  releaseExecutionSchemaVersion?: 2;
  /** Trusted service identity for durable manual recovery and host-driven scheduled publication. */
  resolveReleaseExecutionIdentity?: ReleaseExecutorConfig["resolveIdentity"];
  /** Trusted headers for ContentFn audit requests, resolved after local audit.read authorization.
   * Use a server service credential or explicitly derived upstream subject; browser headers are not copied.
   */
  contentfnAuditHeaders?: (req: IncomingMessage) => NonNullable<RequestInit["headers"]> | Promise<NonNullable<RequestInit["headers"]>>;
  /** Trusted upstream identity, resolved only after target ops authorization. */
  contentfnOpsHeaders?: (req: IncomingMessage) => NonNullable<RequestInit["headers"]> | Promise<NonNullable<RequestInit["headers"]>>;
  /** Explicit migration policy; omitted/false/throwing denies differing artifact and target datasets. */
  authorizeCrossDatasetImport?: (req: IncomingMessage, input: { sourceDataset: string; targetDataset: string }) => Promise<boolean>;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function route(
  config: CmsfnServerConfig,
  req: IncomingMessage,
  res: ServerResponse,
  checkCapabilities: (req: IncomingMessage, required: readonly string[]) => Promise<boolean>
): Promise<void> {
  const method = req.method ?? "";
  const path = req.url?.split("?")[0] ?? "";

  if (path === "/cmsfn/status" && method === "GET") {
    const envelope = await handleStatus(
      {
        contentfnBaseUrl: config.contentfn.baseUrl,
        datasetNames: config.datasets.map((d) => d.name),
        requireRealtime: config.preview?.enabled === true,
        requirePublishReplay: !!config.resolveReleaseExecutionIdentity && config.releaseExecutionSchemaVersion === 2,
        authorizeStatus: config.authorizeStatus,
        contentfnStatusHeaders: config.contentfnStatusHeaders,
      },
      req
    );
    sendJson(res, 200, envelope);
    return;
  }

  if (config.db && method === "POST") {
    const rolesConfig = {
      db: config.db,
      authorizeRoles: config.authorizeRoles,
    };
    if (path === "/cmsfn/roles/list") {
      const envelope = await handleRolesList(rolesConfig, req);
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/roles/upsert") {
      const envelope = await handleRolesUpsert(rolesConfig, req);
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/roles/delete") {
      const envelope = await handleRolesDelete(rolesConfig, req);
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/publish" && config.getRolesForSubject) {
      const envelope = await handlePublish(
        {
          getRolesForSubject: config.getRolesForSubject,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
        },
        req
      );
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/unpublish" && config.getRolesForSubject) {
      const envelope = await handleUnpublish(
        {
          getRolesForSubject: config.getRolesForSubject,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
        },
        req
      );
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/create" && config.db) {
      const envelope = await handleReleasesCreate(
        {
          releasesStorage: { db: config.db },
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/list" && config.db) {
      const envelope = await handleReleasesList(
        {
          releasesStorage: { db: config.db },
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/add" && config.db) {
      const envelope = await handleReleasesAdd(
        {
          releasesStorage: { db: config.db },
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      sendJson(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/publish" && config.db) {
      const envelope = await handleReleasesPublish(
        {
          releasesStorage: { db: config.db },
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      sendJson(res, 200, envelope);
      return;
    }
  }

  if (method === "POST" && path === "/cmsfn/ops/export") {
    const envelope = await handleOpsExport(
      {
        contentfnBaseUrl: config.contentfn.baseUrl,
        checkCapabilities,
        contentfnOpsHeaders: config.contentfnOpsHeaders,
        authorizeCrossDatasetImport: config.authorizeCrossDatasetImport,
        allowedDatasets: config.datasets.map((d) => d.name),
        getRolesForSubject: config.getRolesForSubject,
      },
      req
    );
    sendJson(res, 200, envelope);
    return;
  }
  if (method === "POST" && path === "/cmsfn/ops/import") {
    const envelope = await handleOpsImport(
      {
        contentfnBaseUrl: config.contentfn.baseUrl,
        checkCapabilities,
        contentfnOpsHeaders: config.contentfnOpsHeaders,
        authorizeCrossDatasetImport: config.authorizeCrossDatasetImport,
        allowedDatasets: config.datasets.map((d) => d.name),
        getRolesForSubject: config.getRolesForSubject,
      },
      req
    );
    sendJson(res, 200, envelope);
    return;
  }
  if (method === "POST" && path === "/cmsfn/audit/events") {
    const envelope = await handleAuditEvents(
      {
        contentfnBaseUrl: config.contentfn.baseUrl,
        checkCapabilities,
        contentfnAuditHeaders: config.contentfnAuditHeaders,
        allowedDatasets: config.datasets.map((d) => d.name),
        getRolesForSubject: config.getRolesForSubject,
      },
      req
    );
    sendJson(res, 200, envelope);
    return;
  }
  if (method === "POST" && path === "/cmsfn/audit/webhooks") {
    const envelope = await handleAuditWebhooks(
      {
        contentfnBaseUrl: config.contentfn.baseUrl,
        checkCapabilities,
        contentfnAuditHeaders: config.contentfnAuditHeaders,
        allowedDatasets: config.datasets.map((d) => d.name),
        getRolesForSubject: config.getRolesForSubject,
      },
      req
    );
    sendJson(res, 200, envelope);
    return;
  }

  if (method === "POST" && path === "/cmsfn/preview/token") {
    const envelope = await handlePreviewToken(
      {
        getRolesForSubject: config.getRolesForSubject,
        checkCapabilities,
        allowedDatasets: config.datasets.map(dataset => dataset.name),
        previewEnabled: config.preview?.enabled === true,
        previewSecret: config.previewSecret,
      },
      req
    );
    sendJson(res, 200, envelope);
    return;
  }

  // Not found for other paths
  sendJson(res, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Not found", details: {} },
  });
}

/**
 * Create an HTTP server that implements CmsFn endpoints.
 * Use server.listen() to start listening.
 */
export function createCmsfnServer(config: CmsfnServerConfig) {
  let controller = new AbortController();
  async function check(required?: readonly string[]): Promise<CmsfnEnvelope<ContentfnStatusResult>> {
    try {
      const headers = await resolveStatusHeaders(config.contentfnStatusHeaders, controller.signal);
      const startupRequired = [...BASE_CAPABILITIES, ...(config.preview?.enabled ? ["content.realtime"] : []), ...(config.resolveReleaseExecutionIdentity && config.releaseExecutionSchemaVersion === 2 ? [PUBLISH_REPLAY_CAPABILITY] : [])];
      const status = await fetchContentfnStatus(config.contentfn.baseUrl, config.preview?.enabled === true, { headers, required: required ?? startupRequired, signal: controller.signal });
      return status ? ok(status) : err("CONTENTFN_UNAVAILABLE", "ContentFn is unreachable or missing required capabilities.");
    } catch { return err("CONTENTFN_UNAVAILABLE", "ContentFn status identity could not be configured."); }
  }
  let resolveReadiness!: (value: CmsfnEnvelope<ContentfnStatusResult>) => void;
  const readiness = new Promise<CmsfnEnvelope<ContentfnStatusResult>>(resolve => { resolveReadiness = resolve; });
  const server = createServer((req, res) => {
    route(config, req, res, async (_request, required) => (await check(required)).ok).catch(() => {
      sendJson(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "Internal server error", details: {} } });
    });
  });
  server.on('listening', () => { if (controller.signal.aborted) controller = new AbortController(); void check().then(resolveReadiness); });
  server.on('close', () => { controller.abort(); resolveReadiness(err("CONTENTFN_UNAVAILABLE", "Server closed before readiness completed.")); });
  return Object.assign(server, { readiness, executeDueReleases: (options?: { limit?: number; maxDocuments?: number }) => {
    if (!config.db) throw new Error("Release execution requires a database");
    return executeDueReleases({ db: config.db, contentfnBaseUrl: config.contentfn.baseUrl, allowedDatasets: config.datasets.map(dataset => dataset.name), resolveIdentity: config.resolveReleaseExecutionIdentity, schemaVersion: config.releaseExecutionSchemaVersion }, options);
  } });
}
