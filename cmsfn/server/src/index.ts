/**
 * @cmsfn/server — CmsFn HTTP server (status, roles, preview, releases, etc.).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";
import type { CmsfnEnvelope, CmsfnStudioConfig } from "@cmsfn/core";
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
import type { CmsfnRole } from "@cmsfn/core";

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
} from "@cmsfn/core";

/** Server config: studio config plus optional status auth and roles. */
export interface CmsfnServerConfig extends CmsfnStudioConfig {
  /** If set, called for GET /cmsfn/status; return true to allow, false to deny. */
  authorizeStatus?: (req: IncomingMessage) => Promise<boolean>;
  /** Required for role endpoints. When set, POST /cmsfn/roles/* are registered. */
  db?: Adapter;
  /** If set, role CRUD endpoints require this to return true. */
  authorizeRoles?: (req: IncomingMessage) => Promise<boolean>;
  /** If set, used by permission checks (e.g. publish, preview token) to load roles for the request. */
  getRolesForSubject?: (req: IncomingMessage) => Promise<CmsfnRole[]>;
  /** Required for preview token when config.preview?.enabled; used to sign tokens. */
  previewSecret?: string;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function route(
  config: CmsfnServerConfig,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method ?? "";
  const path = req.url?.split("?")[0] ?? "";

  if (path === "/cmsfn/status" && method === "GET") {
    const envelope = await handleStatus(
      {
        contentfnBaseUrl: config.contentfn.baseUrl,
        datasetNames: config.datasets.map((d) => d.name),
        requireRealtime: config.preview?.enabled === true,
        authorizeStatus: config.authorizeStatus,
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
          contentfnBaseUrl: config.contentfn.baseUrl,
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
          contentfnBaseUrl: config.contentfn.baseUrl,
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
          contentfnBaseUrl: config.contentfn.baseUrl,
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
          contentfnBaseUrl: config.contentfn.baseUrl,
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
  return createServer((req, res) => {
    route(config, req, res).catch(() => {
      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          details: {},
        },
      });
    });
  });
}
