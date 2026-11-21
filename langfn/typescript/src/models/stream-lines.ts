import { LangFnError } from "../core/errors.js";

const LF = 10;
const CR = 13;

export interface ReadStreamLinesOptions {
  /**
   * Also end a line at a bare CR, and treat CRLF (even split across chunks) as one line end,
   * as server-sent events require. Lines then never contain CR. By default only LF ends a
   * line and a CRLF line keeps its trailing CR.
   */
  crLineBreaks?: boolean;
}

function findLineBreak(value: Uint8Array, start: number, crLineBreaks: boolean): number {
  if (!crLineBreaks) return value.indexOf(LF, start);
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === LF || value[index] === CR) return index;
  }
  return -1;
}

/** Decode bounded UTF-8 lines, including an unterminated final line. */
export async function* readStreamLines(
  body: ReadableStream<Uint8Array>,
  maxLineBytes = 1024 * 1024,
  options: ReadStreamLinesOptions = {},
): AsyncIterable<string> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 0) throw new RangeError("maxLineBytes must be a nonnegative safe integer");
  const crLineBreaks = options.crLineBreaks === true;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferedBytes = 0;
  // The previous chunk ended in CR, so an LF that starts this chunk completes that CRLF.
  let skipLeadingLf = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      if (skipLeadingLf && value.length) {
        skipLeadingLf = false;
        if (value[0] === LF) start = 1;
      }
      while (start < value.length) {
        const lineBreak = findLineBreak(value, start, crLineBreaks);
        const end = lineBreak === -1 ? value.length : lineBreak;
        bufferedBytes += end - start;
        if (bufferedBytes > maxLineBytes) throw new LangFnError("Provider stream line exceeds byte limit", { code: "RESPONSE_TOO_LARGE" });
        buffer += decoder.decode(value.subarray(start, end), { stream: true });
        if (lineBreak === -1) break;
        buffer += decoder.decode(value.subarray(lineBreak, lineBreak + 1), { stream: true });
        yield buffer.slice(0, -1);
        buffer = "";
        bufferedBytes = 0;
        start = lineBreak + 1;
        if (crLineBreaks && value[lineBreak] === CR) {
          if (start < value.length) {
            if (value[start] === LF) start += 1;
          } else {
            skipLeadingLf = true;
          }
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    // Cancel without waiting: a cancel that never settles must not withhold the error, the
    // completion or the early return that ended the read, and its rejection must not replace them.
    try {
      reader.cancel().catch(() => undefined);
    } catch {
      // A reader that cannot be cancelled is still released.
    }
    reader.releaseLock();
  }
}
