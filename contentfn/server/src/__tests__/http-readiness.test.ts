import { expect, it } from "vitest";
import { createServer } from "node:http";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";

async function fixture() {
  const db = memoryAdapter();
  const server = createContentfnServer({ db });
  await server.api.datasets.create({ dataset: "prod" });
  await server.api.schema.upsert({ dataset: "prod", schema: { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" } }] }] } });
  return { db, server };
}
it("deduplicates concurrent HTTP mutation keys and rejects conflicting reuse", async () => {
  const { db, server } = await fixture();
  try {
    const call = (title: string) => server.router.handle(new Request("http://local/contentfn/docs/create", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "create-once" }, body: JSON.stringify({ dataset: "prod", type: "post", doc: { title } }) })).then(response => response.json());
    const results = await Promise.all([call("same"), call("same")]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]).toEqual(results[1]);
    const documents = await server.api.docs.query({ dataset: "prod" });
    expect(documents.ok && documents.result.data).toHaveLength(1);
    expect(await call("different")).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  } finally { await db.close(); }
});
it("streams real Node HTTP changes and disconnects cancelled subscriptions", async () => {
  const { db, server } = await fixture();
  const http = createServer(server.handler);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  const abort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/contentfn/events?dataset=prod`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
    await server.api.docs.create({ dataset: "prod", id: "post", type: "post", doc: { title: "stream" } });
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('"eventType":"doc.created"');
    expect(event).toContain('"_id":"post"');
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(server.realtime.getConnectionCount()).toBe(0);
  } finally {
    abort.abort();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await db.close();
  }
});
it("enforces byte limits on streamed Unicode JSON bodies", async () => {
  const db = memoryAdapter();
  const server = createContentfnServer({ db, limits: { maxPayloadBytes: 30 } });
  try {
    const body = JSON.stringify({ dataset: "界".repeat(20) });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
    const response = await server.router.handle(new Request("http://local/contentfn/datasets/create", { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  } finally { await db.close(); }
});

it("rejects malformed optional fields instead of silently changing their meaning", async () => {
  const { db, server } = await fixture();
  try {
    for (const [path, input] of [
      ['docs/create', { dataset: 'prod', type: 'post', doc: {}, asDraft: 'true' }],
      ['docs/get', { dataset: 'prod', id: 'post', perspective: 'typo' }],
      ['docs/delete', { dataset: 'prod', id: 'post', purge: 'false' }],
      ['assets/list', { dataset: 'prod', offset: -1 }],
    ] as const) {
      const response = await server.router.handle(new Request(`http://local/contentfn/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
  } finally { await db.close(); }
});
