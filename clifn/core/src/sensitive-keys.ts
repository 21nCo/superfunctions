const SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|cookie|api[-_]?key|session[-_]?id|access[-_]?key|refresh[-_]?token)/i;
/** Keys a result document also redacts: Docker's registry credentials variable (`DOCKER_AUTH_CONFIG`). */
const DOCUMENT_SENSITIVE_KEY_PATTERN = /docker[-_]?auth[-_]?config/i;

/** True for an object key whose value `redactValue` replaces with "[REDACTED]" (case-insensitive). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * True for an object key whose value a result document (`jsonStyle: 'document'`) prints as "[REDACTED]": every key
 * `isSensitiveKey` matches, and `DOCKER_AUTH_CONFIG` in any case and with `-`, `_` or no separator.
 */
export function isDocumentSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || DOCUMENT_SENSITIVE_KEY_PATTERN.test(key);
}
