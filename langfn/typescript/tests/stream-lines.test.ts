import { expect, it } from "vitest";
import { type BodyErrorState, readStreamLines } from "../src/models/stream-lines.js";
it("decodes fragmented utf8 and an unterminated last line", async () => {
  const bytes = new TextEncoder().encode("é\r\nlast");
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    },
  });
  const lines = [];
  for await (const line of readStreamLines(body)) lines.push(line);
  expect(lines).toEqual(["é\r", "last"]);
  expect(body.locked).toBe(false);
});
it("cancels the upstream reader when budget enforcement stops consumption", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("usage\nmore\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const line of readStreamLines(body)) {
    expect(line).toBe("usage");
    break;
  }
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});
it("keeps the byte-limit error when cancelling the reader also fails", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x".repeat(32)));
    },
    cancel() {
      throw new Error("cancel failed");
    },
  });
  const read = async () => {
    for await (const _line of readStreamLines(body, 8)) {
      // drain
    }
  };
  await expect(read()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  expect(body.locked).toBe(false);
});
it("keeps the byte-limit error and releases the reader when cancel throws synchronously", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x".repeat(32)));
    },
  });
  const getReader = body.getReader.bind(body);
  let cancelCalls = 0;
  body.getReader = (() => {
    const reader = getReader();
    reader.cancel = () => {
      cancelCalls += 1;
      throw new Error("cancel failed synchronously");
    };
    return reader;
  }) as typeof body.getReader;
  const read = async () => {
    for await (const _line of readStreamLines(body, 8)) {
      // drain
    }
  };
  await expect(read()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  expect(cancelCalls).toBe(1);
  expect(body.locked).toBe(false);
});
it("does not wait for a reader cancel that never settles", async () => {
  const hanging = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
      },
      cancel: () => new Promise<void>(() => {}),
    });
  const tooLong = hanging("x".repeat(32));
  const read = async () => {
    for await (const _line of readStreamLines(tooLong, 8)) {
      // drain
    }
  };
  await expect(read()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  expect(tooLong.locked).toBe(false);

  const open = hanging("first\nsecond\n");
  for await (const line of readStreamLines(open)) {
    expect(line).toBe("first");
    break;
  }
  expect(open.locked).toBe(false);
});
it("splits on bare CR and CRLF across chunks only when asked", async () => {
  const chunks = ["a\r", "\nb\rc", "\r", "\n"];
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
  const lines: string[] = [];
  for await (const line of readStreamLines(stream(), 1024, { crLineBreaks: true })) lines.push(line);
  expect(lines).toEqual(["a", "b", "c"]);
  const lfOnly: string[] = [];
  for await (const line of readStreamLines(stream())) lfOnly.push(line);
  expect(lfOnly).toEqual(["a\r", "b\rc\r"]);
});
it("stops yielding buffered lines once the body errors, only when asked to", async () => {
  const failure = new Error("body failed");
  const run = async (bodyError?: BodyErrorState) => {
    let fail: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("a\nb\nc\n"));
        fail = () => c.error(failure);
      },
    });
    const lines: string[] = [];
    const outcome = await (async () => {
      for await (const line of readStreamLines(body, 1024, { bodyError })) {
        lines.push(line);
        if (line === "a") {
          fail?.();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    })().catch((caught: unknown) => caught);
    return { lines, outcome, locked: body.locked };
  };
  // By default the lines of a chunk already read are still delivered.
  expect(await run()).toEqual({ lines: ["a", "b", "c"], outcome: failure, locked: false });
  const state: BodyErrorState = {};
  expect(await run(state)).toEqual({ lines: ["a"], outcome: failure, locked: false });
  expect(state.failed).toEqual({ error: failure });
});
