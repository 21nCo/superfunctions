/**
 * Preview token minting: short-lived, dataset/doc-bound, signed with server secret.
 */

import { createHmac } from "node:crypto";
import type { CmsfnPreviewTokenResult } from "@cmsfn/core";

const DEFAULT_TTL_SEC = 60 * 15; // 15 minutes
const TOKEN_SEP = ".";

export interface MintPreviewTokenConfig {
  /** Secret for HMAC signing; required for minting. */
  secret: string;
  /** Token TTL in seconds. */
  ttlSec?: number;
}

/**
 * Mint a preview token bound to dataset and docIds. Deterministic expiry from now + ttlSec.
 */
export function mintPreviewToken(
  config: MintPreviewTokenConfig,
  dataset: string,
  docIds: string[]
): CmsfnPreviewTokenResult {
  const ttlSec = config.ttlSec ?? DEFAULT_TTL_SEC;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = JSON.stringify({ dataset, docIds, exp });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", config.secret).update(payloadB64).digest("base64url");
  const token = `${payloadB64}${TOKEN_SEP}${sig}`;
  const expiresAt = new Date(exp * 1000).toISOString();
  return { token, expiresAt, dataset, docIds };
}

/**
 * Verify and decode a token. Returns payload or null if invalid/expired.
 */
export function verifyPreviewToken(
  secret: string,
  token: string
): { dataset: string; docIds: string[]; exp: number } | null {
  const i = token.indexOf(TOKEN_SEP);
  if (i <= 0) return null;
  const payloadB64 = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  if (sig !== expectedSig) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const o = payload as Record<string, unknown>;
  if (typeof o.dataset !== "string" || !Array.isArray(o.docIds) || typeof o.exp !== "number") return null;
  if (o.exp < Math.floor(Date.now() / 1000)) return null;
  return { dataset: o.dataset, docIds: o.docIds as string[], exp: o.exp };
}
