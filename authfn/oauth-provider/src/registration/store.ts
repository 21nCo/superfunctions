import { randomBytes } from 'node:crypto';
import type { AuthFnRuntimeConfig, AuthFnSchemaDefinition } from 'authfn';
import { hashSecret } from 'authfn/core/sessions';

interface RegistrationStore {
  database: AuthFnRuntimeConfig['database'];
  namespace?: string;
}

const MODELS = {
  clients: 'oauth_provider_clients',
  documents: 'oauth_provider_document_clients',
  events: 'oauth_provider_registration_events'
} as const;

/** The `client_id` prefix of dynamically registered clients. */
export const REGISTERED_CLIENT_ID_PREFIX = 'ocd';

export function createRegistrationSchema(): AuthFnSchemaDefinition['schemas'] {
  const id = { type: 'string', required: true, fieldName: 'id', maxLength: 255 } as const;
  const createdAt = { type: 'date', required: true, fieldName: 'created_at' } as const;
  return [
    {
      modelName: MODELS.clients,
      fields: {
        id,
        name: { type: 'string', required: false, fieldName: 'name', maxLength: 255 },
        redirectUris: { type: 'json', required: true, fieldName: 'redirect_uris' },
        createdAt
      }
    },
    {
      // The last usable metadata document of each client_id URL, kept so a
      // known client keeps working when a refetch is refused or fails.
      modelName: MODELS.documents,
      fields: {
        id,
        name: { type: 'string', required: false, fieldName: 'name', maxLength: 255 },
        redirectUris: { type: 'json', required: true, fieldName: 'redirect_uris' },
        fetchedAt: { type: 'date', required: true, fieldName: 'fetched_at' },
        // `<claim time, 16-digit ms>:<random>` of the request allowed to refetch it.
        claimId: { type: 'string', required: true, fieldName: 'claim_id', maxLength: 64 }
      }
    },
    {
      // One row per admitted registration or first fetch of an unknown
      // metadata document client; rows older than the previous window are
      // pruned as new ones arrive.
      modelName: MODELS.events,
      fields: {
        id,
        kind: { type: 'string', required: true, fieldName: 'kind', maxLength: 16 },
        windowId: { type: 'string', required: true, fieldName: 'window_id', maxLength: 32 },
        ipKey: { type: 'string', required: true, fieldName: 'ip_key', maxLength: 64 },
        createdAt
      },
      indexes: [{ name: 'idx_authfn_oauth_provider_registration_events_window', fields: ['kind', 'windowId'] }]
    }
  ];
}

