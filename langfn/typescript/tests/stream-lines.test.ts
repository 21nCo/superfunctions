import { expect, it } from "vitest";
import { readStreamLines } from "../src/models/stream-lines.js";
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
