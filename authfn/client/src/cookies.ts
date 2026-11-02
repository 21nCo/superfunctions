/**
 * Reads cookies from the browser document when one is available.
 */
export function defaultCookieAccessor(): string | undefined {
  const documentLike = globalThis.document as { cookie?: string } | undefined;
  return documentLike?.cookie;
}

/**
 * Infers the AuthFn cookie prefix from readable cookie names. The session
 * cookie is usually HttpOnly, so the `<prefix>.csrf` cookie is also used.
 * Returns the single prefix found, `authfn` when no AuthFn cookie is visible
 * or when `authfn` is among several, and undefined when several other prefixes
 * are visible and the right one cannot be told apart.
 */
export function readCookiePrefix(cookieHeader: string | undefined): string | undefined {
  const prefixes = new Set<string>();
  for (const part of (cookieHeader ?? '').split(';')) {
    const [rawName] = part.trim().split('=');
    const name = rawName.startsWith('__Secure-') ? rawName.slice('__Secure-'.length) : rawName;
    for (const suffix of ['.session', '.csrf']) {
      if (name.endsWith(suffix) && name.length > suffix.length) {
        prefixes.add(name.slice(0, -suffix.length));
      }
    }
  }
  if (prefixes.size === 0) {
    return 'authfn';
  }
  if (prefixes.size === 1) {
    return [...prefixes][0];
  }
  return prefixes.has('authfn') ? 'authfn' : undefined;
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
  if (!prefix) {
    return undefined;
  }
  return readCookieValue(cookieHeader, `${prefix}.csrf`) || undefined;
}
