import { it, expect } from "vitest";
import { eventStream } from "../realtime/sse.js";
import { RealtimeServer } from "../realtime/server.js";
import { createLogger } from "../logging/logger.js";
const request = () =>
  new Request(
    "http://local/contentfn/events?dataset=prod&query=" +
      encodeURIComponent(JSON.stringify({ dataset: "prod" })),
  );
const event = {
  eventId: "event",
  dataset: "prod",
  type: "doc.updated",
  timestamp: new Date().toISOString(),
};
it("serializes refreshes and coalesces bursts without losing a change during an in-flight read", async () => {
  const realtime = new RealtimeServer();
  let calls = 0,
    active = 0,
    maximum = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const response = await eventStream(request(), {
    realtime,
    logger: createLogger(),
    query: async () => {
      const call = ++calls;
      maximum = Math.max(maximum, ++active);
      if (call === 2) await gate;
      active--;
      return {
        ok: true,
        result: { data: [{ _id: String(call) }], nextCursor: null },
      };
    },
  });
  const reader = response.body!.getReader();
  await reader.read();
  realtime.broadcast(event);
  realtime.broadcast(event);
  release();
  let frames = "";
  while (!frames.includes("query.updated"))
    frames += new TextDecoder().decode((await reader.read()).value);
  expect(maximum).toBe(1);
  expect(calls).toBe(3);
  expect(frames).toContain("query.snapshot");
  expect(frames).toContain('"_id":"3"');
  await reader.cancel();
  expect(realtime.getConnectionCount()).toBe(0);
});
it("rejects oversized initial results and emits an explicit error for oversized refreshes", async () => {
  const realtime = new RealtimeServer();
  const result = { data: [{ text: "x".repeat(1_000_001) }], nextCursor: null };
  const initial = await eventStream(request(), {
    realtime,
    logger: createLogger(),
    query: async () => ({ ok: true, result }),
  });
  expect(initial.status).toBe(413);
  expect(realtime.getConnectionCount()).toBe(0);
  let large = false;
  const response = await eventStream(request(), {
    realtime,
    logger: createLogger(),
    query: async () => ({
      ok: true,
      result: large ? result : { data: [], nextCursor: null },
    }),
  });
  const reader = response.body!.getReader();
  let frames = "";
  while (!frames.includes("query.snapshot"))
    frames += new TextDecoder().decode((await reader.read()).value);
  large = true;
  realtime.broadcast(event);
  frames = new TextDecoder().decode((await reader.read()).value);
  expect(frames).toContain("PAYLOAD_TOO_LARGE");
  expect((await reader.read()).done).toBe(true);
  expect(realtime.getConnectionCount()).toBe(0);
});
