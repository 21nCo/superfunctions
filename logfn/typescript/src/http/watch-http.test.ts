import { createServer } from "node:http";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { watchLogsHandler } from "./watch.js";
import { sinkHttp } from "../sinks/http.js";

it("acknowledges a real HTTP batch only after a durable write, and retries storage failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "logfn-ingest-"));
  const file = join(directory, "events.jsonl");
  let fail = true;
  const handler = watchLogsHandler({
    auth: { verifyToken: async req => req.headers.get("authorization") === "Bearer test" },
    ingest: async events => {
      if (fail) { fail = false; throw Error("temporary storage failure"); }
      const handle = await open(file, "a");
      try { await handle.writeFile(events.map(e => JSON.stringify(e)).join("\n") + "\n"); await handle.sync(); }
      finally { await handle.close(); }
    },
  });
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const response = await handler(new Request("http://localhost/watch/logs", {
      method: "POST", headers: { authorization: incoming.headers.authorization ?? "" }, body: Buffer.concat(chunks),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No listener");
    const url = `http://127.0.0.1:${address.port}/watch/logs`;
    const event = { ts: new Date().toISOString(), level: "info", msg: "persisted", name: "real-http", version: "0" };
    const post = () => fetch(url, { method: "POST", headers: { Authorization: "Bearer test" }, body: JSON.stringify({ events: [event] }) });
    expect((await post()).status).toBe(503);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(JSON.parse((await readFile(file, "utf8")).trim())).toEqual(event);
    const sink = sinkHttp({ url, batch: 2, auth: { token: "test" }, retry: { attempts: 1 } });
    sink(["second", "third", "fourth"].map(msg => ({ ...event, level: "info" as const, msg })));
    await sink.flush!();
    expect((await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line).msg))
      .toEqual(["persisted", "second", "third", "fourth"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
