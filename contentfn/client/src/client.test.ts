import { expect, it } from "vitest";
import { createContentfnClient } from "./index.js";
it("sends credentials and exact endpoint inputs", async () => {
  const client = createContentfnClient({ baseUrl: "https://content.example/api", headers: async () => ({ authorization: "Bearer token" }), fetch: async (url, init) => {
    expect(String(url)).toBe("https://content.example/api/contentfn/docs/get");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(init?.body as string)).toEqual({ dataset: "prod", id: "post" });
    expect(init?.redirect).toBe("error");
    return Response.json({ ok: true, result: { _id: "post" } });
  } });
  expect(await client.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { _id: "post" } });
});
it("preserves canonical server errors and contains invalid transport responses", async () => {
  const client = createContentfnClient({ baseUrl: "https://content.example", fetch: async () => Response.json({ ok: false, error: { code: "PERMISSION_DENIED", message: "Denied", details: {} } }, { status: 403 }) });
  expect(await client.datasets.list()).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  const invalid = createContentfnClient({ baseUrl: "https://content.example", fetch: async () => new Response("untrusted proxy details", { status: 502 }) });
  expect(await invalid.datasets.list()).toEqual({ ok: false, error: { code: "INTERNAL_ERROR", message: "ContentFn request failed", details: {} } });
});
it("rejects credential-bearing base URLs", () => {
  expect(() => createContentfnClient({ baseUrl: "https://secret:password@content.example" })).toThrow(/credentials/);
});

it("queries audit records using the typed dataset and pagination contract", async () => {
  const result = { records: [{ id: "audit-id", dataset: "prod", action: "docs.create", actor: { subject: "operator" }, targetIds: ["prod", "post"], timestamp: "2026-10-23T00:00:00.000Z" }], nextOffset: 2 };
  const client = createContentfnClient({ baseUrl: "https://content.example", fetch: async (url, init) => {
    expect(String(url)).toBe("https://content.example/contentfn/audit/query");
    expect(JSON.parse(init?.body as string)).toEqual({ dataset: "prod", action: "docs.create", limit: 1, offset: 1 });
    return Response.json({ ok: true, result });
  } });
  expect(await client.audit.query({ dataset: "prod", action: "docs.create", limit: 1, offset: 1 })).toEqual({ ok: true, result });
});
