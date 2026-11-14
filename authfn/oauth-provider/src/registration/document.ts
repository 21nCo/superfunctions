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
 * Fetches and parses the metadata document at `url`; undefined when it cannot
 * be used: no 200 answer (redirects are not followed), more than 64 KB (declared or streamed),
 * invalid UTF-8 or JSON, or not finished within 5 seconds. The deadline covers
 * the body as well as the headers and holds even if `fetchImpl` ignores the
 * abort signal; the request and body are cancelled when it passes.
 */
export async function fetchMetadataDocument(fetchImpl: typeof fetch, url: string): Promise<unknown> {
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
  const work = (async () => {
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
      return undefined;
    }
    reader = response.body.getReader();
    const text = await readCappedText(reader, METADATA_DOCUMENT_MAX_BYTES);
    return text === null ? undefined : JSON.parse(text) as unknown;
  })();
  try {
    return await Promise.race([work, deadline]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    // Settle the abandoned branch quietly and release the connection.
    work.catch(() => undefined);
    controller.abort();
  }
}
