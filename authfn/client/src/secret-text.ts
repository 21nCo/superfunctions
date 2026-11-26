/**
 * The one check for whether text repeats a one-time secret (a handoff code or
 * verifier), shared by the sensitive request path and the browser handoff.
 */

/** A reported value may not repeat this many consecutive characters of a secret. */
export const SECRET_WINDOW = 8;

/** A check a reported value must pass: a pattern it matches or a predicate. */
export type TextCheck = RegExp | ((value: string) => boolean);

/** `value` when it is a string that passes `check` and shares no text with `secrets`. */
export function safeText(value: unknown, check: TextCheck, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !(typeof check === 'function' ? check(value) : check.test(value))) {
    return undefined;
  }
  return secrets.some((secret) => sharesText(value, secret)) ? undefined : value;
}

/**
 * Whether `value` contains `secret`, or any run of `SECRET_WINDOW` of its
 * characters, as written or percent-decoded up to `DECODE_PASSES` times.
 */
export function sharesText(value: string, secret: string): boolean {
  const forms = decodedForms(value);
  if (secret.length <= SECRET_WINDOW) {
    return secret.length > 0 && forms.some((form) => form.includes(secret));
  }
  for (let index = 0; index + SECRET_WINDOW <= secret.length; index += 1) {
    const run = secret.slice(index, index + SECRET_WINDOW);
    if (forms.some((form) => form.includes(run))) {
      return true;
    }
  }
  return false;
}

const DECODE_PASSES = 3;

/** `value` and its percent-decoded forms, until decoding changes nothing. */
function decodedForms(value: string): string[] {
  const forms = [value];
  for (let pass = 0; pass < DECODE_PASSES; pass += 1) {
    // Never throws: a `%` without two hex digits stays as it is, and bytes
    // that are not UTF-8 become U+FFFD.
    const decoded = forms[pass]!.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escapes) => new TextDecoder().decode(
      Uint8Array.from(escapes.slice(1).split('%'), (hex) => Number.parseInt(hex, 16))
    ));
    if (decoded === forms[pass]) {
      break;
    }
    forms.push(decoded);
  }
  return forms;
}

/**
 * Whether any string in `value`, keys included, at any depth, shares text
 * with `secrets`. A value that cannot be walked counts as sharing.
 */
export function repeatsSecret(value: unknown, secrets: readonly string[]): boolean {
  const seen = new Set<object>();
  const visit = (current: unknown): boolean => {
    if (typeof current === 'string') {
      return secrets.some((secret) => sharesText(current, secret));
    }
    if (!current || typeof current !== 'object' || seen.has(current)) {
      return false;
    }
    seen.add(current);
    return Object.entries(current).some(([key, item]) => visit(key) || visit(item));
  };
  try {
    return visit(value);
  } catch {
    return true;
  }
}

/** Every non-empty string value in a JSON request body. */
export function collectBodyStrings(body: unknown, found: string[] = []): string[] {
  if (typeof body === 'string') {
    if (body.length > 0) {
      found.push(body);
    }
  } else if (body && typeof body === 'object') {
    for (const value of Object.values(body)) {
      collectBodyStrings(value, found);
    }
  }
  return found;
}
