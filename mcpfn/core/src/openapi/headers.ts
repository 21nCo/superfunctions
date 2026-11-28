// D9: credentials and transport headers are the executor's job, never inputs.
// OpenAPI itself says Accept, Content-Type and Authorization header parameters
// SHALL be ignored.
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "accept",
  "content-type",
]);

/** A header name no tool input may set (D9): `fromOpenAPI` never exposes it and `httpExecutor` drops it. */
export function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-");
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Whether `name` is an HTTP token (RFC 9110), as a header or cookie name must be. */
export function isHttpToken(name: string): boolean {
  return TOKEN.test(name);
}
