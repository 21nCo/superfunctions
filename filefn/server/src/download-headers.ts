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
  return { essence: `${type}/${subtype}`.toLowerCase(), parameters };
}

/** Whether the value is one well-formed media type. */
function isSingleMediaType(contentType: string | null | undefined): contentType is string {
  return parseMediaType(contentType) !== null;
}

/** The MIME type without parameters, lower-cased: `Text/HTML; charset=x` -> `text/html`. */
export function contentTypeEssence(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
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
    if (charset && /^[A-Za-z0-9._-]{1,40}$/.test(charset)) return `text/plain; charset=${charset.toLowerCase()}`;
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
export function contentDisposition(type: 'inline' | 'attachment', fileName?: string | null): string {
  if (!fileName) {
    return type;
  }
  // Keep the header small for proxies: at most 100 code points, keeping a
  // short extension.
  const codePoints = Array.from(fileName);
  if (codePoints.length > 100) {
    const extension = /\.[A-Za-z0-9]{1,10}$/.exec(fileName)?.[0] ?? '';
    fileName = codePoints.slice(0, 100 - extension.length).join('') + extension;
  }
  // encodeURIComponent throws on a lone surrogate; replace it with U+FFFD.
  fileName = fileName.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${asciiFallbackFileName(fileName)}"; filename*=UTF-8''${encoded}`;
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
