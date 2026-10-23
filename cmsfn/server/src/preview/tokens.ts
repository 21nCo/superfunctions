/** Short-lived HMAC tokens bound to trusted audience, dataset and documents. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { previewAudience, previewDocumentId, type CmsfnPreviewTokenResult } from 'cmsfn';
const DEFAULT_TTL_SEC = 900;
const MAX_TOKEN_BYTES = 128 * 1024;
export interface MintPreviewTokenConfig { secret: string; audience: string; ttlSec?: number }
export interface PreviewTokenScope { audience: string; dataset: string; docId: string }
export interface PreviewTokenClaims { version: 2; audience: string; dataset: string; docIds: string[]; exp: number }
export function validPreviewConfig(config: MintPreviewTokenConfig): boolean {
  const ttl = config.ttlSec ?? DEFAULT_TTL_SEC;
  return typeof config.secret === 'string' && Buffer.byteLength(config.secret) >= 32 && !!previewAudience(config.audience) && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= DEFAULT_TTL_SEC;
}
export function mintPreviewToken(config: MintPreviewTokenConfig, dataset: string, docIds: string[]): CmsfnPreviewTokenResult {
  if (!validPreviewConfig(config) || !dataset || docIds.length === 0 || docIds.length > 100 || docIds.some(id => !previewDocumentId(id))) throw Error('Invalid preview configuration or scope');
  const audience = previewAudience(config.audience)!;
  const normalized = [...new Set(docIds.map(id => previewDocumentId(id)!))].sort();
  const exp = Math.floor(Date.now() / 1000) + (config.ttlSec ?? DEFAULT_TTL_SEC);
  const payload: PreviewTokenClaims = { version: 2, audience, dataset, docIds: normalized, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${body}.${createHmac('sha256', config.secret).update(body).digest('base64url')}`;
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw Error('Preview scope is too large');
  return { token, expiresAt: new Date(exp * 1000).toISOString(), dataset, docIds: normalized, audience };
}
/** The target supplies its trusted audience and requested dataset/document scope. */
export function verifyPreviewToken(secret: string, token: string, expected: PreviewTokenScope): PreviewTokenClaims | null {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES || Buffer.byteLength(secret) < 32) return null;
    const parts = token.split('.'); if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    const [body, signature] = parts;
    const decoded = Buffer.from(body, 'base64url'); if (decoded.toString('base64url') !== body) return null;
    if (!timingSafeEqual(Buffer.from(signature, 'base64url'), createHmac('sha256', secret).update(body).digest())) return null;
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const claims = value as Record<string, unknown>;
    const audience = previewAudience(expected.audience), docId = previewDocumentId(expected.docId);
    if (!audience || !docId || claims.version !== 2 || claims.audience !== audience || claims.dataset !== expected.dataset || !Array.isArray(claims.docIds) || claims.docIds.length < 1 || claims.docIds.length > 100 || !claims.docIds.every(id => typeof id === 'string' && previewDocumentId(id) === id) || !claims.docIds.includes(docId) || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) || claims.exp > Math.floor(Date.now() / 1000) + DEFAULT_TTL_SEC) return null;
    return { version: 2, audience, dataset: expected.dataset, docIds: claims.docIds.filter((id): id is string => typeof id === 'string'), exp: claims.exp };
  } catch { return null; }
}
