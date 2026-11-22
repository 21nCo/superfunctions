/** Bounded reads of the contract documents `apifn check` compares. */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { MAX_SPEC_BYTES } from "./check-parse.js";
import { stateOf } from "./check-publish.js";
import type { FileState } from "./check-publish.js";

/** Total time allowed for an HTTP(S) base spec, response body included. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export class InputError extends Error {}

/**
 * Reads a regular file (symlinks followed) and the state it was read in; `text` is null when the
 * file is larger than MAX_SPEC_BYTES. Throws the filesystem error unchanged, so a caller can tell
 * a missing file (ENOENT).
 */
export function readBoundedFile(file: string): { text: string | null; state: FileState } {
  const fd = openSync(file, "r");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new InputError(`${file} is not a regular file`);
    }
    if (stats.size > MAX_SPEC_BYTES) {
      return { text: null, state: stateOf(stats) };
    }
    const buffer = Buffer.alloc(stats.size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > stats.size) {
        throw new InputError(`${file} grew while it was read`);
      }
    }
    return { text: buffer.subarray(0, length).toString("utf8"), state: stateOf(stats) };
  } finally {
    closeSync(fd);
  }
}

/** `--base-spec` names an HTTP(S) URL rather than a local file. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Fetches an HTTP(S) document of at most MAX_SPEC_BYTES. One deadline covers the request and
 * the whole body, so a server that stalls mid-body fails within `timeoutMs`.
 */
export async function fetchBounded(url: string, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
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
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof InputError)) {
      throw new InputError(`${url} did not respond completely within ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
