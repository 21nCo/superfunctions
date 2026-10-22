import type { DefaultRedactionOptions } from "../types.js";
import { sanitizeValue } from "../validation.js";

const secretKeys = new Set([
  "apikey", "xapikey", "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "xauthtoken",
  "password", "passwd", "pwd", "secret", "clientsecret", "privatekey", "credentials",
  "authorization", "proxyauthorization", "cookie", "setcookie", "userid", "tenantid",
]);
const patterns = [
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/gi,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi,
  /(["']?)\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|authorization|proxy-authorization|cookie|set-cookie)\1\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];
const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Immutable policy; only explicitly named primitive leaves may bypass masking. */
export function defaultRedactor(options: DefaultRedactionOptions = {}): (input: unknown) => unknown {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
    (options.allowlist !== undefined && (!Array.isArray(options.allowlist) || options.allowlist.some(path =>
      typeof path !== "string" || !path.startsWith("/") || /~(?:[^01]|$)/.test(path))))) {
    throw new TypeError("Redaction allowlist must contain absolute JSON Pointer paths");
  }
  const allowlist = new Set(options.allowlist ?? []);
  const visit = (value: unknown, path: string, key?: string): unknown => {
    if (value === null || value === undefined) return value;
    const primitive = typeof value !== "object";
    if (primitive && allowlist.has(path)) return value;
    if (key !== undefined && secretKeys.has(key.replace(/[-_\s]/g, "").toLowerCase())) return "[redacted]";
    if (typeof value === "string") return patterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}/${index}`));
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) Object.defineProperty(result, name, {
        value: visit(child, `${path}/${escapePointer(name)}`, name), enumerable: true, configurable: true, writable: true,
      });
      return result;
    }
    return value;
  };
  // Getters, custom serialization objects, Errors, cycles and depth are normalized
  // before the terminal policy. Later serialization receives plain data only.
  return input => visit(sanitizeValue(input), "");
}
