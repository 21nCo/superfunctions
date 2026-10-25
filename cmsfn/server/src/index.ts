import { createLogger, type CmsfnLoggerConfig, type Operation, type OperationAction } from './logging/logger.js';
export { createLogger } from './logging/logger.js';
export type { CmsfnLoggerConfig, LogSink } from './logging/logger.js';
import { handleReferenceQuery } from './http/references.js';
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
  /** Metadata-only operational sink; failures never change committed operation results. */
  logging?: CmsfnLoggerConfig;
  /** Trusted host subject only. Never derive this from unverified body/header values. Bounded to 250ms. */
  resolveLogSubject?: (req: IncomingMessage, signal: AbortSignal) => Promise<string | undefined>;
  /** Trusted upstream identity, resolved after doc.read checks for every candidate type. */
  contentfnReferenceHeaders?: (req: IncomingMessage) => NonNullable<RequestInit['headers']> | Promise<NonNullable<RequestInit['headers']>>;
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
  /** Preview token lifetime: integer seconds from 1 to 900 (default 900). */
  previewTokenTtlSec?: number;
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
  checkCapabilities: (req: IncomingMessage, required: readonly string[]) => Promise<boolean>,
  operation?: Operation
): Promise<void> {
  const respond = (response: ServerResponse, status: number, data: CmsfnEnvelope<unknown>) => { operation?.finish(data); sendJson(response, status, data); };
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
    respond(res, 200, envelope);
    return;
  }

  if (config.db && method === "POST") {
    const rolesConfig = {
      db: config.db,
      authorizeRoles: config.authorizeRoles,
      logContext: operation?.context,
    };
    if (path === "/cmsfn/roles/list") {
      const envelope = await handleRolesList(rolesConfig, req);
      respond(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/roles/upsert") {
      const envelope = await handleRolesUpsert(rolesConfig, req);
      respond(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/roles/delete") {
      const envelope = await handleRolesDelete(rolesConfig, req);
      respond(res, 200, envelope);
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
      respond(res, 200, envelope);
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
      respond(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/create" && config.db) {
      const envelope = await handleReleasesCreate(
        {
          releasesStorage: { db: config.db },
          logContext: operation?.context,
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      respond(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/list" && config.db) {
      const envelope = await handleReleasesList(
        {
          releasesStorage: { db: config.db },
          logContext: operation?.context,
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      respond(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/add" && config.db) {
      const envelope = await handleReleasesAdd(
        {
          releasesStorage: { db: config.db },
          logContext: operation?.context,
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      respond(res, 200, envelope);
      return;
    }
    if (path === "/cmsfn/releases/publish" && config.db) {
      const envelope = await handleReleasesPublish(
        {
          releasesStorage: { db: config.db },
          logContext: operation?.context,
          resolveExecutionIdentity: config.resolveReleaseExecutionIdentity,
          releaseExecutionSchemaVersion: config.releaseExecutionSchemaVersion,
          contentfnBaseUrl: config.contentfn.baseUrl,
          checkCapabilities,
          allowedDatasets: config.datasets.map(dataset => dataset.name),
          getRolesForSubject: config.getRolesForSubject,
        },
        req
      );
      respond(res, 200, envelope);
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
    respond(res, 200, envelope);
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
    respond(res, 200, envelope);
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
    respond(res, 200, envelope);
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
    respond(res, 200, envelope);
    return;
  }

  if (method === "POST" && path === "/cmsfn/references/query") {
    respond(res, 200, await handleReferenceQuery({ contentfnBaseUrl: config.contentfn.baseUrl, allowedDatasets: config.datasets.map(dataset => dataset.name), getRolesForSubject: config.getRolesForSubject, contentfnReferenceHeaders: config.contentfnReferenceHeaders, checkCapabilities }, req));
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
        previewOrigin: config.preview?.targetOrigin,
        ttlSec: config.previewTokenTtlSec,
        logContext: operation?.context,
      },
      req
    );
    respond(res, 200, envelope);
    return;
  }

  // Not found for other paths
  respond(res, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Not found", details: {} },
  });
}

/**
 * Create an HTTP server that implements CmsFn endpoints.
 * Use server.listen() to start listening.
 */
export function createCmsfnServer(config: CmsfnServerConfig) {
  const logger = createLogger(config.logging);
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
  const actions = new Map<string, OperationAction>([['/cmsfn/roles/upsert', 'roles.upsert'], ['/cmsfn/roles/delete', 'roles.delete'], ['/cmsfn/preview/token', 'preview.token'], ['/cmsfn/releases/publish', 'releases.publish']]);
  const server = createServer((req, res) => {
    const action = req.method === 'POST' ? actions.get(req.url?.split('?')[0] ?? '') : undefined;
    const operation = action ? logger.operation(action, action === 'releases.publish' ? { origin: 'manual' } : {}) : undefined;
    void (async () => {
      if (operation && config.resolveLogSubject) {
        const signal = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          operation.context.subject = await Promise.race([Promise.resolve().then(() => config.resolveLogSubject!(req, signal.signal)), new Promise<undefined>(resolve => { timer = setTimeout(() => { signal.abort(); resolve(undefined); }, 250); })]);
        } catch { /* Identity enrichment is optional; no raw host error is logged. */ }
        finally { if (timer) clearTimeout(timer); signal.abort(); }
      }
      await route(config, req, res, async (_request, required) => (await check(required)).ok, operation);
    })().catch(() => {
      const failure = err('INTERNAL_ERROR', 'Internal server error'); operation?.finish(failure);
      if (!res.headersSent) sendJson(res, 500, failure); else res.destroy();
    });
  });
  server.on('listening', () => { if (controller.signal.aborted) controller = new AbortController(); void check().then(resolveReadiness); });
  server.on('close', () => { controller.abort(); resolveReadiness(err("CONTENTFN_UNAVAILABLE", "Server closed before readiness completed.")); });
  return Object.assign(server, { readiness, loggingStatus: logger.status,
    /** Call after the host completes its deployment-defined login/logout; never pass credentials. */
    reportSessionEvent: (action: 'session.login' | 'session.logout', input: { subject?: string; succeeded: boolean }) => {
      const operation = logger.operation(action, { subject: input.subject });
      operation.finish(input.succeeded ? ok({}) : err('AUTH_REQUIRED', 'Session operation failed'));
    }, executeDueReleases: (options?: { limit?: number; maxDocuments?: number }) => {
    if (!config.db) throw new Error("Release execution requires a database");
    return executeDueReleases({ db: config.db, contentfnBaseUrl: config.contentfn.baseUrl, allowedDatasets: config.datasets.map(dataset => dataset.name), resolveIdentity: config.resolveReleaseExecutionIdentity, schemaVersion: config.releaseExecutionSchemaVersion, logger }, options);
  } });
}

export { verifyPreviewToken } from "./preview/tokens.js";
export type { PreviewTokenScope, PreviewTokenClaims } from "./preview/tokens.js";
