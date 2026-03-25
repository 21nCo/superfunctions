import { BadRequestError } from './errors.js';
import type { CookieSameSite, HttpRouteMeta, SetCookieInput } from './types.js';

const VALID_SAME_SITE_VALUES: ReadonlySet<CookieSameSite> = new Set(['lax', 'strict', 'none']);

function normalizeSameSite(value: CookieSameSite | undefined): CookieSameSite {
  const normalized = value ?? 'lax';
  if (!VALID_SAME_SITE_VALUES.has(normalized)) {
    throw new BadRequestError('Invalid SameSite value', 'HTTP_META_INVALID');
  }
  return normalized;
}

function titleCaseSameSite(value: CookieSameSite): string {
  switch (value) {
    case 'lax':
      return 'Lax';
    case 'strict':
      return 'Strict';
    case 'none':
      return 'None';
  }
}

/**
 * Parse a Cookie header into a deterministic key/value map.
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}

/**
 * Parse cookies from a Web Request.
 */
export function parseCookies(request: Request): Record<string, string> {
  return parseCookieHeader(request.headers.get('cookie'));
}

/**
 * Serialize a Set-Cookie header value.
 */
export function serializeSetCookie(input: SetCookieInput): string {
  if (!input.name || input.name.trim().length === 0) {
    throw new BadRequestError('Cookie name is required', 'HTTP_META_INVALID');
  }

  const sameSite = normalizeSameSite(input.sameSite);
  const parts = [`${input.name}=${encodeURIComponent(input.value)}`];

  parts.push(`Path=${input.path ?? '/'}`);

  if (input.domain) {
    parts.push(`Domain=${input.domain}`);
  }

  if (typeof input.maxAge === 'number') {
    parts.push(`Max-Age=${Math.trunc(input.maxAge)}`);
  }

  if (input.expires) {
    parts.push(`Expires=${input.expires.toUTCString()}`);
  }

  if (input.secure ?? true) {
    parts.push('Secure');
  }

  if (input.httpOnly ?? true) {
    parts.push('HttpOnly');
  }

  parts.push(`SameSite=${titleCaseSameSite(sameSite)}`);

  return parts.join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime validator for route metadata intended for shared auth/OpenAPI usage.
 */
export function assertValidRouteMeta(value: unknown): asserts value is HttpRouteMeta {
  if (!isRecord(value)) {
    throw new BadRequestError('Route metadata must be an object', 'HTTP_META_INVALID');
  }

  if (value.auth !== undefined) {
    if (!isRecord(value.auth)) {
      throw new BadRequestError('Route auth metadata must be an object', 'HTTP_META_INVALID');
    }
    const mode = value.auth.mode;
    if (mode !== undefined && !['none', 'cookie-session', 'bearer', 'hybrid'].includes(String(mode))) {
      throw new BadRequestError('Invalid auth route metadata mode', 'HTTP_META_INVALID');
    }
  }

  if (value.openapi !== undefined && !isRecord(value.openapi)) {
    throw new BadRequestError('Route OpenAPI metadata must be an object', 'HTTP_META_INVALID');
  }
}
