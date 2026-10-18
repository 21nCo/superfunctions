import { streamContentfnEvents } from "./realtime.js";
export type { ContentfnRealtimeEvent } from "./realtime.js";
/**
 * ContentFn client - re-export types from @contentfn/core.
 */

export type {
  ContentfnErrorCode,
  ContentfnError,
  ContentfnEnvelope,
  ContentfnPrimitiveType,
  ContentfnFieldType,
  ContentfnField,
  ContentfnDocumentType,
  ContentfnSchema,
  ContentfnSystemFields,
  ContentfnDocument,
  CfqlOperator,
  CfqlFilter,
  CfqlOrderBy,
  CfqlProjection,
  CfqlQuery,
  CfqlResultPage,
  ContentfnPatchOp,
  ContentfnPatchInput,
} from "@contentfn/core";

import type { CfqlQuery, CfqlResultPage, ContentfnDocument, ContentfnEnvelope, ContentfnPatchInput, ContentfnSchema } from "@contentfn/core";

export interface ContentfnClientOptions {
  /** Origin or deployment URL; endpoints are mounted below /contentfn. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  timeoutMs?: number;
}

/** Typed browser/Node HTTP client. Expected transport failures use the canonical envelope. */
export function createContentfnClient(options: ContentfnClientOptions) {
  const base = new URL(options.baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new TypeError("baseUrl must be an HTTP(S) URL without embedded credentials");
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new RangeError("timeoutMs must be a positive integer");
  async function request<T>(endpoint: string, input: unknown = {}): Promise<ContentfnEnvelope<T>> {
    try {
      const headers = new Headers(typeof options.headers === "function" ? await options.headers() : options.headers);
      headers.set("Content-Type", "application/json");
      const url = `${base.href.replace(/\/$/, "")}/contentfn/${endpoint}`;
      const response = await (options.fetch ?? globalThis.fetch)(url, { method: "POST", headers, body: JSON.stringify(input), credentials: options.credentials, signal: AbortSignal.timeout(timeout), redirect: "error" });
      const result: unknown = await response.json();
      if (result && typeof result === "object" && "ok" in result) {
        const envelope = result as ContentfnEnvelope<T>;
        if (envelope.ok === true && "result" in envelope) return envelope;
        if (envelope.ok === false && envelope.error && typeof envelope.error.code === "string" && typeof envelope.error.message === "string") return envelope;
      }
      return { ok: false, error: { code: "INTERNAL_ERROR", message: "Server returned an invalid ContentFn response", details: { status: response.status } } };
    } catch {
      return { ok: false, error: { code: "INTERNAL_ERROR", message: "ContentFn request failed", details: {} } };
    }
  }
  const query = (input: CfqlQuery) => request<CfqlResultPage>("query", input);
  return {
    realtime: { subscribe: (input: { dataset: string; docId?: string; query?: import("@contentfn/core").CfqlQuery; signal?: AbortSignal }) => streamContentfnEvents(options, input) },
    datasets: {
      create: (input: { dataset: string }) => request<{ dataset: string }>("datasets/create", input),
      list: () => request<{ datasets: string[] }>("datasets/list"),
      delete: (input: { dataset: string }) => request<Record<string, never>>("datasets/delete", input),
      export: (input: { dataset: string }) => request<{ dataset: string; exportedAt: string; artifact: unknown }>("datasets/export", input),
      import: (input: { dataset: string; artifact: unknown }) => request<Record<string, never>>("datasets/import", input),
    },
    schema: {
      get: (input: { dataset: string }) => request<ContentfnSchema>("schema/get", input),
      upsert: (input: { dataset: string; schema: ContentfnSchema; migration?: { description: string } }) => request<{ schemaHash: string }>("schema/upsert", input),
    },
    docs: {
      schedule: (input: { dataset: string; id: string; publishAt: string; ifRev?: string }) => request<{ scheduleId: string; publishAt: string }>("docs/schedule", input),
      cancelSchedule: (input: { dataset: string; id: string }) => request<Record<string, never>>("docs/cancelSchedule", input),
      query, list: query,
      create: (input: { dataset: string; id?: string; type: string; doc: Record<string, unknown>; asDraft?: boolean }) => request<ContentfnDocument>("docs/create", input),
      get: (input: { dataset: string; id: string; perspective?: "published" | "draft" | "raw" }) => request<ContentfnDocument>("docs/get", input),
      patch: (input: ContentfnPatchInput) => request<ContentfnDocument>("docs/patch", input),
      delete: (input: { dataset: string; id: string; purge?: boolean }) => request<Record<string, never>>("docs/delete", input),
      publish: (input: { dataset: string; id: string; ifRev?: string }) => request<ContentfnDocument>("docs/publish", input),
      unpublish: (input: { dataset: string; id: string; ifRev?: string }) => request<Record<string, never>>("docs/unpublish", input),
      history: (input: { dataset: string; id: string; limit?: number; cursor?: string | null }) => request<{ revisions: ContentfnDocument[]; nextCursor: string | null }>("docs/history", input),
      restore: (input: { dataset: string; id: string; rev: string }) => request<ContentfnDocument>("docs/restore", input),
    },
    assets: {
      upload: (input: { dataset: string; filename: string; contentType: string; bytesBase64: string }) => request<{ assetId: string; url: string }>("assets/upload", input),
      get: (input: { dataset: string; assetId: string }) => request<{ assetId: string; url: string; metadata: Record<string, unknown> }>("assets/get", input),
    },
    webhooks: {
      deliveries: (input: { dataset: string; webhookId: string }) => request<{ deliveries: Array<{ eventId: string; webhookId: string; attempt: number; status: "pending" | "processing" | "delivered" | "failed"; lastError: string | null; nextRunAt: string }> }>("webhooks/deliveries", input),
      register: (input: { dataset: string; url: string; events: string[]; secret?: string }) => request<{ webhookId: string }>("webhooks/register", input),
      list: (input: { dataset: string }) => request<{ webhooks: Array<{ webhookId: string; url: string; events: string[] }> }>("webhooks/list", input),
      delete: (input: { dataset: string; webhookId: string }) => request<Record<string, never>>("webhooks/delete", input),
    },
    status: () => request<{ serverTime: string; capabilities: string[]; limits: Record<string, number> }>("status"),
  };
}
export type ContentfnClient = ReturnType<typeof createContentfnClient>;
