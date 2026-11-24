/** Bounded reads of the contract documents `apifn check` compares. */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { MAX_SPEC_BYTES } from "./check-parse.js";
import { stateOf } from "./check-publish.js";
import type { FileState } from "./check-publish.js";

/** Total time allowed for an HTTP(S) base spec, response body included. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export class InputError extends Error {}

/**
 * Decodes UTF-8 strictly: malformed bytes are an error, never U+FFFD replacement characters that
 * would let altered text reach the parser. A correctly encoded U+FFFD stays. Null when malformed.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Opened without blocking: a FIFO with no writer would otherwise hang the open itself, before the
 * regular-file check. O_NONBLOCK changes nothing for a regular file (Windows has no FIFOs).
 */
const READ_FLAGS = constants.O_NONBLOCK === undefined ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK;

/** Why a file read gave no text: larger than MAX_SPEC_BYTES, or not UTF-8. */
export type Unreadable = "too-large" | "not-utf8";

/**
 * Reads a regular file (symlinks followed) and the state it was read in; `text` is null, with the
 * reason in `unreadable`, when the file is larger than MAX_SPEC_BYTES or is not valid UTF-8.
 * Throws the filesystem error unchanged, so a caller can tell a missing file (ENOENT).
 */
export function readBoundedFile(file: string): { text: string | null; unreadable?: Unreadable; state: FileState } {
  const fd = openSync(file, READ_FLAGS);
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile()) {
      throw new InputError(`${file} is not a regular file`);
    }
    if (stats.size > BigInt(MAX_SPEC_BYTES)) {
      return { text: null, unreadable: "too-large", state: stateOf(stats) };
    }
    const size = Number(stats.size);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > size) {
        throw new InputError(`${file} grew while it was read`);
      }
    }
    const text = decodeUtf8(buffer.subarray(0, length));
    return text === null ? { text, unreadable: "not-utf8", state: stateOf(stats) } : { text, state: stateOf(stats) };
  } finally {
    closeSync(fd);
  }
}

/** The message for a file read that gave no text. */
export function unreadableMessage(reason: Unreadable): string {
  return reason === "too-large" ? `the file is larger than ${MAX_SPEC_BYTES} bytes` : "the file is not valid UTF-8";
}

/** `--base-spec` names an HTTP(S) URL rather than a local file. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Cancels a response body the run will not read, so its connection is released now. */
async function discard(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Already closed or aborted.
  }
}

/**
 * Fetches an HTTP(S) document of at most MAX_SPEC_BYTES of UTF-8. One deadline covers the request
 * and the whole body, so a server that stalls mid-body fails within `timeoutMs`; the body of an
 * error status is cancelled, not left open.
 */
export async function fetchBounded(url: string, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      controller.abort();
      await discard(response.body);
      throw new InputError(`HTTP ${response.status} fetching ${url}`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > MAX_SPEC_BYTES) {
          controller.abort();
          throw new InputError(`${url} is larger than ${MAX_SPEC_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
    }
    const text = decodeUtf8(Buffer.concat(chunks));
    if (text === null) throw new InputError(`${url} is not valid UTF-8`);
    return text;
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof InputError)) {
      throw new InputError(`${url} did not respond completely within ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
