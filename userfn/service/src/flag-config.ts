import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AuthSession } from '@superfunctions/auth';
import type { Adapter } from '@superfunctions/db';
import type { Route } from '@superfunctions/http';
import { validateFlagDefinitions, type FlagConfig, type Segment } from 'userfn/operator';
import { canonical, object } from './validation.js';

export interface FlagConfigSigningOptions {
  /** Explicit Ed25519 private key, supplied by the host; never persisted. */
  privateKey: string | KeyObject;
  /** Stable identifier of the trusted public key distributed to clients out of band. */
  keyId: string;
}
interface Snapshot { id: string; tenantId: string; environment: string; etag: string; body: string; signature: string; }
const response = (error: string, status: number) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validEnvironment = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);

/** Complete bounded wire snapshot. Rules use the existing SDK operators; no executable values. */
function validatePayload(value: unknown): { flags: FlagConfig[]; segments: Segment[] } {
  if (!object(value) || Object.keys(value).some(key => !['flags', 'segments'].includes(key)) || !Array.isArray(value.flags) || !Array.isArray(value.segments)) throw new TypeError('Invalid configuration');
  // This also bounds nesting before the SDK validator traverses arbitrary JSON values.
  if (Buffer.byteLength(canonical(value)) > 262144 || value.flags.length > 1000 || value.segments.length > 1000) throw new TypeError('Configuration exceeds bounds');
  validateFlagDefinitions(value.flags);
  const ids = new Set<string>();
  for (const segment of value.segments) {
    if (!object(segment) || Object.keys(segment).some(key => !['id', 'name', 'rules', 'matchType'].includes(key)) || typeof segment.id !== 'string' || !segment.id || ids.has(segment.id) || !Array.isArray(segment.rules) || (typeof segment.name !== 'string' || !segment.name) || (segment.matchType !== undefined && !['all', 'any'].includes(segment.matchType as string))) throw new TypeError('Invalid segment');
    ids.add(segment.id);
    validateFlagDefinitions([{ key: 'validation', enabled: true, defaultValue: false, variations: [], rules: [{ id: 'validation', constraints: segment.rules }] }]);
  }
  return value as { flags: FlagConfig[]; segments: Segment[] };
}

export function flagConfigRoutes(database: Adapter, authorize: (request: Request, scope: string) => Promise<AuthSession | Response>, options?: FlagConfigSigningOptions): Route[] {
  if (!options) return [];
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.keyId)) throw new TypeError('Invalid flag signing key ID');
  const keyId = options.keyId;
  const privateKey = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Flag configuration requires an Ed25519 private key');
  const find = (adapter: Pick<Adapter, 'findOne'>, id: string) => adapter.findOne<Snapshot>({ model: 'userfn_flag_config', where: [{ field: 'id', operator: 'eq', value: id }] });
  const headers = (row: Snapshot) => ({ 'content-type': 'application/json', 'cache-control': 'private, no-cache', vary: 'Authorization', etag: row.etag, 'x-userfn-signature': row.signature });
  return [
    { method: 'OPTIONS', path: '/config/:environment', handler: () => new Response(null, { status: 204 }) },
    { method: 'GET', path: '/config/:environment', handler: async (request, context) => {
      const session = await authorize(request, 'userfn:config:read'); if (session instanceof Response) return session;
      const environment = context.params.environment;
      if (!validEnvironment(environment)) return response('Invalid environment', 400);
      const id = digest(JSON.stringify([session.subject.tenantId, environment]));
      const row = await find(database, id); if (!row) return response('Configuration not found', 404);
      const condition = request.headers.get('if-none-match');
      if (condition && condition.length > 8192) return response('Invalid conditional header', 400);
      if (condition?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === row.etag)) return new Response(null, { status: 304, headers: headers(row) });
      return new Response(row.body, { headers: headers(row) });
    } },
    { method: 'PUT', path: '/config/:environment', handler: async (request, context) => {
      const session = await authorize(request, 'userfn:config:write'); if (session instanceof Response) return session;
      const environment = context.params.environment;
      if (!validEnvironment(environment)) return response('Invalid environment', 400);
      const match = request.headers.get('if-match'); const none = request.headers.get('if-none-match');
      if (!match && !none) return response('A conditional write is required', 428);
      if ((match && none) || (match && !/^"[a-f0-9]{64}"$/.test(match)) || (none && none !== '*')) return response('Invalid conditional write', 400);
      const parsed = await context.json();
      let payload: { flags: FlagConfig[]; segments: Segment[] };
      try { payload = validatePayload(parsed); } catch { return response('Invalid configuration', 400); }
      const tenantId = session.subject.tenantId!;
      const id = digest(JSON.stringify([tenantId, environment]));
      const body = canonical({ version: 1, tenantId, environment, revision: randomUUID(), keyId, algorithm: 'Ed25519', ...payload });
      const row: Snapshot = { id, tenantId, environment, body, etag: '"' + digest(body) + '"', signature: sign(null, Buffer.from(body), privateKey).toString('base64url') };
      let accepted: boolean;
      try {
        accepted = await database.transaction(async tx => {
          if (none === '*') {
            if (await find(tx, id)) return false;
            await tx.create({ model: 'userfn_flag_config', data: row }); return true;
          }
          return (await tx.updateMany({ model: 'userfn_flag_config', where: [{ field: 'id', operator: 'eq', value: id }, { field: 'etag', operator: 'eq', value: match! }], data: row })) === 1;
        });
      } catch (error) {
        // A concurrent first publication may win the unique primary key race.
        if (none === '*' && await find(database, id)) return response('Configuration changed', 412);
        throw error;
      }
      if (!accepted) return response('Configuration changed', 412);
      return new Response(row.body, { status: none === '*' ? 201 : 200, headers: headers(row) });
    } },
  ];
}
