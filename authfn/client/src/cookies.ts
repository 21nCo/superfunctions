/**
 * Reads cookies from the browser document when one is available.
 */
export function defaultCookieAccessor(): string | undefined {
  const documentLike = globalThis.document as { cookie?: string } | undefined;
  return documentLike?.cookie;
}

/**
 * Infers the AuthFn cookie prefix from a readable session cookie name, falling
 * back to the default `authfn` prefix.
 */
export function readCookiePrefix(cookieHeader: string | undefined): string {
  if (!cookieHeader) {
    return 'authfn';
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName] = part.trim().split('=');
    if (rawName.startsWith('__Secure-') && rawName.endsWith('.session')) {
      return rawName.slice('__Secure-'.length, -'.session'.length);
    }
    if (rawName.endsWith('.session')) {
      return rawName.slice(0, -'.session'.length);
    }
  }

  return 'authfn';
}

/**
 * Returns the decoded value of a named cookie from a cookie header string.
 */
export function readCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...valueParts] = part.trim().split('=');
    if (rawName === name) {
      const rawValue = valueParts.join('=');
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }

  return undefined;
}

/**
 * Reads the AuthFn CSRF token that accompanies a cookie session.
 */
export function readCsrfToken(
  cookieAccessor: () => string | undefined,
  cookiePrefix: string | undefined,
): string | undefined {
  const cookieHeader = cookieAccessor();
  const prefix = cookiePrefix?.trim() || readCookiePrefix(cookieHeader);
  return readCookieValue(cookieHeader, `${prefix}.csrf`) || undefined;
}
