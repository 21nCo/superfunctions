import { createHash } from 'node:crypto';
import type { AuthSession } from '@superfunctions/auth';
import type { Adapter } from '@superfunctions/db';
import type { Route } from '@superfunctions/http';
import type { CampaignSchedule } from 'userfn';
import { object } from './validation.js';

export interface MessagingPolicy { enabled: boolean; perUser?: number; perSession?: number; schedule?: CampaignSchedule; cooldownMs?: number; }
export interface MessagingOptions {
  /** Authoritative campaign policy; client caps never authorize delivery. */
  resolvePolicy(session: AuthSession, campaignId: string): Promise<MessagingPolicy | null> | MessagingPolicy | null;
  /** Stable verified application session, not a client-provided ID or necessarily AuthSession.id. */
  resolveSession(session: AuthSession): Promise<string | null> | string | null;
}
interface Receipt { id: string; fingerprint: string; campaignId: string; allowed: boolean; shown: boolean; reason: string; }
interface Timing { id: string; lastReservedAt: number; }
interface ReceiptTiming { id: string; reservedAt: number; expiresAt: number; }
const MAX_TIME = 8640000000000000;
function temporalPolicy(policy: MessagingPolicy) {
  const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
  if (policy.schedule !== undefined && (!object(policy.schedule) || Object.keys(policy.schedule).some(key => !['startAt', 'endAt'].includes(key)))) throw new Error('Invalid campaign schedule');
  const start = policy.schedule?.startAt ?? 0, end = policy.schedule?.endAt ?? MAX_TIME;
  if (!validTime(start) || !validTime(end) || start >= end || (policy.schedule?.startAt as unknown) === null || (policy.schedule?.endAt as unknown) === null) throw new Error('Invalid campaign schedule');
  if (policy.cooldownMs !== undefined && (!Number.isSafeInteger(policy.cooldownMs) || policy.cooldownMs < 0 || policy.cooldownMs > MAX_TIME)) throw new Error('Invalid campaign cooldown');
  return { start, end, cooldown: policy.cooldownMs ?? 0 };
}
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
      const temporal = temporalPolicy(policy);
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const result = await database.transaction(async tx => {
            const now = Date.now();
            if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) throw new Error('Invalid messaging clock');
            const active = now >= temporal.start && now < temporal.end;
            const old = await receipt(tx, id);
            if (old) {
              if (old.fingerprint !== fingerprint) return json({ error: 'Message key belongs to another campaign or session' }, 409);
              if (action === 'shown' && old.allowed && !old.shown) {
                await tx.updateMany({ model: 'userfn_message_receipts', where: [eq('id', id)], data: { shown: true } }); old.shown = true;
              }
              if (action === 'reserve' && old.allowed) {
                const timing = await tx.findOne<ReceiptTiming>({ model: 'userfn_message_receipt_timing', where: [eq('id', id)] });
                const legacy = !timing && (policy.schedule !== undefined || policy.cooldownMs !== undefined);
                const expired = timing && (now < timing.reservedAt || now >= timing.expiresAt);
                if (!policy.enabled || !active || legacy || expired) return json({ ...old, allowed: false, reason: !policy.enabled ? 'disabled' : 'schedule' });
                return json({ ...old, ...(timing ? { expiresAt: Math.min(timing.expiresAt, temporal.end) } : {}) });
              }
              return json(old);
            }
            if (action === 'shown') return json({ error: 'Reservation not found' }, 404);
            const counters: Array<{ row: Counter | null; id: string; cap: number }> = [];
            for (const [scope, cap] of [[['user'], policy.perUser], [['session', sessionId], policy.perSession]] as const) {
              const counterId = hash([...actor, campaignId, scope]);
              const row = await tx.findOne<Counter>({ model: 'userfn_message_counters', where: [eq('id', counterId)] });
              counters.push({ row, id: counterId, cap: cap ?? Number.MAX_SAFE_INTEGER });
            }
            const timingId = counters[0].id;
            let timing = await tx.findOne<Timing>({ model: 'userfn_message_timing', where: [eq('id', timingId)] });
            // Historical counters cannot reveal the last delivery time. Conservatively
            // start one cooldown interval rather than resetting the protection.
            if (!timing && (counters[0].row?.count ?? 0) > 0 && temporal.cooldown > 0) {
              timing = { id: timingId, lastReservedAt: now };
              await tx.create({ model: 'userfn_message_timing', data: timing });
            }
            const cooled = !timing || (now >= timing.lastReservedAt && now - timing.lastReservedAt >= temporal.cooldown);
            const allowed = policy.enabled && active && cooled && counters.every(({ row, cap }) => (row?.count ?? 0) < cap);
            if (allowed) for (const counter of counters) {
              if (!counter.row) await tx.create({ model: 'userfn_message_counters', data: { id: counter.id, count: 1 } });
              else if (await tx.updateMany({ model: 'userfn_message_counters', where: [eq('id', counter.id), eq('count', counter.row.count)], data: { count: counter.row.count + 1 } }) !== 1) throw new Contention();
            }
            if (allowed) {
              if (!timing) await tx.create({ model: 'userfn_message_timing', data: { id: timingId, lastReservedAt: now } });
              else if (await tx.updateMany({ model: 'userfn_message_timing', where: [eq('id', timingId), eq('lastReservedAt', timing.lastReservedAt)], data: { lastReservedAt: now } }) !== 1) throw new Contention();
              await tx.create({ model: 'userfn_message_receipt_timing', data: { id, reservedAt: now, expiresAt: temporal.end } });
            }
            const value: Receipt = { id, fingerprint, campaignId, allowed, shown: false, reason: allowed ? 'reserved' : !policy.enabled ? 'disabled' : !active ? 'schedule' : !cooled ? 'cooldown' : 'capped' };
            await tx.create({ model: 'userfn_message_receipts', data: value });
            return json({ ...value, ...(allowed ? { expiresAt: temporal.end } : {}) }, 201);
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
