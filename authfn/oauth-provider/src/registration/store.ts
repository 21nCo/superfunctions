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
        fetchedAt: { type: 'date', required: true, fieldName: 'fetched_at' }
      }
    },
    {
      // One row per admitted registration or metadata document fetch; rows
      // older than the previous window are pruned as new ones arrive.
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
}

export function findDocumentClient(store: RegistrationStore, clientId: string): Promise<DocumentClientRecord | null> {
  return store.database.findOne<DocumentClientRecord>({
    model: MODELS.documents,
    where: [eq('id', clientId)],
    namespace: namespace(store)
  });
}

/** Stores `record` as the client's last usable document, replacing any earlier one. */
export async function saveDocumentClient(store: RegistrationStore, record: DocumentClientRecord): Promise<void> {
  const scope = { model: MODELS.documents, namespace: namespace(store) };
  const { id, ...data } = record;
  const update = () => store.database.updateMany({ ...scope, where: [eq('id', id)], data });
  if (await update() > 0) {
    return;
  }
  try {
    await store.database.create({ ...scope, data: { ...record } });
  } catch (error) {
    // Another request stored it first: overwrite with this fetch.
    if (await update() === 0) {
      throw error;
    }
  }
}

export async function deleteDocumentClient(store: RegistrationStore, clientId: string): Promise<void> {
  await store.database.deleteMany({ model: MODELS.documents, where: [eq('id', clientId)], namespace: namespace(store) });
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
