import { compatibleStatus } from "./compatibleStatus.js";
import { readResponse, field } from "./responseHelpers.js";
/**
 * PHASE_07: Preview token — TV-PREVIEW-TOKEN-001, TV-PREVIEW-DISABLED-001.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { CmsfnRole } from "cmsfn";

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: "http://contentfn.test" },
    datasets: [{ name: "prod" }],
    desk: { kind: "divider" },
    auth: { kind: "custom" },
    db: memoryAdapter(),
    ...overrides,
  };
}

function listen(server: ReturnType<typeof createCmsfnServer>): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("PHASE_07: Preview token", () => {
  beforeEach(() => { const original = globalThis.fetch; vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => String(input).endsWith('/contentfn/status') ? Promise.resolve(new Response(JSON.stringify(compatibleStatus))) : original(input, init)); });
  afterEach(() => vi.unstubAllGlobals());
  describe("TV-PREVIEW-TOKEN-001: preview token minted", () => {
    it("POST /cmsfn/preview/token with dataset and docId returns ok, result.token and result.expiresAt (ISO)", async () => {
      const roleWithRead: CmsfnRole = {
        id: "editor",
        name: "Editor",
        rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }],
      };
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: true, targetOrigin: "https://preview.test", resolveUrl: () => "" },
          previewSecret: "test-secret".repeat(4),
          getRolesForSubject: async () => [roleWithRead],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(true);
        expect(field(data, "result")).toBeDefined();
        expect(typeof field(data, "result.token")).toBe("string");
        expect(field(data, "result.token.length")).toBeGreaterThan(0);
        expect(typeof field(data, "result.expiresAt")).toBe("string");
        expect(field(data, "result.expiresAt")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(field(data, "result.dataset")).toBe("prod");
        expect(Array.isArray(field(data, "result.docIds"))).toBe(true);
        expect(field(data, "result.docIds")).toEqual(["post-1"]);
      } finally {
        close();
      }
    });
  });

  describe("TV-PREVIEW-DISABLED-001: preview not configured", () => {
    it("POST /cmsfn/preview/token when preview disabled returns ok=false, error.code PREVIEW_NOT_CONFIGURED", async () => {
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: false, targetOrigin: "", resolveUrl: () => "" },
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PREVIEW_NOT_CONFIGURED");
      } finally {
        close();
      }
    });

    it("POST /cmsfn/preview/token when previewSecret not set returns PREVIEW_NOT_CONFIGURED", async () => {
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: true, targetOrigin: "https://x.test", resolveUrl: () => "" },
          getRolesForSubject: async () => [],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PREVIEW_NOT_CONFIGURED");
      } finally {
        close();
      }
    });
  });

  describe("Permission", () => {
    it("when role denies doc.read returns PERMISSION_DENIED", async () => {
      const roleNoRead: CmsfnRole = {
        id: "anon",
        name: "Anon",
        rules: [],
      };
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: true, targetOrigin: "https://x.test", resolveUrl: () => "" },
          previewSecret: "secret".repeat(6),
          getRolesForSubject: async () => [roleNoRead],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PERMISSION_DENIED");
      } finally {
        close();
      }
    });
  });
  it('binds HTTP tokens to configured scope and fails closed for invalid scope or unavailable authorization', async () => {
    let mode: 'allow' | 'throw' | 'deny' = 'allow';
    const server = createCmsfnServer(minimalConfig({
      preview: { enabled: true, targetOrigin: 'https://preview.test', resolveUrl: () => '' },
      previewSecret: 'fixture-secret'.repeat(4),
      getRolesForSubject: async () => { if (mode === 'throw') throw Error('private identity failure'); return mode === 'deny' ? [] : [{ id: 'reader', name: 'Reader', rules: [{ datasets: '*', types: '*', actions: ['doc.read'] }] }]; },
    }));
    const { port, close } = await listen(server);
    const post = async (body: unknown) => readResponse(await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    try {
      const result = await post({ dataset: 'prod', docId: 'drafts.one', audience: 'https://attacker.test', ttlSec: 86400 });
      expect(field(result, 'result.audience')).toBe('https://preview.test'); expect(field(result, 'result.docIds')).toEqual(['one']);
      for (const body of [{ dataset: 'prod' }, { dataset: 'prod', docIds: [] }, { dataset: 'prod', docId: 'drafts.' }, { dataset: 'prod', docIds: Array(101).fill('one') }]) expect(field(await post(body), 'error.code')).toBe('VALIDATION_FAILED');
      expect(field(await post({ dataset: 'other', docId: 'one' }), 'error.code')).toBe('PERMISSION_DENIED');
      for (mode of ['throw', 'deny'] as const) {
        const denied = await post({ dataset: 'prod', docId: 'one' });
        expect(field(denied, 'error.code')).toBe('PERMISSION_DENIED'); expect(JSON.stringify(denied)).not.toContain('private'); expect(field(denied, 'result')).toBeUndefined();
      }
    } finally { close(); }
  });

});
