import { expect, it } from "vitest";
import { createServer } from "node:http";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
const query = {
  dataset: "prod",
  filter: { field: "title", op: "eq" as const, value: "keep" },
};
async function fixture(
  authorize?: (
    context: unknown,
    action: string,
    input: Record<string, unknown>,
  ) => boolean,
) {
  const db = memoryAdapter();
  const server = createContentfnServer({ db, authorize });
  await server.api.datasets.create({ dataset: "prod" });
  await server.api.schema.upsert({
    dataset: "prod",
    schema: {
      version: 1,
      documentTypes: [
        {
          name: "post",
          fields: [
            { name: "title", type: { kind: "primitive", type: "string" } },
          ],
        },
      ],
    },
  });
  return { db, server };
}
async function* events(response: Response) {
  const reader = response.body!.getReader();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      text += new TextDecoder().decode(chunk.value);
      let end;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
it("streams initial query snapshots and changes including nonmatching updates and deletions over real HTTP", async () => {
  const { db, server } = await fixture();
  const http = createServer(server.handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  try {
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/contentfn/events?dataset=prod&query=${encodeURIComponent(JSON.stringify(query))}`;
    const response = await fetch(url, { signal: abort.signal });
    expect(response.status).toBe(200);
    const stream = events(response);
    expect((await stream.next()).value).toMatchObject({
      eventType: "query.snapshot",
      queryResult: { data: [], nextCursor: null },
    });
    await server.api.docs.create({
      dataset: "prod",
      id: "excluded",
      type: "post",
      doc: { title: "other" },
    });
    await server.api.docs.create({
      dataset: "prod",
      id: "included",
      type: "post",
      doc: { title: "keep" },
    });
    expect((await stream.next()).value).toMatchObject({
      eventType: "query.updated",
      queryResult: { data: [{ _id: "included" }] },
    });
    await server.api.docs.patch({
      dataset: "prod",
      id: "included",
      ops: [{ op: "set", path: "title", value: "gone" }],
    });
    expect((await stream.next()).value.queryResult.data).toEqual([]);
    await server.api.docs.create({
      dataset: "prod",
      id: "deleted",
      type: "post",
      doc: { title: "keep" },
    });
    expect(
      (await stream.next()).value.queryResult.data.map(
        (doc: { _id: string }) => doc._id,
      ),
    ).toEqual(["deleted"]);
    await server.api.docs.delete({
      dataset: "prod",
      id: "deleted",
      purge: true,
    });
    expect((await stream.next()).value.queryResult.data).toEqual([]);
    await stream.return();
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.realtime.getConnectionCount()).toBe(0);
  } finally {
    abort.abort();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await db.close();
  }
}, 10000);
it("rejects malformed/cross-dataset queries and applies canonical query authorization", async () => {
  const { db, server } = await fixture(
    (_context, action) => action !== "query",
  );
  try {
    for (const [text, code] of [
      [JSON.stringify(query), "PERMISSION_DENIED"],
      ["{", "QUERY_INVALID"],
      [JSON.stringify({ ...query, dataset: "other" }), "QUERY_INVALID"],
      [" ".repeat(16385), "PAYLOAD_TOO_LARGE"],
    ] as const) {
      const response = await server.router.handle(
        new Request(
          `http://local/contentfn/events?dataset=prod&query=${encodeURIComponent(text)}`,
        ),
      );
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code },
      });
    }
    expect(server.realtime.getConnectionCount()).toBe(0);
  } finally {
    await db.close();
  }
});
it("rechecks query authorization on refresh and terminates revoked subscriptions", async () => {
  let allowed = true;
  const { db, server } = await fixture(
    (_context, action) => action !== "query" || allowed,
  );
  try {
    const response = await server.router.handle(
      new Request(
        `http://local/contentfn/events?dataset=prod&query=${encodeURIComponent(JSON.stringify(query))}`,
      ),
    );
    const stream = events(response);
    expect((await stream.next()).value.eventType).toBe("query.snapshot");
    allowed = false;
    await server.api.docs.create({
      dataset: "prod",
      type: "post",
      doc: { title: "keep" },
    });
    expect((await stream.next()).value).toMatchObject({
      type: "error",
      code: "PERMISSION_DENIED",
    });
    expect((await stream.next()).done).toBe(true);
    expect(server.realtime.getConnectionCount()).toBe(0);
  } finally {
    await db.close();
  }
});
it("terminates query subscriptions when their dataset is deleted", async () => {
  const { db, server } = await fixture();
  try {
    const stream = events(
      await server.router.handle(
        new Request(
          `http://local/contentfn/events?dataset=prod&query=${encodeURIComponent(JSON.stringify(query))}`,
        ),
      ),
    );
    expect((await stream.next()).value.eventType).toBe("query.snapshot");
    await server.api.datasets.delete({ dataset: "prod" });
    expect((await stream.next()).value).toMatchObject({
      type: "error",
      code: "DATASET_NOT_FOUND",
    });
    expect((await stream.next()).done).toBe(true);
    expect(server.realtime.getConnectionCount()).toBe(0);
  } finally {
    await db.close();
  }
});
