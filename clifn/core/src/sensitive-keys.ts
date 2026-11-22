const SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|cookie|api[-_]?key|session[-_]?id|access[-_]?key|refresh[-_]?token)/i;

/** True for an object key whose value `redactValue` replaces with "[REDACTED]". */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
