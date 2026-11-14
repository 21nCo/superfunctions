import { randomBytes } from 'node:crypto';
import { AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH, type AuthFnRuntimeConfig, type AuthFnSchemaDefinition } from 'authfn';
import { hashSecret } from 'authfn/core/sessions';
import { claimIfUnset } from '../store.js';

interface DeviceStore {
  database: AuthFnRuntimeConfig['database'];
  namespace?: string;
}

export const DEVICE_CODE_MODEL = 'oauth_provider_device_codes';
/** The record ID prefix; tokens issued for a device code name it as their source. */
export const DEVICE_CODE_ID_PREFIX = 'odv';

/** Device codes and user codes are valid for 10 minutes. */
export const OAUTH_DEVICE_CODE_TTL_SECONDS = 10 * 60;
/** The minimum seconds between polls; each `slow_down` adds 5 for that device code (RFC 8628 3.5). */
export const OAUTH_DEVICE_POLL_INTERVAL_SECONDS = 5;

/**
 * Consonants without vowels or look-alikes (RFC 8628 6.1): no word can be
 * spelled, and nothing is confused with `0`, `1`, `I` or `O`. 20^8 is about
 * 2.6 * 10^10 codes.
 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;

export function createDeviceSchema(): AuthFnSchemaDefinition['schemas'] {
  const ref = (fieldName: string) => ({ type: 'string', required: true, fieldName, maxLength: 255 }) as const;
  const optionalRef = (fieldName: string) => ({ type: 'string', required: false, fieldName, maxLength: 255 }) as const;
  const date = (fieldName: string, required = true) => ({ type: 'date', required, fieldName }) as const;
  return [{
    modelName: DEVICE_CODE_MODEL,
    fields: {
      id: ref('id'),
      deviceCodeHash: ref('device_code_hash'),
      userCodeHash: ref('user_code_hash'),
      clientId: ref('client_id'),
      resource: { type: 'string', required: true, fieldName: 'resource' },
      scopes: { type: 'json', required: true, fieldName: 'scopes' },
      expiresAt: date('expires_at'),
      // Seconds the client must wait between polls; grows with each slow_down.
      interval: { type: 'number', required: true, fieldName: 'interval' },
      // `<poll time, 16-digit ms>:<random>` of the last admitted poll.
      pollClaim: { type: 'string', required: true, fieldName: 'poll_claim', maxLength: 64 },
      // Set once by the user's approval or denial, with the claim that set it.
      decisionClaimId: { type: 'string', required: false, fieldName: 'decision_claim_id', maxLength: 64 },
      decision: { type: 'string', required: false, fieldName: 'decision', maxLength: 16 },
      decidedAt: date('decided_at', false),
      userId: { ...optionalRef('user_id'), maxLength: AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH },
      grantId: optionalRef('grant_id'),
      // Set once when the approved code is exchanged for tokens.
      consumedAt: date('consumed_at', false),
      // The exchange's claim: the tokens it commits record it.
      claimId: { type: 'string', required: false, fieldName: 'claim_id', maxLength: 64 },
      createdAt: date('created_at')
    },
    indexes: [
      { name: 'idx_authfn_oauth_provider_device_codes_device_code_hash', fields: ['deviceCodeHash'], unique: true },
      { name: 'idx_authfn_oauth_provider_device_codes_user_code_hash', fields: ['userCodeHash'], unique: true }
    ]
  }];
}

export type OAuthDeviceDecision = 'approved' | 'denied';

export interface DeviceCodeRecord {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
  interval: number;
  pollClaim: string;
  decisionClaimId?: string | null;
  decision?: OAuthDeviceDecision | null;
  decidedAt?: Date | null;
  userId?: string | null;
  grantId?: string | null;
  consumedAt?: Date | null;
  claimId?: string | null;
  createdAt: Date;
}

function namespace(store: DeviceStore): string {
  return store.namespace ?? 'authfn';
}

const eq = (field: string, value: string) => ({ field, operator: 'eq' as const, value });

/** Zero-padded so that the poll time can be read back from the claim. */
function pollClaimAt(ms: number): string {
  return `${String(Math.max(0, ms)).padStart(16, '0')}:${randomBytes(9).toString('hex')}`;
}

/** The time of the poll a claim admitted, in milliseconds (0 before the first poll). */
export function pollClaimTime(pollClaim: string): number {
  return Number(pollClaim.slice(0, 16));
}

