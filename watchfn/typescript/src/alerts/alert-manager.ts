import { randomUUID } from 'node:crypto';
import { wrapWithSchema, type Adapter, type TransactionAdapter, type WhereClause } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { ConditionEvaluator, validateAlertCondition, alertWindowMs, type AlertCondition, type AlertMetricPoint } from './conditions';
import { ALERTS, ALERT_OUTBOX, ALERT_RUNTIME, getAlertSchema } from './schema';
import type { AlertConfig, AlertChannel, AlertRecord, PublicAlert, AlertRuntimeConfig, AlertNotification } from './types';
export type { AlertConfig, AlertChannel } from './types';
interface Row { id: string; namespace: string; revision: number; payload: AlertRecord }
interface Job { id: string; namespace: string; alertId: string; revision: number; state: string; availableAt: number; leaseToken: string | null; attempts: number; payload: { notification: AlertNotification; channel: AlertChannel } }
type DB = Adapter | TransactionAdapter;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const active = (record: AlertRecord) => record.state === 'triggered' || record.state === 'acknowledged';
class Conflict extends Error {}
export interface AlertHost {
  database?: Adapter; config?: AlertRuntimeConfig; name: string;
  admit<T>(operation: () => Promise<T>, started?: boolean): Promise<T>;
  observations(metric: string, from: number | undefined, now: number, max: number): Promise<AlertMetricPoint[]>;
}

