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
