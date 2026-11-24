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

// One `type/subtype` of RFC 9110 tokens with optional parameters, and no comma
// anywhere: a comma-separated list is ambiguous (Fetch MIME sniffing may pick
// another entry than this code did), so it is never treated as safe.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = '"(?:[^"\\\\\\x00-\\x1f\\x7f]|\\\\.)*"';
const SINGLE_MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:[ \\t]*;[ \\t]*${TOKEN}=(?:${TOKEN}|${QUOTED}))*[ \\t]*$`);

/** Whether the value is one well-formed media type (no list, no control characters). */
function isSingleMediaType(contentType: string | null | undefined): contentType is string {
  // eslint-disable-next-line no-control-regex
  return typeof contentType === 'string' && SINGLE_MEDIA_TYPE.test(contentType.trim()) && !/[\u0000-\u001f\u007f]/.test(contentType);
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
  const essence = contentTypeEssence(contentType);
  if (essence === 'text/plain') {
    const charset = /;\s*charset\s*=\s*"?([A-Za-z0-9._-]{1,40})"?/i.exec(contentType)?.[1];
    if (charset) return `text/plain; charset=${charset.toLowerCase()}`;
  }
  return essence;
}

export function isInlineSafeContentType(contentType: string | null | undefined): boolean {
  return isSingleMediaType(contentType) && INLINE_SAFE_CONTENT_TYPES.has(contentTypeEssence(contentType));
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
