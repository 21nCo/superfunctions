import type { TransactionAdapter, WhereClause } from '@superfunctions/db';
import type { Job } from './alert-manager';
import type { AlertRecord } from './types';
import { ALERTS, ALERT_OUTBOX, ALERT_RUNTIME } from './schema';
interface Owner { id: string; protocol: string; migrationPhase?: string | null; migrationCursor?: string | null; migrationRevision?: number | null }
interface AlertRow { id: string; revision: number; payload: AlertRecord }
type Transaction = <T>(action: (tx: TransactionAdapter) => Promise<T>, migration?: boolean) => Promise<T>;
const target = 'ts-v3', migrating = 'ts-v2-receipts-migrating';
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export function receiptProjection(job: Job) {
  const delivery = job.payload.delivery, metadata = job.payload.pagerDuty;
  const terminal = delivery?.outcome === 'delivered' || delivery?.outcome === 'dismissed';
  if (job.payload.channel?.type === 'pagerduty' && !metadata) throw new Error('Legacy PagerDuty job requires explicit incident migration');
  if (terminal && (job.state !== 'dead' || !integer(delivery.completedAt) || job.payload.channel)) throw new Error('Invalid terminal receipt');
  if (metadata && (!identifier(metadata.episode) || !identifier(metadata.route) || (metadata.predecessor !== null && !identifier(metadata.predecessor)) || (metadata.predecessorEpisode !== null && !identifier(metadata.predecessorEpisode)) || (!!metadata.predecessor !== !!metadata.predecessorEpisode))) throw new Error('Invalid PagerDuty dependency metadata');
  return { completedAt: terminal ? delivery!.completedAt! : null, predecessorId: delivery?.outcome === 'delivered' ? null : metadata?.predecessor ?? null };
}
export function validateReceiptProjection(job: Job) {
  const expected = receiptProjection(job);
  if (job.completedAt !== expected.completedAt || job.predecessorId !== expected.predecessorId) throw new Error('Receipt projection requires migration or repair');
}
function validateAlert(row: AlertRow) {
  const record = row.payload, sequence = record?.pagerDuty;
  if (!record || !Array.isArray(record.notes) || record.notes.length > 100 || record.notes.some(note => typeof note.content !== 'string' || note.content.length > 4096 || typeof note.createdBy !== 'string' || note.createdBy.length > 255) || !Array.isArray(record.channels) || record.channels.length > 10 || !integer(row.revision) || row.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid receipt owner');
  if (sequence && (!identifier(sequence.episode) || !sequence.tails || typeof sequence.tails !== 'object' || Array.isArray(sequence.tails) || Object.keys(sequence.tails).length > 10 || Object.entries(sequence.tails).some(([route, id]) => !identifier(route) || !identifier(id)) || !Array.isArray(sequence.settled) || sequence.settled.length > 10 || sequence.settled.some(route => !(route in sequence.tails)))) throw new Error('Invalid PagerDuty route tails');
}
/** All mutations use the owning alert revision as their shared serialization fence. */
export class ReceiptRetention {
  constructor(private namespace: string, private transaction: Transaction, private validJob: (job: Job) => void) {}
  private where(id?: string): WhereClause[] { return [{ field: 'namespace', operator: 'eq', value: this.namespace }, ...(id === undefined ? [] : [{ field: 'id', operator: 'eq' as const, value: id }])]; }
  private limit(value = 50) { if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new TypeError('Retention page limit must be 1..1000'); return value; }
  private async owner(tx: TransactionAdapter) { return tx.findOne<Owner>({ model: ALERT_RUNTIME, where: [{ field: 'id', operator: 'eq', value: this.namespace }] }); }
  private async validateJob(tx: TransactionAdapter, job: Job) {
    this.validJob(job); validateReceiptProjection(job);
    const alert = await tx.findOne<AlertRow>({ model: ALERTS, where: this.where(job.alertId) });
    if (!alert) throw new Error('Receipt owner missing');
    if (job.predecessorId) {
      const prior = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(job.predecessorId) });
      if (!prior) throw new Error('Receipt predecessor missing');
      this.validJob(prior); validateReceiptProjection(prior);
      const metadata = job.payload.pagerDuty!, previous = prior.payload.pagerDuty;
      if (prior.alertId !== job.alertId || !previous || previous.route !== metadata.route || previous.episode !== metadata.predecessorEpisode || prior.id === job.id || (job.payload.notification.event === 'triggered' ? prior.payload.notification.event !== 'resolved' || previous.episode === metadata.episode : previous.episode !== metadata.episode)) throw new Error('Receipt predecessor identity mismatch');
    }
  }
  async status() {
    return this.transaction(async tx => {
      const owner = await this.owner(tx);
      return owner ? { protocol: owner.protocol, phase: owner.migrationPhase ?? null, cursor: owner.migrationCursor ?? null, revision: owner.migrationRevision ?? null } : null;
    }, true);
  }
  async migrate(pageLimit?: number) {
    const limit = this.limit(pageLimit);
    return this.transaction(async tx => {
      const owner = await this.owner(tx);
      if (!owner) throw new Error('Migration requires an existing ts-v2 namespace');
      if (owner.protocol === target) return { done: true, phase: null, cursor: null, processed: 0 };
      if (owner.protocol !== 'ts-v2' && owner.protocol !== migrating) throw new Error('Migration requires an existing ts-v2 namespace');
      let phase = owner.protocol === 'ts-v2' ? 'backfill' : owner.migrationPhase;
      let cursor = owner.protocol === 'ts-v2' ? null : owner.migrationCursor;
      const revision = owner.protocol === 'ts-v2' ? 0 : owner.migrationRevision;
      if (!['backfill', 'alerts', 'dependencies'].includes(phase!) || (cursor !== null && !identifier(cursor)) || !integer(revision) || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid durable migration progress');
      const model = phase === 'alerts' ? ALERTS : ALERT_OUTBOX;
      const rows = await tx.findMany<any>({ model, where: [...this.where(), ...(cursor ? [{ field: 'id', operator: 'gt' as const, value: cursor }] : [])], orderBy: [{ field: 'id', direction: 'asc' }], limit: limit + 1 });
      const page = rows.slice(0, limit);
      for (const row of page) {
        if (!identifier(row.id)) throw new Error('Invalid migration row identity');
        if (phase === 'backfill') {
          this.validJob(row);
          const projection = receiptProjection(row);
          const count = await tx.updateMany({ model: ALERT_OUTBOX, where: [...this.where(row.id), { field: 'revision', operator: 'eq', value: row.revision }], data: { ...projection, revision: row.revision + 1 } });
          if (count !== 1) throw new Error('Concurrent receipt migration');
        } else if (phase === 'alerts') {
          validateAlert(row);
          const record: AlertRecord = row.payload, sequence = record.pagerDuty;
          if (!sequence && ['triggered', 'acknowledged'].includes(record.state) && record.channels.some(channel => channel.type === 'pagerduty')) throw new Error('Legacy PagerDuty incident requires explicit migration');
          for (const [route, id] of Object.entries(sequence?.tails ?? {})) {
            const tail = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(id) });
            if (!tail) throw new Error('Current PagerDuty tail missing');
            await this.validateJob(tx, tail);
            if (tail.alertId !== row.id || tail.payload.pagerDuty?.route !== route || tail.payload.pagerDuty?.episode !== sequence!.episode) throw new Error('Current PagerDuty tail identity mismatch');
          }
        } else await this.validateJob(tx, row);
      }
      const more = rows.length > limit;
      if (more) cursor = page[page.length - 1].id;
      else { cursor = null; phase = phase === 'backfill' ? 'alerts' : phase === 'alerts' ? 'dependencies' : null; }
      const where: WhereClause[] = [{ field: 'id', operator: 'eq', value: this.namespace }, { field: 'protocol', operator: 'eq', value: owner.protocol }];
      if (owner.protocol === migrating) where.push({ field: 'migrationRevision', operator: 'eq', value: revision });
      const changed = await tx.updateMany({ model: ALERT_RUNTIME, where, data: { protocol: phase ? migrating : target, migrationPhase: phase, migrationCursor: cursor, migrationRevision: revision + 1 } });
      if (changed !== 1) throw new Error('Concurrent migration progress');
      return { done: phase === null, phase, cursor, processed: page.length };
    }, true);
  }
  async prune(options: { completedBefore: number; limit?: number; after?: { completedAt: number; id: string } }) {
    const { completedBefore, after } = options, limit = this.limit(options.limit);
    if (!integer(completedBefore) || completedBefore > Date.now() || (after && (!integer(after.completedAt) || !identifier(after.id)))) throw new TypeError('Invalid receipt retention boundary/cursor');
    return this.transaction(async tx => {
      if ((await this.owner(tx))?.protocol !== target) throw new Error('Receipt retention protocol unavailable');
      if (typeof tx.deleteMany !== 'function') throw new Error('Receipt retention requires transaction.deleteMany');
      const orderBy = [{ field: 'completedAt', direction: 'asc' as const }, { field: 'id', direction: 'asc' as const }];
      const base = [...this.where(), { field: 'completedAt', operator: 'lt' as const, value: completedBefore }, { field: 'completedAt', operator: 'gte' as const, value: 0 }, { field: 'completedAt', operator: 'ne' as const, value: null }];
      // Two disjoint indexed ranges implement a compound cursor without adapter-specific OR grouping.
      const same = after ? await tx.findMany<Job>({ model: ALERT_OUTBOX, where: [...base, { field: 'completedAt', operator: 'eq', value: after.completedAt }, { field: 'id', operator: 'gt', value: after.id }], orderBy, limit }) : [];
      const later = same.length === limit ? [] : await tx.findMany<Job>({ model: ALERT_OUTBOX, where: [...base, ...(after ? [{ field: 'completedAt', operator: 'gt' as const, value: after.completedAt }] : [])], orderBy, limit: limit - same.length });
      const rows = [...same, ...later]; let deleted = 0, pinned = 0;
      for (const job of rows) {
        await this.validateJob(tx, job);
        if (!integer(job.completedAt) || !['delivered', 'dismissed'].includes(job.payload.delivery?.outcome ?? '')) throw new Error('Nonterminal receipt selected');
        const alert = await tx.findOne<AlertRow>({ model: ALERTS, where: this.where(job.alertId) });
        if (!alert) throw new Error('Invalid receipt owner');
        validateAlert(alert);
        const incoming = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: [...this.where(), { field: 'predecessorId', operator: 'eq', value: job.id }] });
        if (incoming) { this.validJob(incoming); validateReceiptProjection(incoming); }
        if (Object.values(alert.payload.pagerDuty?.tails ?? {}).includes(job.id) || incoming) { pinned++; continue; }
        const changed = await tx.updateMany({ model: ALERTS, where: [...this.where(alert.id), { field: 'revision', operator: 'eq', value: alert.revision }], data: { revision: alert.revision + 1 } });
        if (changed !== 1) throw new Error('Concurrent receipt owner update');
        const removed = await tx.deleteMany({ model: ALERT_OUTBOX, where: [...this.where(job.id), { field: 'revision', operator: 'eq', value: job.revision }] });
        if (removed !== 1) throw new Error('Concurrent receipt deletion');
        deleted++;
      }
      const last = rows[rows.length - 1];
      return { scanned: rows.length, deleted, pinned, nextCursor: rows.length === limit ? { completedAt: last.completedAt!, id: last.id } : null };
    });
  }
}
