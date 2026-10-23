import type { CursorPayload } from "@contentfn/core";

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.values) || payload.values.some((value: unknown) => value !== null && !["string", "number", "boolean"].includes(typeof value))) {
      return null;
    }
    if (payload.queryKey !== undefined && (typeof payload.queryKey !== "string" || !/^[a-f0-9]{64}$/.test(payload.queryKey))) return null;
    return payload as CursorPayload;
  } catch {
    return null;
  }
}
