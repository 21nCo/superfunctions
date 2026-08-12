export interface MdfnUrlPolicy {
  readonly allowedSchemes: readonly string[];
  readonly allowRelative: boolean;
  readonly allowProtocolRelative?: boolean;
}

export interface MdfnUrlInspection {
  readonly safe: boolean;
  readonly normalized: string;
  readonly scheme?: string;
  readonly reason?: "empty" | "control" | "backslash" | "protocol-relative" | "scheme";
}

function decodedForInspection(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Validate a URL without resolving it or losing the original Markdown value. */
export function inspectMdfnUrl(value: string, policy: MdfnUrlPolicy): MdfnUrlInspection {
  const normalized = value.trim();
  if (!normalized) return { safe: false, normalized, reason: "empty" };
  const inspected = decodedForInspection(normalized);
  if (/[\u0000-\u0020\u007f]/.test(inspected)) return { safe: false, normalized, reason: "control" };
  if (inspected.includes("\\")) return { safe: false, normalized, reason: "backslash" };
  if (inspected.startsWith("//")) {
    return { safe: policy.allowProtocolRelative === true, normalized, reason: policy.allowProtocolRelative ? undefined : "protocol-relative" };
  }
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(inspected);
  if (!match) return { safe: policy.allowRelative, normalized, reason: policy.allowRelative ? undefined : "scheme" };
  const scheme = match[1].toLowerCase();
  const safe = policy.allowedSchemes.some((allowed) => allowed.toLowerCase() === scheme);
  return { safe, normalized, scheme, reason: safe ? undefined : "scheme" };
}
