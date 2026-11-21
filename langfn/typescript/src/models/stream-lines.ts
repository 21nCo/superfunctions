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
  /**
   * Opt in to stopping at a body error: once the body errors (a transport timeout, a byte limit
   * crossed by a prefetched chunk, an abort), no further line is yielded, not even one from a
   * chunk already read, and the iterator rejects with that error. The error is also recorded
   * on this object so a consumer can stop events it already derived from earlier lines. By
   * default lines from a chunk already read are still yielded.
   */
  bodyError?: BodyErrorState;
}

/** Records the error a stream body failed with; see {@link ReadStreamLinesOptions.bodyError}. */
export interface BodyErrorState {
  failed?: { error: unknown };
}

/** Throw the recorded body error, if any. */
export function throwIfBodyFailed(state: BodyErrorState | undefined): void {
  if (state?.failed) throw state.failed.error;
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
  const watch = options.bodyError;
  // Releasing the lock rejects `closed` too; that is not a body error.
  let released = false;
  if (watch) {
    reader.closed.then(undefined, (error: unknown) => {
      if (!released && !watch.failed) watch.failed = { error };
    });
  }
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
        throwIfBodyFailed(watch);
        yield buffer.slice(0, -1);
        throwIfBodyFailed(watch);
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
    if (buffer) {
      throwIfBodyFailed(watch);
      yield buffer;
    }
  } finally {
    cancelWithoutWaiting(reader);
    released = true;
    reader.releaseLock();
  }
}

/**
 * Cancel without waiting: a cancel that never settles must not withhold the error, the
 * completion or the early return that ended the read, and its rejection must not replace them.
 * A reader whose cancel throws is still released by the caller.
 */
function cancelWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  // The executor runs now, before the caller releases the lock, and turns a synchronous throw
  // into a rejection, which is dropped like any other.
  new Promise<void>((resolve) => resolve(reader.cancel())).catch(() => undefined);
}