/** A random user code, shown as `XXXX-XXXX`. */
export function createUserCode(): string {
  let code = '';
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of randomBytes(USER_CODE_LENGTH * 2)) {
      // 240 is the largest multiple of 20 below 256: rejecting the rest keeps every letter equally likely.
      if (byte < 240 && code.length < USER_CODE_LENGTH) {
        code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      }
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The canonical `XXXX-XXXX` form of a code the user typed: case, spaces and
 * dashes are ignored (RFC 8628 6.1). Null when it cannot be a user code.
 */
export function normalizeUserCode(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 64) {
    return null;
  }
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== USER_CODE_LENGTH || [...code].some((char) => !USER_CODE_ALPHABET.includes(char))) {
    return null;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Stores a pending device authorization and returns its codes. Only hashes
 * are stored. A user code already taken (by any stored row, which the unique
 * index enforces) is replaced with a fresh one, up to three tries.
 */
export async function createDeviceCode(
  store: DeviceStore,
  input: { clientId: string; resource: string; scopes: string[]; now: Date }
): Promise<{ deviceCode: string; userCode: string }> {
  const { now, ...shared } = input;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deviceCode = `odk_${randomBytes(32).toString('base64url')}`;
    const userCode = createUserCode();
    const record: DeviceCodeRecord = {
      ...shared,
      id: `${DEVICE_CODE_ID_PREFIX}_${randomBytes(12).toString('hex')}`,
      deviceCodeHash: hashSecret(deviceCode),
      userCodeHash: hashSecret(userCode),
      expiresAt: new Date(now.getTime() + OAUTH_DEVICE_CODE_TTL_SECONDS * 1000),
      interval: OAUTH_DEVICE_POLL_INTERVAL_SECONDS,
      pollClaim: pollClaimAt(0),
      decisionClaimId: null,
      decision: null,
      decidedAt: null,
      userId: null,
      grantId: null,
      consumedAt: null,
      claimId: null,
      createdAt: now
    };
    try {
      await store.database.create({ model: DEVICE_CODE_MODEL, data: { ...record }, namespace: namespace(store) });
      return { deviceCode, userCode };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function findDeviceCode(store: DeviceStore, deviceCode: string): Promise<DeviceCodeRecord | null> {
  return store.database.findOne<DeviceCodeRecord>({
    model: DEVICE_CODE_MODEL,
    where: [eq('deviceCodeHash', hashSecret(deviceCode))],
    namespace: namespace(store)
  });
}

/**
 * The device authorization a normalized user code names. Null when no row
 * or, where the adapter does not enforce the unique index, more than one
 * row has it: an ambiguous code is never decided.
 */
export async function findByUserCode(store: DeviceStore, userCode: string): Promise<DeviceCodeRecord | null> {
  const rows = await store.database.findMany<DeviceCodeRecord>({
    model: DEVICE_CODE_MODEL,
    where: [eq('userCodeHash', hashSecret(userCode))],
    limit: 2,
    namespace: namespace(store)
  });
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Admits one poll of `record` unless it comes within the current interval of
 * the last admitted one. A poll that is too fast adds 5 seconds to the
 * interval (RFC 8628 3.5) and also counts as the last poll, so a client that
 * keeps polling early keeps being slowed. The update is conditional on the
 * poll claim read with `record` and read back: of concurrent polls exactly
 * one is decided, the others are too fast.
 */
export async function admitPoll(store: DeviceStore, record: DeviceCodeRecord, now: Date): Promise<boolean> {
  const tooFast = now.getTime() - pollClaimTime(record.pollClaim) < record.interval * 1000;
  const pollClaim = pollClaimAt(now.getTime());
  await store.database.updateMany({
    model: DEVICE_CODE_MODEL,
    where: [eq('id', record.id), eq('pollClaim', record.pollClaim)],
    data: { pollClaim, interval: tooFast ? record.interval + OAUTH_DEVICE_POLL_INTERVAL_SECONDS : record.interval },
    namespace: namespace(store)
  });
  const stored = await store.database.findOne<DeviceCodeRecord>({
    model: DEVICE_CODE_MODEL,
    where: [eq('id', record.id)],
    namespace: namespace(store)
  });
  return !tooFast && stored?.pollClaim === pollClaim;
}

/**
 * Records the user's decision once; false when the code was already decided.
 * An approval stores the user and the grant created for it.
 */
export function claimDecision(
  store: DeviceStore,
  recordId: string,
  decision: { decision: OAuthDeviceDecision; userId: string; grantId?: string; now: Date }
): Promise<boolean> {
  const { now, grantId, ...rest } = decision;
  const data = { ...rest, grantId: grantId ?? null, decidedAt: now };
  return claimIfUnset(store, DEVICE_CODE_MODEL, recordId, ['decidedAt'], data, undefined, 'decisionClaimId');
}

/**
 * Spends an approved device code with `claimId`, which commits the tokens
 * staged under it; false when another exchange already did.
 */
export function claimDeviceCode(store: DeviceStore, recordId: string, now: Date, claimId: string): Promise<boolean> {
  return claimIfUnset(store, DEVICE_CODE_MODEL, recordId, ['consumedAt'], { consumedAt: now }, claimId);
}
