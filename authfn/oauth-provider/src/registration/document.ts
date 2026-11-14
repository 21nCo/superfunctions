/** A metadata document fetch, headers and body together, must finish within 5 seconds. */
export const METADATA_DOCUMENT_TIMEOUT_MS = 5000;
/** A metadata document may be at most 64 KB. */
export const METADATA_DOCUMENT_MAX_BYTES = 64 * 1024;
/** Stored `client_id` values are at most 255 characters. */
const MAX_CLIENT_ID_LENGTH = 255;

/** Names that only resolve inside a host or private network. */
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa'];

/**
 * A `client_id` that names a Client ID Metadata Document: an `https` URL with
 * a path, no query, fragment or credentials, written in its normalized form
 * (so no dot segments, default port or uppercase host), at most 255
 * characters. The host must be a public DNS name: IP literals, single-label
 * names and internal suffixes such as `localhost` and `.internal` are refused
 * before any request is made.
 */
export function isMetadataDocumentClientId(value: string): boolean {
  if (value.length > MAX_CLIENT_ID_LENGTH || !value.startsWith('https://')) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname;
  return url.href === value && url.pathname !== '/' && url.search === '' && url.hash === '' &&
    url.username === '' && url.password === '' &&
    host.includes('.') && !host.endsWith('.') && !host.startsWith('[') && !/^[\d.]+$/.test(host) &&
    !INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Reads at most `maxBytes` from `reader` as UTF-8; null when the stream is
 * longer, after cancelling it. Invalid UTF-8 throws.
 */
export async function readCappedText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number
): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** A declared `content-length` over `maxBytes`. */
export function declaresMoreThan(headers: Headers, maxBytes: number): boolean {
  const declared = headers.get('content-length');
  return declared !== null && !(Number(declared) <= maxBytes);
}

/**
 * The outcome of a metadata document fetch: the parsed document; `invalid`
 * when the host answered with something that is not a document (a redirect,
 * a status other than 200, more than 64 KB, declared or streamed, or not
 * JSON); or `unavailable` when it gave no usable answer (a network error, no
 * complete answer within 5 seconds, a 5xx, 408 or 429).
 */
export type MetadataDocumentFetch = { status: 'ok'; document: unknown } | { status: 'invalid' | 'unavailable' };

const TRANSIENT_STATUSES = new Set([408, 429]);

/**
 * Fetches and parses the metadata document at `url` without following
 * redirects. The 5-second deadline covers the body as well as the headers and
 * holds even if `fetchImpl` ignores the abort signal; the request and body are
 * cancelled when it passes.
 */
export async function fetchMetadataDocument(fetchImpl: typeof fetch, url: string): Promise<MetadataDocumentFetch> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reader?.cancel().catch(() => undefined);
      reject(new Error('Client metadata document timed out'));
    }, METADATA_DOCUMENT_TIMEOUT_MS);
  });
  const work = (async (): Promise<MetadataDocumentFetch | string> => {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // Not 'error', which Cloudflare Workers reject; a 3xx answer is refused below.
      redirect: 'manual',
      signal: controller.signal
    });
    if (controller.signal.aborted || response.status !== 200 || response.redirected || !response.body ||
      declaresMoreThan(response.headers, METADATA_DOCUMENT_MAX_BYTES)) {
      await response.body?.cancel().catch(() => undefined);
      const transient = controller.signal.aborted || response.status >= 500 || TRANSIENT_STATUSES.has(response.status);
      return { status: transient ? 'unavailable' : 'invalid' };
    }
    reader = response.body.getReader();
    const text = await readCappedText(reader, METADATA_DOCUMENT_MAX_BYTES);
    return text === null ? { status: 'invalid' } : text;
  })();
  let outcome: MetadataDocumentFetch | string;
  try {
    outcome = await Promise.race([work, deadline]);
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
    // Settle the abandoned branch quietly and release the connection.
    work.catch(() => undefined);
    controller.abort();
  }
  if (typeof outcome !== 'string') {
    return outcome;
  }
  try {
    return { status: 'ok', document: JSON.parse(outcome) as unknown };
  } catch {
    return { status: 'invalid' };
  }
}