function namespace(store: RegistrationStore): string {
  return store.namespace ?? 'authfn';
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

const eq = (field: string, value: string) => ({ field, operator: 'eq' as const, value });

export interface RegisteredClientRecord {
  id: string;
  name?: string | null;
  redirectUris: string[];
  createdAt: Date;
}

export async function insertRegisteredClient(
  store: RegistrationStore,
  input: { name?: string; redirectUris: string[]; now: Date }
): Promise<RegisteredClientRecord> {
  const record: RegisteredClientRecord = {
    id: createIdentifier(REGISTERED_CLIENT_ID_PREFIX),
    name: input.name ?? null,
    redirectUris: input.redirectUris,
    createdAt: input.now
  };
  await store.database.create({ model: MODELS.clients, data: { ...record }, namespace: namespace(store) });
  return record;
}

export function findRegisteredClient(store: RegistrationStore, clientId: string): Promise<RegisteredClientRecord | null> {
  return store.database.findOne<RegisteredClientRecord>({
    model: MODELS.clients,
    where: [eq('id', clientId)],
    namespace: namespace(store)
  });
}

/** The last usable metadata document of a `client_id` URL (the record id). */
export interface DocumentClientRecord {
  id: string;
  name?: string | null;
  redirectUris: string[];
  fetchedAt: Date;
  claimId: string;
}

export function findDocumentClient(store: RegistrationStore, clientId: string): Promise<DocumentClientRecord | null> {
  return store.database.findOne<DocumentClientRecord>({
    model: MODELS.documents,
    where: [eq('id', clientId)],
    namespace: namespace(store)
  });
}

/** Zero-padded so that string order is time order in every adapter. */
function timeKey(ms: number): string {
  return String(Math.max(0, ms)).padStart(16, '0');
}

/** A refetch claim made at `now`, which sorts after every earlier claim. */
export function documentClaimId(now: Date): string {
  return `${timeKey(now.getTime())}:${randomBytes(9).toString('hex')}`;
}

/** The time a refetch claim was made, in milliseconds. */
export function documentClaimTime(claimId: string): number {
  return Number(claimId.slice(0, 16));
}

/**
 * Stores a newly fetched document and returns the stored row: this one, or
 * the row another request stored first from its own fetch, which is kept.
 * Row counts are never trusted: not every adapter reports them.
 */
export async function createDocumentClient(
  store: RegistrationStore,
  record: DocumentClientRecord
): Promise<DocumentClientRecord> {
  try {
    await store.database.create({ model: MODELS.documents, data: { ...record }, namespace: namespace(store) });
    return record;
  } catch (error) {
    const stored = await findDocumentClient(store, record.id);
    if (!stored) {
      throw error;
    }
    return stored;
  }
}

/**
 * Claims the refetch of a known client's document when no claim was made in
 * the `intervalMs` before `now`, so that across every instance the document
 * is refetched at most once per interval. The claim is a conditional update
 * read back: the caller whose claim ID is stored won and gets that ID.
 */
export async function claimDocumentRefetch(
  store: RegistrationStore,
  clientId: string,
  now: Date,
  intervalMs: number
): Promise<string | undefined> {
  const claimId = documentClaimId(now);
  await store.database.updateMany({
    model: MODELS.documents,
    // Claim times up to now - interval sort before this bound; later ones after it.
    where: [eq('id', clientId), { field: 'claimId', operator: 'lt', value: timeKey(now.getTime() - intervalMs + 1) }],
    data: { claimId },
    namespace: namespace(store)
  });
  return (await findDocumentClient(store, clientId))?.claimId === claimId ? claimId : undefined;
}

/**
 * Applies the result of the refetch claimed as `claimId`: the fetched
 * document, or `null` to drop the client. Only the current claim holder
 * writes; a refetch whose claim was superseded (it stalled past the
 * interval, or another instance's clock leads) changes nothing. Returns the
 * row stored afterwards, read back since row counts are never trusted:
 * this result when it applied, another claim's row, or `null` once dropped.
 */
export async function applyDocumentRefetch(
  store: RegistrationStore,
  clientId: string,
  claimId: string,
  document: Pick<DocumentClientRecord, 'name' | 'redirectUris' | 'fetchedAt'> | null
): Promise<DocumentClientRecord | null> {
  const where = [eq('id', clientId), eq('claimId', claimId)];
  await (document
    ? store.database.updateMany({ model: MODELS.documents, where, data: { ...document }, namespace: namespace(store) })
    : store.database.deleteMany({ model: MODELS.documents, where, namespace: namespace(store) }));
  return findDocumentClient(store, clientId);
}

export type RegistrationEventKind = 'register' | 'document';

/** No resolvable client IP: such events count only toward the global limit. */
const NO_IP = 'none';

/** Window ids are zero-padded so that string order is window order in every adapter. */
function windowIdOf(windowIndex: number): string {
  return String(windowIndex).padStart(16, '0');
}

export interface RegistrationLimits {
  perIp: number;
  global: number;
  windowSeconds: number;
}

/**
 * Admits one registration event of `kind` within fixed windows, or reports
 * the seconds until the window ends. The event is stored first and the window
 * counted after, so the event whose insert lands last sees every event
 * admitted before it: concurrent callers never admit more than the limits,
 * though at the boundary they can all refuse. A refused event is deleted, so
 * refusals do not use up the window.
 */
export async function admitRegistrationEvent(
  store: RegistrationStore,
  input: { kind: RegistrationEventKind; ip: string | undefined; now: Date; limits: RegistrationLimits }
): Promise<{ admitted: true } | { admitted: false; retryAfterSeconds: number }> {
  const { kind, ip, now, limits } = input;
  const windowMs = limits.windowSeconds * 1000;
  const windowIndex = Math.floor(now.getTime() / windowMs);
  const windowId = windowIdOf(windowIndex);
  const ipKey = ip === undefined ? NO_IP : hashSecret(ip);
  const id = createIdentifier('orv');
  const scope = { namespace: namespace(store) };
  await store.database.create({ model: MODELS.events, data: { id, kind, windowId, ipKey, createdAt: now }, ...scope });

  // Reads at most limit + 1 rows instead of `count`, which not every adapter supports.
  const exceeds = async (where: ReturnType<typeof eq>[], limit: number) =>
    (await store.database.findMany({ model: MODELS.events, where, limit: limit + 1, ...scope })).length > limit;
  const window = [eq('kind', kind), eq('windowId', windowId)];
  const overGlobal = await exceeds(window, limits.global);
  const overIp = !overGlobal && ip !== undefined && await exceeds([...window, eq('ipKey', ipKey)], limits.perIp);
  if (overGlobal || overIp) {
    await store.database.deleteMany({ model: MODELS.events, where: [eq('id', id)], ...scope });
    return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(((windowIndex + 1) * windowMs - now.getTime()) / 1000)) };
  }
  // Prune only windows before the previous one: a caller whose clock lags may
  // still be counting the previous window, and one whose clock leads (or a
  // request delayed across the rollover) a later one, which must stay intact.
  await store.database.deleteMany({
    model: MODELS.events,
    where: [eq('kind', kind), { field: 'windowId', operator: 'lt', value: windowIdOf(windowIndex - 1) }],
    ...scope
  });
  return { admitted: true };
}
