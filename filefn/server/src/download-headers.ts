/**
 * Response headers for bytes FileFn serves itself (proxy downloads of files,
 * share links and artifacts). The stored content type is whatever the uploader
 * declared, so only types a browser cannot run script from are served inline;
 * everything else is a download, with `nosniff` and a sandboxing CSP on every
 * response.
 */

/**
 * Content types served inline. None of them can run script in the page's
 * origin: raster images, PDF (rendered by the browser's own viewer), plain
 * text, and common audio and video.
 */
export const INLINE_SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TOKEN_CHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;

interface ParsedMediaType {
  essence: string;
  parameters: Map<string, string>;
}

/**
 * Parses one media type as RFC 9110 defines it: `type/subtype` tokens, then
 * `; name=value` parameters whose value is a token or a quoted-string
 * (quoted text and quoted pairs limited to tab and visible ASCII). Anything
 * else (a list, control characters, non-ASCII, stray text) returns null, so
 * the caller treats it as unsafe.
 */
function parseMediaType(value: string | null | undefined): ParsedMediaType | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  const slash = input.indexOf('/');
  const semicolon = input.indexOf(';');
  const typeEnd = semicolon === -1 ? input.length : semicolon;
  if (slash <= 0 || slash > typeEnd) return null;
  const type = input.slice(0, slash);
  const subtype = input.slice(slash + 1, typeEnd).replace(/[ \t]+$/, '');
  if (!TOKEN.test(type) || !TOKEN.test(subtype)) return null;
  const parameters = new Map<string, string>();
  let i = typeEnd;
  while (i < input.length) {
    if (input[i] !== ';') return null;
    i += 1;
    while (input[i] === ' ' || input[i] === '\t') i += 1;
    // RFC 9110 allows empty parameter slots (`image/png;`, `a/b;;c=d`).
    if (i >= input.length || input[i] === ';') continue;
    const nameStart = i;
    while (i < input.length && TOKEN_CHAR.test(input[i])) i += 1;
    const name = input.slice(nameStart, i).toLowerCase();
    if (!name || input[i] !== '=') return null;
    i += 1;
    let parsedValue = '';
    if (input[i] === '"') {
      i += 1;
      let closed = false;
      while (i < input.length) {
        const code = input.charCodeAt(i);
        if (input[i] === '"') { closed = true; i += 1; break; }
        if (input[i] === '\\') {
          const next = input.charCodeAt(i + 1);
          if (!(next === 0x09 || (next >= 0x20 && next <= 0x7e))) return null;
          parsedValue += input[i + 1];
          i += 2;
          continue;
        }
        if (!(code === 0x09 || (code >= 0x20 && code <= 0x7e))) return null;
        parsedValue += input[i];
        i += 1;
      }
      if (!closed) return null;
    } else {
      const valueStart = i;
      while (i < input.length && TOKEN_CHAR.test(input[i])) i += 1;
      parsedValue = input.slice(valueStart, i);
      if (!parsedValue) return null;
    }
    while (input[i] === ' ' || input[i] === '\t') i += 1;
    if (!parameters.has(name)) parameters.set(name, parsedValue);
  }
  const essence = `${type}/${subtype}`.toLowerCase();
  return { essence: MIME_ALIASES[essence] ?? essence, parameters };
}

/** Whether the value is one well-formed media type. */
function isSingleMediaType(contentType: string | null | undefined): contentType is string {
  return parseMediaType(contentType) !== null;
}

// Common aliases of inline-safe types, mapped to their registered names.
const MIME_ALIASES: Record<string, string> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'image/jpg': 'image/jpeg',
};

/** The MIME type without parameters, lower-cased, aliases resolved: `Text/HTML; charset=x` -> `text/html`. */
export function contentTypeEssence(contentType: string | null | undefined): string {
  const essence = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  return Object.hasOwn(MIME_ALIASES, essence) ? MIME_ALIASES[essence]! : essence;
}

/**
 * The header value for an inline-safe type: its essence, plus the charset of a
 * text/plain type (needed to decode it), when the charset is a plain token.
 */
