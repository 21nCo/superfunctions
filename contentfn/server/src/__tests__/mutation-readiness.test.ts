import { describe, it, expect } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { createContentfnServer } from "../server.js";

const schema = { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true }] }] };
async function fixture(db: Adapter = memoryAdapter()) {
  const server = createContentfnServer({ db });
  expect(await server.api.datasets.create({ dataset: "prod" })).toMatchObject({ ok: true });
  expect(await server.api.schema.upsert({ dataset: "prod", schema })).toMatchObject({ ok: true });
  const created = await server.api.docs.create({ dataset: "prod", id: "post", type: "post", doc: { title: "original" } });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return { server, db, document: created.result };
}

describe("mutation durability and authorization", () => {
  it("allows exactly one concurrent mutation of the same revision", async () => {
    const { server, db, document } = await fixture();
    try {
      const results = await Promise.all(["first", "second"].map(title => server.api.docs.patch({ dataset: "prod", id: "post", ifRev: document._rev, ops: [{ op: "set", path: "title", value: title }] })));
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.find(result => !result.ok)).toMatchObject({ error: { code: "REV_CONFLICT" } });
    } finally { await db.close(); }
  });
  it("rolls back the document if revision persistence fails", async () => {
    const db = memoryAdapter();
    const { server, document } = await fixture(db);
    const transaction = db.transaction.bind(db);
    db.transaction = (callback, options) => transaction(tx => callback(new Proxy(tx, { get(target, key) {
      if (key === "create") return async (params: Parameters<Adapter["create"]>[0]) => {
        if (params.model === "contentfn_revisions") throw new Error("sensitive database detail");
        return target.create(params);
      };
      return Reflect.get(target, key);
    } })), options);
    try {
      expect(await server.api.docs.patch({ dataset: "prod", id: "post", ops: [{ op: "set", path: "title", value: "lost" }] })).toMatchObject({ ok: false, error: { code: "STORAGE_ERROR" } });
      expect(await server.api.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { title: "original", _rev: document._rev } });
    } finally { await db.close(); }
  });
  it("removes dataset data before a name is reused", async () => {
    const { server, db } = await fixture();
    try {
      expect(await server.api.datasets.delete({ dataset: "prod" })).toMatchObject({ ok: true });
      await server.api.datasets.create({ dataset: "prod" });
      await server.api.schema.upsert({ dataset: "prod", schema });
      expect(await server.api.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: false, error: { code: "DOCUMENT_NOT_FOUND" } });
      expect(await server.api.docs.history({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { revisions: [] } });
    } finally { await db.close(); }
  });
  it("applies authorization to direct APIs and supplies the real HTTP request", async () => {
    const db = memoryAdapter();
    const server = createContentfnServer({ db, authorize: (context) => context === "trusted" || (context instanceof Request && context.headers.get("authorization") === "Bearer test") });
    try {
      expect(await server.api.datasets.create({ dataset: "prod" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
      expect(await server.forContext("trusted").datasets.create({ dataset: "prod" })).toMatchObject({ ok: true });
      const response = await server.router.handle(new Request("http://local/contentfn/datasets/list", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: "{}" }));
      expect(await response.json()).toMatchObject({ ok: true, result: { datasets: ["prod"] } });
    } finally { await db.close(); }
  });
});
