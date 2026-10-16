import { it, expect } from "vitest";
import { streamContentfnEvents } from "./realtime.js";
it("sends a CFQL query and decodes snapshots plus later authorization failure", async () => {
  const query = { dataset: "prod", types: ["post"] };
  let requested = "";
  const encoder = new TextEncoder();
  const fetcher: typeof fetch = async (input) => {
    requested = String(input);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              "data: " +
                JSON.stringify({
                  type: "event",
                  eventId: "1",
                  dataset: "prod",
                  timestamp: new Date().toISOString(),
                  eventType: "query.snapshot",
                  queryResult: { data: [], nextCursor: null },
                }) +
                "\n\n",
            ),
          );
          controller.enqueue(
            encoder.encode(
              "data: " +
                JSON.stringify({
                  type: "error",
                  code: "PERMISSION_DENIED",
                  message: "Access revoked",
                }) +
                "\n\n",
            ),
          );
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const stream = streamContentfnEvents(
    { baseUrl: "http://local", fetch: fetcher },
    { dataset: "prod", query },
  );
  expect((await stream.next()).value).toMatchObject({
    ok: true,
    result: { eventType: "query.snapshot", queryResult: { data: [] } },
  });
  expect(JSON.parse(new URL(requested).searchParams.get("query")!)).toEqual(
    query,
  );
  expect((await stream.next()).value).toMatchObject({
    ok: false,
    error: { code: "PERMISSION_DENIED" },
  });
  expect((await stream.next()).done).toBe(true);
});
