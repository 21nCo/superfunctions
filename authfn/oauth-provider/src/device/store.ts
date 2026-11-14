import { randomBytes } from 'node:crypto';
import { AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH, type AuthFnRuntimeConfig, type AuthFnSchemaDefinition } from 'authfn';
import { hashSecret } from 'authfn/core/sessions';
import { claimIfUnset } from '../store.js';
import { OAUTH_REFRESH_TOKEN_TTL_SECONDS } from '../types.js';

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
      // When the row stops being needed, as 16-digit milliseconds compared as a
      // string in every adapter: the code's expiry, and once it is exchanged
      // the expiry of the tokens issued for it. Pruned a code lifetime later.
      pruneKey: { type: 'string', required: true, fieldName: 'prune_key', maxLength: 16 },
      // Seconds the client must wait between polls; grows with each slow_down.
      interval: { type: 'number', required: true, fieldName: 'interval' },
      // `<last poll time, 16-digit ms>:<IDs of the last committed polls>` (see admitPoll).
      pollClaim: { type: 'string', required: true, fieldName: 'poll_claim', maxLength: 255 },
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
      { name: 'idx_authfn_oauth_provider_device_codes_user_code_hash', fields: ['userCodeHash'], unique: true },
      { name: 'idx_authfn_oauth_provider_device_codes_prune_key', fields: ['pruneKey'] }
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
  pruneKey: string;
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

/** Zero-padded so that string order is time order in every adapter. */
function timeKey(ms: number): string {
  return String(Math.max(0, ms)).padStart(16, '0');
}

/** Polls whose commit a poll can still recognize after later polls committed. */
const POLL_HISTORY = 16;

function pollId(): string {
  return randomBytes(6).toString('hex');
}

/** The stored poll state: the last poll time and the IDs of the last committed polls, oldest first. */
function readPollClaim(pollClaim: string): { at: number; ids: string[] } {
  return { at: Number(pollClaim.slice(0, 16)), ids: pollClaim.slice(17).split(',') };
}

function writePollClaim(at: number, ids: string[]): string {
  return `${timeKey(at)}:${ids.slice(-POLL_HISTORY).join(',')}`;
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
 * are stored. When the insert throws, the row is read back by its device code:
 * an insert that committed before its acknowledgement was lost is returned.
 * Only a user code confirmed taken by another row (the unique index) is
 * replaced with a fresh one, up to three tries; any other failure is thrown.
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
    const expiresAt = new Date(now.getTime() + OAUTH_DEVICE_CODE_TTL_SECONDS * 1000);
    const record: DeviceCodeRecord = {
      ...shared,
      id: `${DEVICE_CODE_ID_PREFIX}_${randomBytes(12).toString('hex')}`,
      deviceCodeHash: hashSecret(deviceCode),
      userCodeHash: hashSecret(userCode),
      expiresAt,
      pruneKey: timeKey(expiresAt.getTime()),
      interval: OAUTH_DEVICE_POLL_INTERVAL_SECONDS,
      pollClaim: writePollClaim(0, [pollId()]),
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
      if ((await findBy(store, 'deviceCodeHash', record.deviceCodeHash))?.id === record.id) {
        return { deviceCode, userCode };
      }
      if (!(await findBy(store, 'userCodeHash', record.userCodeHash))) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function findBy(store: DeviceStore, field: 'deviceCodeHash' | 'userCodeHash', hash: string): Promise<DeviceCodeRecord | null> {
  return store.database.findOne<DeviceCodeRecord>({ model: DEVICE_CODE_MODEL, where: [eq(field, hash)], namespace: namespace(store) });
}

/**
 * Deletes device codes no longer needed for more than one code lifetime: one
 * never exchanged expired, or every token issued for an exchanged one did
 * (`pruneKey`). Tokens issued for a device code are valid only while its row
 * exists, so an exchanged row outlives them. The extra lifetime leaves a
 * request that read a code just before it expired time to finish.
 */
export async function pruneDeviceCodes(store: DeviceStore, now: Date): Promise<void> {
  await store.database.deleteMany({
    model: DEVICE_CODE_MODEL,
    where: [{ field: 'pruneKey', operator: 'lt', value: timeKey(now.getTime() - OAUTH_DEVICE_CODE_TTL_SECONDS * 1000) }],
    namespace: namespace(store)
  });
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

/** A poll still losing after this many rounds (more concurrent polls of one code) writes nothing. */
const POLL_ATTEMPTS = POLL_HISTORY;

/** `busy`: the poll lost every round to concurrent polls of the code and changed nothing. */
export type PollOutcome = 'admitted' | 'slow_down' | 'busy';

/**
 * Judges one poll of `record` against the last poll (RFC 8628 3.5). A poll
 * within the current interval is `slow_down`: it adds 5 seconds to the
 * interval and counts as the last poll, so a client that keeps polling early
 * keeps being slowed. The last poll time never moves backwards: a poll that
 * arrives with an earlier `now` than the stored one is too fast.
 *
 * Each poll has one outcome, stored once. Its update is conditional on the
 * poll state it read and appends its own ID to the IDs of the last committed
 * polls, then reads the row back. Its ID in that history means it committed,
 * even if later polls overwrote the state since; the state it read still in
 * the history without it means it lost to a concurrent poll, so it reads
 * again and is judged against the winner. Adapter row counts are not used.
 * Only when more than 16 polls committed between its write and its read-back
 * can it not tell; it then answers as judged, which can only leave the stored
 * interval below what the client applies, never above.
 */
export async function admitPoll(store: DeviceStore, record: DeviceCodeRecord, now: Date): Promise<PollOutcome> {
  const id = pollId();
  let current: DeviceCodeRecord | null = record;
  for (let attempt = 0; current && attempt < POLL_ATTEMPTS; attempt += 1) {
    const last = readPollClaim(current.pollClaim);
    const tooFast = now.getTime() - last.at < current.interval * 1000;
    const outcome = tooFast ? 'slow_down' : 'admitted';
    let writeError: { error: unknown } | undefined;
    try {
      await store.database.updateMany({
        model: DEVICE_CODE_MODEL,
        where: [eq('id', current.id), eq('pollClaim', current.pollClaim)],
        data: {
          pollClaim: writePollClaim(Math.max(now.getTime(), last.at), [...last.ids, id]),
          interval: tooFast ? current.interval + OAUTH_DEVICE_POLL_INTERVAL_SECONDS : current.interval
        },
        namespace: namespace(store)
      });
    } catch (error) {
      writeError = { error };
    }
    const stored: DeviceCodeRecord | null = await store.database.findOne<DeviceCodeRecord>({
      model: DEVICE_CODE_MODEL,
      where: [eq('id', current.id)],
      namespace: namespace(store)
    });
    const committed = stored ? readPollClaim(stored.pollClaim).ids : [];
    if (committed.includes(id) || (stored && !committed.includes(last.ids[last.ids.length - 1]))) {
      return outcome;
    }
    if (writeError) {
      throw writeError.error;
    }
    current = stored;
  }
  return 'busy';
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
 * staged under it, and keeps the row until they expire; false when another
 * exchange already did.
 */
export function claimDeviceCode(store: DeviceStore, recordId: string, now: Date, claimId: string): Promise<boolean> {
  // The tokens staged under `claimId` expire by then; the row backs them until it.
  const pruneKey = timeKey(now.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);
  return claimIfUnset(store, DEVICE_CODE_MODEL, recordId, ['consumedAt'], { consumedAt: now, pruneKey }, claimId);
}
