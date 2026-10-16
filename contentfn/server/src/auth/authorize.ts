import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";
import type { AuthorizeFn } from "../realtime/server.js";

export type { AuthorizeFn };

export async function checkAuthorize<T>(
  authorize: AuthorizeFn | undefined,
  ctx: unknown,
  action: string,
  input: Record<string, unknown>
): Promise<ContentfnEnvelope<null> | null> {
  if (!authorize) return null;
  let allowed = false;
  try { allowed = await authorize(ctx, action, input); } catch { /* Authorization failures deny access. */ }
  if (!allowed) {
    return err("PERMISSION_DENIED", `Not authorized for action: ${action}`, {});
  }
  return null;
}

export const ACTIONS = {
  DATASETS_CREATE: "datasets.create",
  DATASETS_LIST: "datasets.list",
  DATASETS_DELETE: "datasets.delete",
  DATASETS_EXPORT: "datasets.export",
  DATASETS_IMPORT: "datasets.import",
  SCHEMA_UPSERT: "schema.upsert",
  SCHEMA_GET: "schema.get",
  DOCS_CREATE: "docs.create",
  DOCS_GET: "docs.get",
  DOCS_DELETE: "docs.delete",
  DOCS_PATCH: "docs.patch",
  DOCS_PUBLISH: "docs.publish",
  DOCS_UNPUBLISH: "docs.unpublish",
  DOCS_HISTORY: "docs.history",
  DOCS_RESTORE: "docs.restore",
  QUERY: "query",
  ASSETS_UPLOAD: "assets.upload",
  ASSETS_GET: "assets.get",
  ASSETS_LIST: "assets.list",
  WEBHOOKS_REGISTER: "webhooks.register",
  WEBHOOKS_LIST: "webhooks.list",
  WEBHOOKS_DELETE: "webhooks.delete",
  REALTIME_SUBSCRIBE: "realtime.subscribe",
  STATUS: "status",
} as const;