/** The public alert manager owns persistence, evaluation and a transactional delivery outbox. */
export class AlertManager {
  private readonly db: Adapter;
  private readonly namespace: string;
  private readonly evaluator = new ConditionEvaluator();
  private readonly config: Required<Pick<AlertRuntimeConfig, 'maxObservations' | 'maxPendingPerAlert' | 'timeoutMs' | 'leaseMs' | 'maxAttempts'>> & AlertRuntimeConfig;
  private readonly listeners = { triggered: [] as ((alert: PublicAlert, context: any) => unknown)[], resolved: [] as ((alert: PublicAlert, context: any) => unknown)[] };
  constructor(private readonly host: AlertHost) {
    const database = host.database ?? memoryAdapter();
    if (!database.capabilities?.transactions?.supported || typeof database.transaction !== 'function') throw new TypeError('Alerts require a shared DB adapter with transactions');
    this.db = wrapWithSchema(database, getAlertSchema());
    this.namespace = host.config?.namespace ?? host.name;
    if (!text(this.namespace, 128)) throw new TypeError('Invalid alert namespace');
    this.config = { maxObservations: 10000, maxPendingPerAlert: 100, timeoutMs: 10000, leaseMs: 30000, maxAttempts: 5, ...host.config };
    for (const key of ['maxObservations', 'maxPendingPerAlert', 'timeoutMs', 'leaseMs', 'maxAttempts'] as const) if (!Number.isSafeInteger(this.config[key]) || this.config[key] < 1) throw new TypeError(`Invalid alert ${key}`);
    if (this.config.timeoutMs > 60000 || this.config.leaseMs < this.config.timeoutMs + 100 || this.config.leaseMs > 300000 || this.config.maxAttempts > 100 || this.config.maxPendingPerAlert > 1000 || this.config.maxObservations > 1000000) throw new TypeError('Alert runtime bounds exceeded');
  }
  private where(id?: string): WhereClause[] { return [{ field: 'namespace', operator: 'eq', value: this.namespace }, ...(id ? [{ field: 'id', operator: 'eq' as const, value: id }] : [])]; }
  private async row(id: string, db: DB = this.db): Promise<Row> {
    if (!text(id, 128)) throw new TypeError('Invalid alert id');
    const row = await db.findOne<Row>({ model: ALERTS, where: this.where(id) });
    if (!row) throw new Error('Alert not found'); return row;
  }
  private public(record: AlertRecord): PublicAlert { return { ...copy(record), channels: record.channels.map(channel => ({ type: channel.type, configured: true })) }; }
  private validate(input: AlertConfig): AlertConfig {
    if (!input || !text(input.name, 255) || !Array.isArray(input.channels) || input.channels.length > 10) throw new TypeError('Invalid alert definition');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new TypeError('Invalid alert enabled value');
    validateAlertCondition(input.condition);
    if (input.autoResolve) { if (typeof input.autoResolve.enabled !== 'boolean') throw new TypeError('Invalid autoResolve'); validateAlertCondition(input.autoResolve.condition); }
    if (input.severity !== undefined && !['info', 'warning', 'error', 'critical'].includes(input.severity)) throw new TypeError('Invalid alert severity');
    if (input.description !== undefined && !text(input.description, 4096) || input.runbook !== undefined && !text(input.runbook, 2048)) throw new TypeError('Invalid alert description/runbook');
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 32 || input.tags.some(tag => !text(tag, 128)))) throw new TypeError('Invalid alert tags');
    for (const channel of input.channels) {
      if (!channel || !['email', 'slack', 'pagerduty', 'webhook'].includes(channel.type)) throw new TypeError('Unsupported alert channel');
      if (channel.type === 'email' && (!this.config.emailSender || !Array.isArray(channel.recipients) || !channel.recipients.length || channel.recipients.length > 100 || channel.recipients.some(recipient => !text(recipient, 320)))) throw new TypeError('Email alerts require recipients and a configured sender');
      if (channel.type === 'pagerduty' && (!this.config.pagerDutySender || !text(channel.integrationKey, 1024))) throw new TypeError('PagerDuty alerts require an integration key and configured sender');
      if (channel.type === 'slack' || channel.type === 'webhook') {
        let url: URL; try { url = new URL(channel.webhook!); } catch { throw new TypeError('Invalid alert webhook'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || channel.webhook!.length > 4096) throw new TypeError('Invalid alert webhook');
      }
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw new TypeError('Alert definition exceeds 32 KiB');
    // Store only supported fields: callers cannot inject state or unbounded notes.
    const { name, description, enabled, condition, channels, severity, tags, runbook, autoResolve } = input;
    return copy({ name, description, enabled, condition, channels, severity, tags, runbook, autoResolve });
  }
  create(input: AlertConfig): Promise<PublicAlert> {
    const config = this.validate(input);
    return this.host.admit(async () => {
      const now = Date.now(); const id = randomUUID();
      const record: AlertRecord = { ...config, id, enabled: config.enabled ?? true, state: 'normal', createdAt: now, updatedAt: now, notes: [], pendingNotifications: 0 };
      await this.db.create({ model: ALERTS, data: { id, namespace: this.namespace, state: record.state, revision: 0, payload: record } });
      return this.public(record);
    });
  }
  get(id: string): Promise<PublicAlert> { return this.host.admit(async () => this.public((await this.row(id)).payload)); }
  list(filter: { status?: string; after?: string; limit?: number } = {}): Promise<PublicAlert[]> {
    const limit = this.limit(filter.limit);
    if (filter.status !== undefined && !['normal', 'triggered', 'acknowledged', 'resolved'].includes(filter.status)) throw new TypeError('Invalid alert status');
    return this.host.admit(async () => {
      const rows = await this.db.findMany<Row>({ model: ALERTS, where: [...this.where(), ...(filter.status ? [{ field: 'state', operator: 'eq' as const, value: filter.status }] : []), ...(filter.after ? [{ field: 'id', operator: 'gt' as const, value: filter.after }] : [])], orderBy: [{ field: 'id', direction: 'asc' }], limit });
      return rows.filter(row => !filter.status || row.payload.state === filter.status).map(row => this.public(row.payload));
    });
  }
  update(id: string, input: AlertConfig) {
    const config = this.validate(input);
    return this.host.admit(() => this.mutate(id, record => {
      // A full definition replacement must remove omitted recovery/routing metadata.
      for (const key of ['description', 'severity', 'tags', 'runbook', 'autoResolve'] as const) delete record[key];
      Object.assign(record, config, { enabled: config.enabled ?? record.enabled });
    }));
  }
  onTrigger(callback: (alert: PublicAlert, context: any) => unknown) { this.listeners.triggered.push(callback); }
  onResolve(callback: (alert: PublicAlert, context: any) => unknown) { this.listeners.resolved.push(callback); }
  private note(record: AlertRecord, content: unknown, createdBy: unknown, now: number) {
    if (!text(content, 4096) || !text(createdBy, 255)) throw new TypeError('Invalid alert note');
    if (record.notes.length >= 100) throw new Error('Alert note capacity reached');
    record.notes.push({ content, createdBy, createdAt: now });
  }
  addNote(id: string, input: { content: string; createdBy: string }) {
    const { content, createdBy } = input;
    return this.host.admit(() => this.mutate(id, (record, now) => this.note(record, content, createdBy, now)));
  }
  acknowledge(id: string, input: { acknowledgedBy: string; note?: string }) {
    const { acknowledgedBy, note } = input;
    if (!text(acknowledgedBy, 255)) throw new TypeError('Acknowledgement actor is required');
    return this.host.admit(() => this.mutate(id, (record, now) => {
      if (record.state === 'acknowledged') return;
      if (record.state !== 'triggered') throw new Error('Only triggered alerts can be acknowledged');
      record.state = 'acknowledged'; record.acknowledgedBy = acknowledgedBy;
      if (note) this.note(record, note, acknowledgedBy, now);
      return { event: 'acknowledged' as const };
    }));
  }
  resolve(id: string, input: { resolvedBy: string; resolution?: string }) {
    const { resolvedBy, resolution } = input;
    if (!text(resolvedBy, 255)) throw new TypeError('Resolution actor is required');
    return this.host.admit(() => this.mutate(id, (record, now) => {
      if (!active(record)) return;
      record.state = 'resolved'; record.resolvedAt = now; record.resolvedBy = resolvedBy;
      if (resolution) this.note(record, resolution, resolvedBy, now);
      return { event: 'resolved' as const };
    }));
  }
  trigger(id: string, input: { value?: number } = {}) {
    const { value } = input;
    if (value !== undefined && !Number.isFinite(value)) throw new TypeError('Invalid trigger value');
    return this.host.admit(() => this.mutate(id, (record, now) => {
      if (!record.enabled || active(record)) return;
      this.triggerState(record, now); return { event: 'triggered' as const, value };
    }));
  }
  private triggerState(record: AlertRecord, now: number) { record.state = 'triggered'; record.triggeredAt = now; delete record.resolvedAt; delete record.resolvedBy; delete record.acknowledgedBy; }
  private limit(limit = 50) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Alert page limit must be 1..100'); return limit; }
  evaluate(options: { now?: number; limit?: number; after?: string } = {}) {
    const now = options.now ?? Date.now(), limit = this.limit(options.limit);
    if (!Number.isFinite(now)) throw new TypeError('Invalid evaluation time');
    return this.host.admit(async () => {
      const rows = await this.db.findMany<Row>({ model: ALERTS, where: [...this.where(), ...(options.after ? [{ field: 'id', operator: 'gt' as const, value: options.after }] : [])], orderBy: [{ field: 'id', direction: 'asc' }], limit });
      const results: { alert: PublicAlert; observed: boolean; matched: boolean | null }[] = [];
      for (const row of rows) {
        if (!row.payload.enabled) continue;
        const ranges = new Map<string, { metric: string; from: number | undefined }>();
        const collect = (condition: AlertCondition): void => {
          if (condition.type === 'composite') { condition.conditions.forEach(collect); return; }
          const from = condition.type === 'anomaly' ? undefined : now - alertWindowMs(condition.window);
          ranges.set(JSON.stringify([condition.metric, from ?? null]), { metric: condition.metric, from });
        };
        collect(row.payload.condition); if (row.payload.autoResolve?.enabled) collect(row.payload.autoResolve.condition);
        const observations = new Map<string, AlertMetricPoint[]>();
        for (const [key, { metric, from }] of ranges) observations.set(key, await this.host.observations(metric, from, now, this.config.maxObservations));
        let matched: boolean | null = null;
        const alert = await this.mutate(row.id, record => {
          // Definition edits race safely: re-read observations on a later evaluation.
          if (JSON.stringify(record.condition) !== JSON.stringify(row.payload.condition) || JSON.stringify(record.autoResolve) !== JSON.stringify(row.payload.autoResolve)) throw new Conflict('Alert definition changed during evaluation');
          if (!record.enabled || (record.lastEvaluated ?? -Infinity) > now) return;
          const result = this.evaluator.evaluateResult(record.condition, new Map(), now, observations); matched = result.matched;
          record.lastEvaluated = now;
          if (result.matched === true && !active(record)) { this.triggerState(record, now); return { event: 'triggered' as const, value: result.value }; }
          if (active(record) && record.autoResolve?.enabled) {
            const recovery = this.evaluator.evaluateResult(record.autoResolve.condition, new Map(), now, observations);
            if (recovery.matched === true) { record.state = 'resolved'; record.resolvedAt = now; record.resolvedBy = 'autoResolve'; return { event: 'resolved' as const, value: recovery.value }; }
          }
        }, now, row.revision);
        results.push({ alert, observed: matched !== null, matched });
      }
      return { results, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
    }, true);
  }
  private async mutate(id: string, change: (record: AlertRecord, now: number) => { event: AlertNotification['event']; value?: number } | void, now = Date.now(), expectedRevision?: number): Promise<PublicAlert> {
    const committed = await this.db.transaction(async tx => {
      const row = await this.row(id, tx);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Conflict('Alert changed during evaluation; retry');
      const record = copy(row.payload), transition = change(record, now);
      record.updatedAt = now;
      if (transition && record.pendingNotifications + record.channels.length > this.config.maxPendingPerAlert) throw new Error('Alert notification capacity reached; drain or explicitly dismiss dead letters');
      if (transition) record.pendingNotifications += record.channels.length;
      const changed = await tx.updateMany({ model: ALERTS, where: [...this.where(id), { field: 'revision', operator: 'eq', value: row.revision }], data: { revision: row.revision + 1, state: record.state, payload: record } });
      if (changed !== 1) throw new Conflict('Concurrent alert update; retry');
      if (transition) for (const channel of record.channels) {
        const jobId = randomUUID();
        const notification: AlertNotification = { id: jobId, event: transition.event, timestamp: now, value: transition.value,
          alert: { id, name: record.name, severity: record.severity ?? 'warning', state: record.state, description: record.description, runbook: record.runbook, triggeredAt: record.triggeredAt } };
        await tx.create({ model: ALERT_OUTBOX, data: { id: jobId, namespace: this.namespace, alertId: id, revision: 0, state: 'pending', availableAt: now, leaseToken: null, attempts: 0, payload: { notification, channel } } });
      }
      return { record, transition };
    });
    const result = this.public(committed.record);
    if (committed.transition?.event === 'triggered' || committed.transition?.event === 'resolved') {
      const failures = await Promise.allSettled(this.listeners[committed.transition.event].map(callback => Promise.resolve().then(() => callback(result, { value: committed.transition!.value, triggeredAt: committed.record.triggeredAt, timestamp: now, duration: now - (committed.record.triggeredAt ?? now) }))));
      // Durable state/outbox already committed; listener failures never undo them or retry sends.
      if (failures.some(outcome => outcome.status === 'rejected')) throw new Error('Alert transition committed; one or more listeners failed');
    }
    return result;
  }
  notifications(options: { limit?: number; after?: string } = {}) {
    const limit = this.limit(options.limit);
    return this.host.admit(async () => (await this.db.findMany<Job>({ model: ALERT_OUTBOX, where: [...this.where(), ...(options.after ? [{ field: 'id', operator: 'gt' as const, value: options.after }] : [])], orderBy: [{ field: 'id', direction: 'asc' }], limit })).map(job => ({ id: job.id, alertId: job.alertId, state: job.state, attempts: job.attempts, availableAt: job.availableAt, event: job.payload.notification.event })));
  }
  private async assertDispatchProtocol(): Promise<void> {
    const read = () => this.db.findOne<{ id: string; protocol: string }>({ model: ALERT_RUNTIME, where: [{ field: 'id', operator: 'eq', value: this.namespace }] });
    let row = await read();
    if (!row) {
      // Unique namespace ID is the atomic ownership claim. Separate reads avoid
      // SQLite deferred-transaction upgrades when independent workers race.
      try { await this.db.create({ model: ALERT_RUNTIME, data: { id: this.namespace, protocol: 'ts-v1' } }); }
      catch (error) { row = await read(); if (!row) throw error; }
      row = row ?? await read();
    }
    if (row?.protocol !== 'ts-v1') throw new Error('Alert namespace belongs to an incompatible dispatch protocol');
  }
  dismissNotification(id: string) {
    if (!text(id, 128)) throw new TypeError('Invalid notification id');
    return this.host.admit(async () => { await this.assertDispatchProtocol(); return this.finish(id); });
  }
  private async finish(id: string, token?: string): Promise<boolean> {
    return this.db.transaction(async tx => {
      const job = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(id) });
      if (!job || (token ? job.leaseToken !== token || job.state !== 'sending' || job.availableAt <= Date.now() : job.state !== 'dead')) return false;
      const row = await this.row(job.alertId, tx), record = copy(row.payload);
      record.pendingNotifications--; if (token) record.lastNotification = { event: job.payload.notification.event, deliveredAt: Date.now() };
      const count = await tx.updateMany({ model: ALERTS, where: [...this.where(row.id), { field: 'revision', operator: 'eq', value: row.revision }], data: { revision: row.revision + 1, state: record.state, payload: record } });
      if (count !== 1) throw new Conflict('Concurrent alert delivery; retry');
      const removed = await tx.deleteMany({ model: ALERT_OUTBOX, where: [...this.where(id), { field: 'revision', operator: 'eq', value: job.revision }] });
      if (removed !== 1) throw new Conflict('Concurrent notification claim'); return true;
    });
  }
  processNotifications(options: { limit?: number } = {}) {
    const limit = this.limit(options.limit);
    return this.host.admit(async () => {
      await this.assertDispatchProtocol();
      const now = Date.now();
      const rows = await this.db.findMany<Job>({ model: ALERT_OUTBOX, where: [...this.where(), { field: 'state', operator: 'ne', value: 'dead' }, { field: 'availableAt', operator: 'lte', value: now }], orderBy: [{ field: 'availableAt', direction: 'asc' }, { field: 'id', direction: 'asc' }], limit });
      let processed = 0;
      for (const row of rows) {
        if (row.attempts >= this.config.maxAttempts) {
          await this.db.updateMany({ model: ALERT_OUTBOX, where: [...this.where(row.id), { field: 'revision', operator: 'eq', value: row.revision }], data: { state: 'dead', leaseToken: null, revision: row.revision + 1 } });
          continue;
        }
        const token = randomUUID();
        const claimed = await this.db.updateMany({ model: ALERT_OUTBOX, where: [...this.where(row.id), { field: 'revision', operator: 'eq', value: row.revision }], data: { state: 'sending', revision: row.revision + 1, leaseToken: token, availableAt: Date.now() + this.config.leaseMs, attempts: row.attempts + 1 } });
        if (claimed !== 1) continue;
        processed++;
        try { await this.send(row.payload.notification, row.payload.channel); await this.finish(row.id, token); }
        catch {
          // Provider errors may contain webhook credentials or response bodies; never persist/log them.
          await this.db.updateMany({ model: ALERT_OUTBOX, where: [...this.where(row.id), { field: 'leaseToken', operator: 'eq', value: token }], data: { revision: row.revision + 2, state: row.attempts + 1 >= this.config.maxAttempts ? 'dead' : 'pending', leaseToken: null, availableAt: Date.now() + Math.min(60000, 1000 * 2 ** row.attempts) } });
        }
      }
      return { processed };
    }, true);
  }
  private async send(notification: AlertNotification, channel: AlertChannel): Promise<void> {
    const controller = new AbortController(); const deadline = Date.now() + this.config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const assertTimely = () => { if (controller.signal.aborted || Date.now() >= deadline) throw new Error('Notification delivery timed out'); };
    try {
      if (channel.type === 'email' || channel.type === 'pagerduty') {
        const sender = channel.type === 'email' ? this.config.emailSender : this.config.pagerDutySender;
        if (!sender) throw new Error('Notification sender unavailable after restart');
        await sender(copy(notification), copy(channel), controller.signal);
        assertTimely(); return;
      }
      const payload = channel.type === 'slack' ? { text: `[${notification.alert.severity}] ${notification.alert.name}: ${notification.event}`, ...(channel.channel ? { channel: channel.channel } : {}) } : notification;
      const response = await fetch(channel.webhook!, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': notification.id }, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' });
      await response.body?.cancel();
      assertTimely();
      if (!response.ok) throw new Error('Notification delivery failed');
    } finally { clearTimeout(timeout); }
  }
}