function safeInlineType(contentType: string): string {
  const parsed = parseMediaType(contentType);
  if (!parsed) return 'application/octet-stream';
  if (parsed.essence === 'text/plain') {
    const charset = parsed.parameters.get('charset');
    if (charset && /^[\x20-\x7e]{1,40}$/.test(charset)) {
      // A token charset as is; any other printable label (e.g. iso_8859-2:1987) quoted.
      const label = charset.toLowerCase();
      return /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(label)
        ? `text/plain; charset=${label}`
        : `text/plain; charset="${label.replace(/["\\]/g, '\\$&')}"`;
    }
  }
  return parsed.essence;
}

export function isInlineSafeContentType(contentType: string | null | undefined): boolean {
  const parsed = parseMediaType(contentType);
  return parsed !== null && INLINE_SAFE_CONTENT_TYPES.has(parsed.essence);
}

// The PDF viewers in Chromium and Firefox refuse to render a document whose
// CSP includes `sandbox`, so PDF gets a CSP without it; the viewer runs the
// document outside the page's origin either way.
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const PDF_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'";

function asciiFallbackFileName(fileName: string): string {
  // Quoted-string form for old clients: printable ASCII only, no quotes or backslashes.
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim();
  return ascii.length > 0 ? ascii : 'download';
}

/** `Content-Disposition` value: RFC 6266 with an RFC 5987 `filename*` for non-ASCII names. */
/** Largest Content-Disposition value FileFn sends, so proxies with small header limits pass it. */
export const MAX_CONTENT_DISPOSITION_LENGTH = 512;

function dispositionValue(type: 'inline' | 'attachment', fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${asciiFallbackFileName(fileName)}"; filename*=UTF-8''${encoded}`;
}

/**
 * `Content-Disposition` value: RFC 6266 with an RFC 5987 `filename*` for
 * non-ASCII names. A name whose header would exceed
 * MAX_CONTENT_DISPOSITION_LENGTH is shortened at code-point boundaries,
 * keeping a short extension.
 */
export function contentDisposition(type: 'inline' | 'attachment', fileName?: string | null): string {
  if (!fileName) {
    return type;
  }
  // encodeURIComponent throws on a lone surrogate; replace it with U+FFFD.
  const wellFormed = fileName.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  const value = dispositionValue(type, wellFormed);
  if (value.length <= MAX_CONTENT_DISPOSITION_LENGTH) return value;
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(wellFormed)?.[0] ?? '';
  // Every code point costs at least one byte of the value, so a longer stem
  // than the budget never fits; then binary-search the longest stem that does.
  const stem = Array.from(wellFormed.slice(0, wellFormed.length - extension.length)).slice(0, MAX_CONTENT_DISPOSITION_LENGTH);
  let low = 0;
  let high = stem.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (dispositionValue(type, stem.slice(0, mid).join('') + extension).length <= MAX_CONTENT_DISPOSITION_LENGTH) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low === 0) return dispositionValue(type, extension || 'download');
  return dispositionValue(type, stem.slice(0, low).join('') + extension);
}

export interface DownloadHeadersInput {
  contentType: string;
  size: number;
  fileName?: string | null;
}

/** Headers for a proxied download: safe types inline, all others as an attachment. */
export function buildDownloadHeaders(input: DownloadHeadersInput): Record<string, string> {
  const inline = isInlineSafeContentType(input.contentType);
  const essence = contentTypeEssence(input.contentType);
  return {
    // A safe type is sent as its normalised essence; an unsafe but well-formed
    // type is still labelled as declared (the attachment disposition, nosniff
    // and the sandbox keep a browser from rendering it); anything ambiguous is
    // octet-stream.
    'Content-Type': inline ? safeInlineType(input.contentType) : isSingleMediaType(input.contentType) ? input.contentType.trim() : 'application/octet-stream',
    'Content-Length': input.size.toString(),
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', input.fileName),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': inline && essence === 'application/pdf' ? PDF_CSP : SANDBOX_CSP,
  };
}

/**
 * Extra `signDownloadUrl` input for a stored object: a safe type is signed with
 * its own essence, any other with `application/octet-stream`, so a storage
 * domain related to the app never renders an uploader's HTML or SVG.
 */
export function signedDownloadConstraints(
  contentType: string | null | undefined,
): { constraints: { responseContentType: string } } {
  // Always explicit: with dedup a version can point at an object stored earlier
  // under another (possibly unsafe) type, so the object's own type is never used.
  return {
    constraints: {
      responseContentType: isInlineSafeContentType(contentType) ? safeInlineType(contentType as string) : 'application/octet-stream',
    },
  };
}
