import { expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
it("persists schedules across server instances and checks the captured draft revision", async () => {
  const db = memoryAdapter();
  const server = createContentfnServer({ db });
  try {
    await server.api.datasets.create({ dataset: "prod" });
    await server.api.schema.upsert({ dataset: "prod", schema: { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" } }] }] } });
    await server.api.docs.create({ dataset: "prod", id: "post", type: "post", doc: { title: "ready" }, asDraft: true });
    expect(await server.api.docs.schedule({ dataset: "prod", id: "post", publishAt: "2000-01-01T00:00:00Z" })).toMatchObject({ ok: true });
    const restarted = createContentfnServer({ db });
    const messages: unknown[] = [];
    const connection = restarted.realtime.createConnection(message => messages.push(message));
    await connection.handleMessage(JSON.stringify({ type: "subscribe", dataset: "prod", docId: "post" }));
    messages.length = 0;
    expect(await restarted.processScheduledPublishes()).toEqual({ published: 1, failed: 0 });
    expect(messages).toEqual([expect.objectContaining({ eventType: "doc.published", document: expect.objectContaining({ _id: "post" }) })]);
    connection.disconnect();
    expect(await restarted.api.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { title: "ready" } });
    expect(await restarted.processScheduledPublishes()).toEqual({ published: 0, failed: 0 });
    await restarted.api.docs.schedule({ dataset: "prod", id: "post", publishAt: "2000-01-01T00:00:00Z" });
    await restarted.api.docs.patch({ dataset: "prod", id: "drafts.post", ops: [{ op: "set", path: "title", value: "unapproved" }] });
    expect(await restarted.processScheduledPublishes()).toEqual({ published: 0, failed: 1 });
    expect(await restarted.api.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { title: "ready" } });
  } finally { await db.close(); }
});
