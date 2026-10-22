import { createHash } from 'node:crypto';
import type { AuthSession } from '@superfunctions/auth';
import type { Adapter } from '@superfunctions/db';
import type { Route } from '@superfunctions/http';
import { object } from './validation.js';

export interface MessagingPolicy { enabled: boolean; perUser?: number; perSession?: number; }
export interface MessagingOptions {
  /** Authoritative campaign policy; client caps never authorize delivery. */
  resolvePolicy(session: AuthSession, campaignId: string): Promise<MessagingPolicy | null> | MessagingPolicy | null;
  /** Stable verified application session, not a client-provided ID or necessarily AuthSession.id. */
  resolveSession(session: AuthSession): Promise<string | null> | string | null;
}
interface Receipt { id: string; fingerprint: string; campaignId: string; allowed: boolean; shown: boolean; reason: string; }
interface Counter { id: string; count: number; }
class Contention extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eq = (field: string, value: string | number) => ({ field, operator: 'eq' as const, value });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const valid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export function messagingRoutes(database: Adapter, authorize: (request: Request, scope: string) => Promise<AuthSession | Response>, options?: MessagingOptions): Route[] {
  if (!options) return [];
  if (!database.capabilities.transactions.supported) throw new Error('Durable messaging requires database transactions');
  const receipt = (db: Pick<Adapter, 'findOne'>, id: string) => db.findOne<Receipt>({ model: 'userfn_message_receipts', where: [eq('id', id)] });
  return ['reserve', 'shown'].flatMap(action => [
    { method: 'OPTIONS' as const, path: `/messages/:campaignId/${action}`, handler: () => new Response(null, { status: 204 }) },
    { method: 'POST' as const, path: `/messages/:campaignId/${action}`, handler: async (request, context) => {
      const session = await authorize(request, 'userfn:messages:write'); if (session instanceof Response) return session;
      if (session.subject.actorType !== 'user') return json({ error: 'A verified user identity is required' }, 403);
      const campaignId = context.params.campaignId, key = request.headers.get('idempotency-key');
      const body = await context.json();
      if (!valid(campaignId) || !valid(key) || !object(body) || Object.keys(body).length !== 0) return json({ error: 'Invalid message request' }, 400);
      const sessionId = await options.resolveSession(session);
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) return json({ error: 'Verified messaging session is required' }, 403);
      const actor = [session.subject.tenantId, session.subject.actorId];
      const id = hash([...actor, key]);
      const fingerprint = hash([campaignId, sessionId]);
      // Confirmation reconciles an existing side effect, even after campaign retirement.
      const policy: MessagingPolicy | null = action === 'reserve'
        ? await options.resolvePolicy(session, campaignId) : { enabled: false };
      if (!policy) return json({ error: 'Campaign not found' }, 404);
      if (typeof policy.enabled !== 'boolean' || [policy.perUser, policy.perSession].some(cap => cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0 || cap > 1000000))) throw new Error('Invalid messaging policy');
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const result = await database.transaction(async tx => {
            const old = await receipt(tx, id);
            if (old) {
              if (old.fingerprint !== fingerprint) return json({ error: 'Message key belongs to another campaign or session' }, 409);
              if (action === 'shown' && old.allowed && !old.shown) {
                await tx.updateMany({ model: 'userfn_message_receipts', where: [eq('id', id)], data: { shown: true } }); old.shown = true;
              }
              return json(action === 'reserve' && !policy.enabled ? { ...old, allowed: false, reason: 'disabled' } : old);
            }
            if (action === 'shown') return json({ error: 'Reservation not found' }, 404);
            const counters: Array<{ row: Counter | null; id: string; cap: number }> = [];
            for (const [scope, cap] of [[['user'], policy.perUser], [['session', sessionId], policy.perSession]] as const) {
              const counterId = hash([...actor, campaignId, scope]);
              const row = await tx.findOne<Counter>({ model: 'userfn_message_counters', where: [eq('id', counterId)] });
              counters.push({ row, id: counterId, cap: cap ?? Number.MAX_SAFE_INTEGER });
            }
            const allowed = policy.enabled && counters.every(({ row, cap }) => (row?.count ?? 0) < cap);
            if (allowed) for (const counter of counters) {
              if (!counter.row) await tx.create({ model: 'userfn_message_counters', data: { id: counter.id, count: 1 } });
              else if (await tx.updateMany({ model: 'userfn_message_counters', where: [eq('id', counter.id), eq('count', counter.row.count)], data: { count: counter.row.count + 1 } }) !== 1) throw new Contention();
            }
            const value: Receipt = { id, fingerprint, campaignId, allowed, shown: false, reason: allowed ? 'reserved' : policy.enabled ? 'capped' : 'disabled' };
            await tx.create({ model: 'userfn_message_receipts', data: value });
            return json(value, 201);
          });
          return result;
        } catch (error) {
          // Unique races and serialization conflicts are retried with the same identity.
          // Unknown outcomes reconcile the committed receipt before consuming more capacity.
          if (attempt === 7) throw error;
          await new Promise(resolve => setTimeout(resolve, attempt * 5));
        }
      }
      throw new Error('Message reservation unavailable');
    } },
  ]);
}
