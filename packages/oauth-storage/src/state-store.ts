import type { OAuthStateRecord, OAuthStateStore } from "./index.js";

export class OAuthStateStoreError extends Error {
  readonly code: "VALIDATION_ERROR" | "OAUTH_STATE_INVALID";

  constructor(code: "VALIDATION_ERROR" | "OAUTH_STATE_INVALID", message: string) {
    super(message);
    this.name = "OAuthStateStoreError";
    this.code = code;
  }
}

export function validateOAuthStateRecord(record: OAuthStateRecord): void {
  if (!record.stateId) {
    throw new OAuthStateStoreError("VALIDATION_ERROR", "stateId is required");
  }

  if (!record.tenantId || !record.userId || !record.providerId) {
    throw new OAuthStateStoreError("VALIDATION_ERROR", "tenantId, userId, and providerId are required");
  }

  if (!record.redirectUri) {
    throw new OAuthStateStoreError("VALIDATION_ERROR", "redirectUri is required");
  }

  if (!Array.isArray(record.requestedScopes)) {
    throw new OAuthStateStoreError("VALIDATION_ERROR", "requestedScopes must be an array");
  }

  assertIsoTimestamp("createdAt", record.createdAt);
  assertIsoTimestamp("expiresAt", record.expiresAt);

  if (record.consumedAt) {
    assertIsoTimestamp("consumedAt", record.consumedAt);
  }
}

export function isOAuthStateExpired(record: Pick<OAuthStateRecord, "expiresAt">, at: string): boolean {
  const expiresAt = parseIsoTimestamp("expiresAt", record.expiresAt);
  const checkpoint = parseIsoTimestamp("at", at);
  return expiresAt <= checkpoint;
}

export async function consumeOAuthState(
  store: OAuthStateStore,
  stateId: string,
  consumedAt: string
): Promise<OAuthStateRecord | null> {
  if (!stateId) {
    throw new OAuthStateStoreError("VALIDATION_ERROR", "stateId is required");
  }

  assertIsoTimestamp("consumedAt", consumedAt);
  const consumed = await store.consume(stateId, consumedAt);
  if (!consumed) {
    return null;
  }

  validateOAuthStateRecord(consumed);
  return cloneOAuthStateRecord(consumed);
}

export async function purgeExpiredOAuthStates(store: OAuthStateStore, before: string): Promise<number> {
  assertIsoTimestamp("before", before);
  return store.deleteExpired(before);
}

export function cloneOAuthStateRecord(record: OAuthStateRecord): OAuthStateRecord {
  return { ...record, requestedScopes: [...record.requestedScopes] };
}

function assertIsoTimestamp(fieldName: string, value: string): void {
  parseIsoTimestamp(fieldName, value);
}

function parseIsoTimestamp(fieldName: string, value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new OAuthStateStoreError("VALIDATION_ERROR", `${fieldName} must be a valid ISO-8601 timestamp`);
  }

  return timestamp;
}
