import type { MdfnSidecar } from "@mdfn/core";

export interface MdfnRemoteDocument {
  readonly id: string;
  readonly ownerId: string;
  readonly tenantId?: string;
  readonly title?: string;
  readonly markdown: string;
  readonly sourceHash: string;
  readonly schemaHash: string;
  readonly sidecar?: MdfnSidecar;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MdfnRemoteVersion extends MdfnRemoteDocument { readonly documentId: string; readonly authorId: string; readonly changeSource: string; }

export class MdfnClientError extends Error {
  constructor(readonly status: number, readonly code: string, readonly response: Response) { super(code); this.name = "MdfnClientError"; }
}

export interface MdfnClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export interface MdfnClient {
  createDocument(input: { readonly id?: string; readonly title?: string; readonly markdown: string; readonly sidecar?: MdfnSidecar }): Promise<MdfnRemoteDocument>;
  getDocument(id: string): Promise<MdfnRemoteDocument>;
  listDocuments(options?: { readonly limit?: number; readonly offset?: number }): Promise<readonly MdfnRemoteDocument[]>;
  updateDocument(id: string, input: { readonly expectedVersion: number; readonly markdown?: string; readonly title?: string; readonly sidecar?: MdfnSidecar; readonly changeSource?: string; readonly idempotencyKey?: string }): Promise<MdfnRemoteDocument>;
  deleteDocument(id: string): Promise<void>;
  listVersions(id: string): Promise<readonly MdfnRemoteVersion[]>;
  getVersion(id: string, version: number): Promise<MdfnRemoteVersion>;
  getSidecar(id: string): Promise<MdfnSidecar>;
  updateSidecar(id: string, expectedVersion: number, sidecar: MdfnSidecar): Promise<MdfnRemoteDocument>;
  appendCollaborationUpdate(id: string, update: string): Promise<string>;
  getCollaborationUpdates(id: string): Promise<readonly string[]>;
}

export function createMdfnClient(options: MdfnClientOptions = {}): MdfnClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("MDFN_FETCH_UNAVAILABLE");
  const base = (options.baseUrl ?? "/api/mdfn").replace(/\/$/, "");
  const encode = encodeURIComponent;
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const configured = typeof options.headers === "function" ? await options.headers() : options.headers;
    const headers = new Headers(configured);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetcher(`${base}${path}`, { ...init, headers });
    if (!response.ok) {
      let code = `MDFN_HTTP_${response.status}`;
      try { const body = await response.clone().json() as { error?: string }; if (body.error) code = body.error; } catch { /* non-JSON error body */ }
      throw new MdfnClientError(response.status, code, response);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  return {
    createDocument: (input) => request("/documents", { method: "POST", body: JSON.stringify(input) }),
    getDocument: (id) => request(`/documents/${encode(id)}`),
    async listDocuments(list = {}) { const query = new URLSearchParams(); if (list.limit !== undefined) query.set("limit", String(list.limit)); if (list.offset !== undefined) query.set("offset", String(list.offset)); const result = await request<{ documents: MdfnRemoteDocument[] }>(`/documents?${query}`); return result.documents; },
    updateDocument: (id, input) => request(`/documents/${encode(id)}`, { method: "PATCH", headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined, body: JSON.stringify(input) }),
    deleteDocument: (id) => request(`/documents/${encode(id)}`, { method: "DELETE" }),
    async listVersions(id) { return (await request<{ versions: MdfnRemoteVersion[] }>(`/documents/${encode(id)}/versions`)).versions; },
    getVersion: (id, version) => request(`/documents/${encode(id)}/versions/${version}`),
    getSidecar: (id) => request(`/documents/${encode(id)}/sidecar`),
    updateSidecar: (id, expectedVersion, sidecar) => request(`/documents/${encode(id)}/sidecar`, { method: "PUT", body: JSON.stringify({ expectedVersion, sidecar }) }),
    async appendCollaborationUpdate(id, update) { return (await request<{ id: string }>(`/documents/${encode(id)}/collaboration-updates`, { method: "POST", body: JSON.stringify({ update }) })).id; },
    async getCollaborationUpdates(id) { return (await request<{ updates: string[] }>(`/documents/${encode(id)}/collaboration-updates`)).updates; },
  };
}

export const MDFN_CLIENT_VERSION = "0.1.0" as const;
