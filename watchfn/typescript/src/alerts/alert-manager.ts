import {validateGoal,goalId,type GoalConfig,type GoalProgress,type GoalCondition} from '../business/goals';
import {getBusinessSchema,BUSINESS_DEFINITIONS} from '../business/schema';
import {namedPatternChannels} from '../logs/regex';
import { EmailCleanupError, loadSesProvider, sendSesEmail, validEmail, validateEmailConfig } from './channels/email-ses';
import { randomUUID } from 'node:crypto';
import { wrapWithSchema, type Adapter, type TransactionAdapter, type WhereClause } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { ConditionEvaluator, validateAlertCondition, alertWindowMs, type AlertCondition, type AlertMetricPoint, type LogPatternCondition, logPatternObservationKey } from './conditions';
import { ALERTS, ALERT_OUTBOX, ALERT_RUNTIME, getAlertSchema } from './schema';
import { ReceiptRetention, validateReceiptProjection } from './retention';
import { pagerDutyRoute, pagerDutyRequest, type PagerDutyJob } from './channels/pagerduty';
import type { AlertConfig, AlertChannel, AlertRecord, PublicAlert, AlertRuntimeConfig, AlertNotification, AlertLifecycleListener, AlertLifecycleContext } from './types';
export type { AlertConfig, AlertChannel } from './types';
interface Row { id: string; namespace: string; revision: number; payload: AlertRecord }
interface Delivery { outcome: 'pending' | 'unknown' | 'rejected' | 'delivered' | 'dismissed'; reason?: string; completedAt?: number; actor?: string }
export interface Job { id: string; namespace: string; alertId: string; revision: number; state: string; availableAt: number; leaseToken: string | null; attempts: number; predecessorId: string | null; completedAt: number | null; payload: { notification: AlertNotification; channel?: AlertChannel; pagerDuty?: PagerDutyJob; delivery?: Delivery } }
type Outcome = { outcome: 'delivered' | 'unknown' | 'rejected' | 'retryable'; retryAfter?: number };
const PROTOCOL = 'ts-v3';

type DB = Adapter | TransactionAdapter;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const active = (record: AlertRecord) => record.state === 'triggered' || record.state === 'acknowledged';
class Conflict extends Error {}
class MarkerCollision extends Error { constructor(readonly original: unknown) { super('Concurrent namespace marker'); } }
export interface AlertHost {
  database?: Adapter; config?: AlertRuntimeConfig; name: string;
  admit<T>(operation: () => Promise<T>, started?: boolean): Promise<T>;
  logPatternCount?(condition: LogPatternCondition, from: number, now: number, maximum: number): Promise<number>;
  goalProgress?(goal:GoalConfig,now:number,maximum:number):Promise<GoalProgress>;
  observations(metric: string, from: number | undefined, now: number, max: number): Promise<AlertMetricPoint[]>;
}

/** The public alert manager owns persistence, evaluation and a transactional delivery outbox. */
export class AlertManager {
  private readonly db: Adapter;
  private readonly namespace: string;
  private readonly evaluator = new ConditionEvaluator();
  private readonly config: Required<Pick<AlertRuntimeConfig, 'maxObservations' | 'maxPendingPerAlert' | 'timeoutMs' | 'leaseMs' | 'maxAttempts'>> & AlertRuntimeConfig;
  private readonly listeners = { triggered: [] as AlertLifecycleListener[], resolved: [] as AlertLifecycleListener[] };
  constructor(private readonly host: AlertHost) {
    const database = host.database ?? memoryAdapter();
    if (!database.capabilities?.transactions?.supported || typeof database.transaction !== 'function') throw new TypeError('Alerts require a shared DB adapter with transactions');
    this.db = wrapWithSchema(database, {...getAlertSchema(),...getBusinessSchema()});
    this.namespace = host.config?.namespace ?? host.name;
    if (!text(this.namespace, 128)) throw new TypeError('Invalid alert namespace');
    this.config = { pagerDutyEndpoint: 'https://events.pagerduty.com/v2/enqueue', maxObservations: 10000, maxPendingPerAlert: 100, timeoutMs: 10000, leaseMs: 30000, maxAttempts: 5, ...host.config };
    if (this.config.email !== undefined) this.config.email = validateEmailConfig(this.config.email);
    let endpoint: URL;
    try { endpoint = new URL(this.config.pagerDutyEndpoint!); } catch { throw new TypeError('Invalid PagerDuty endpoint'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || this.config.pagerDutyEndpoint!.length > 4096) throw new TypeError('Invalid PagerDuty endpoint');
    for (const key of ['maxObservations', 'maxPendingPerAlert', 'timeoutMs', 'leaseMs', 'maxAttempts'] as const) if (!Number.isSafeInteger(this.config[key]) || this.config[key] < 1) throw new TypeError(`Invalid alert ${key}`);
    if (this.config.timeoutMs > 60000 || this.config.leaseMs < this.config.timeoutMs + 100 || this.config.leaseMs > 300000 || this.config.maxAttempts > 100 || this.config.maxPendingPerAlert > 1000 || this.config.maxObservations > 1000000) throw new TypeError('Alert runtime bounds exceeded');
  }
  private async transaction<T>(action: (tx: TransactionAdapter) => Promise<T>, migration = false): Promise<T> {
    const started = performance.now();
    for (let attempt = 0; ; attempt++) {
      const rolledBack = new Error('Owned transaction rollback sentinel');
      let cause: unknown;
      try {
        return await this.db.transaction(async tx => {
          try {
            if (!migration) { const owner = await tx.findOne<{ protocol: string }>({ model: ALERT_RUNTIME, where: [{ field: 'id', operator: 'eq', value: this.namespace }] }); if (owner && owner.protocol !== PROTOCOL) throw new Error('Alert namespace belongs to an incompatible dispatch protocol'); }
            return await action(tx);
          }
          catch (error) {
            const code = (error as { code?: string })?.code;
            // Audited shared Kysely adapter preserves callback errors; Kysely
            // awaits rollback before rethrowing, replacing this sentinel if
            // rollback fails. Other adapters fail closed without retry.
            if (this.db.id === 'kysely' && (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || error instanceof MarkerCollision)) {
              cause = error instanceof MarkerCollision ? error.original : error; throw rolledBack;
            }
            throw error;
          }
        });
      } catch (error) {
        // A COMMIT-time busy error never came from our body sentinel and must
        // propagate. No external provider work occurs in these closures.
        if (error !== rolledBack) throw error;
        if (attempt >= 2 || performance.now() - started >= 50) throw cause;
        await new Promise(resolve => setTimeout(resolve, 1 + Math.floor(Math.random() * 4)));
      }
    }
  }
  private where(id?: string): WhereClause[] { return [{ field: 'namespace', operator: 'eq', value: this.namespace }, ...(id ? [{ field: 'id', operator: 'eq' as const, value: id }] : [])]; }
  private async row(id: string, db: DB = this.db): Promise<Row> {
    if (!text(id, 128)) throw new TypeError('Invalid alert id');
    const row = await db.findOne<Row>({ model: ALERTS, where: this.where(id) });
    if (!row) throw new Error('Alert not found'); return row;
  }
  private public(record: AlertRecord): PublicAlert { const { pagerDuty: _internal, ...value } = copy(record); return { ...value, channels: record.channels.map(channel => ({ type: channel.type, configured: channel.type !== 'email' || !!(this.config.emailSender || this.config.email) })) }; }
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
      if (channel.type === 'email' && (!(this.config.emailSender || this.config.email) || !Array.isArray(channel.recipients) || !channel.recipients.length || channel.recipients.length > (this.config.emailSender ? 100 : 50) || channel.recipients.some(recipient => this.config.emailSender ? !text(recipient, 320) : !validEmail(recipient)))) throw new TypeError('Email alerts require recipients and a configured sender');
      if (channel.type === 'pagerduty' && (!text(channel.integrationKey, 1024) || (channel.severity !== undefined && !['info', 'warning', 'error', 'critical'].includes(channel.severity)))) throw new TypeError('Invalid PagerDuty channel');
      if (channel.type === 'slack' || channel.type === 'webhook') {
        let url: URL; try { url = new URL(channel.webhook!); } catch { throw new TypeError('Invalid alert webhook'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || channel.webhook!.length > 4096) throw new TypeError('Invalid alert webhook');
      }
    }
    const routes = input.channels.filter(channel => channel.type === 'pagerduty').map(pagerDutyRoute);
    if (new Set(routes).size !== routes.length) throw new TypeError('Duplicate PagerDuty route');
    if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw new TypeError('Alert definition exceeds 32 KiB');
    // Store only supported fields: callers cannot inject state or unbounded notes.
    const { name, description, enabled, condition, channels, severity, tags, runbook, autoResolve } = input;
    return copy({ name, description, enabled, condition, channels, severity, tags, runbook, autoResolve });
  }
  create(input: AlertConfig): Promise<PublicAlert> {
    const config = this.validate(input);
    return this.host.admit(async () => {
      await this.assertDispatchProtocol();
      const now = Date.now(); const id = randomUUID();
      const record: AlertRecord = { ...config, id, enabled: config.enabled ?? true, state: 'normal', createdAt: now, updatedAt: now, notes: [], pendingNotifications: 0 };
      await this.transaction(tx => tx.create({ model: ALERTS, data: { id, namespace: this.namespace, state: record.state, revision: 0, payload: record } }));
      return this.public(record);
    });
  }
  createGoal(input:GoalConfig):Promise<GoalConfig>{
    const goal=validateGoal(input),id=goalId(this.host.name,goal.name),condition:GoalCondition={type:'business-goal',goal,app:this.host.name,operator:'below-pace'};
    const enabled=goal.alerts?.notify_below_pace===true;
    const config=enabled?this.validate({name:goal.name,condition,channels:namedPatternChannels(goal.alerts!.channels,this.config.namedChannels),autoResolve:{enabled:true,condition:{...condition,operator:'on-pace'}}}):undefined;
    return this.host.admit(async()=>{if(config)await this.assertDispatchProtocol();await this.transaction(async tx=>{
      await tx.create({model:BUSINESS_DEFINITIONS,data:{id,namespace:this.host.name,kind:'goal',name:goal.name,payload:{protocol:'goal-v1',config:goal}}});
      if(config){const now=Date.now(),alertId=goalId(this.host.name,goal.name,'goal-alert');const record:AlertRecord={...config,id:alertId,enabled:true,state:'normal',createdAt:now,updatedAt:now,notes:[],pendingNotifications:0};await tx.create({model:ALERTS,data:{id:alertId,namespace:this.namespace,state:'normal',revision:0,payload:record}});}
    },!config);return copy(goal);},true);
  }
  getGoal(name:string):Promise<GoalConfig>{
    if(!text(name,255))throw new TypeError('Invalid goal name');
    return this.host.admit(async()=>{const row=await this.db.findOne<{id:string;namespace:string;kind:string;name:string;payload:{protocol:string;config:GoalConfig}}>({model:BUSINESS_DEFINITIONS,where:[{field:'id',operator:'eq',value:goalId(this.host.name,name)},{field:'namespace',operator:'eq',value:this.host.name}]});if(!row)throw new Error('Goal not found');if(row.kind!=='goal'||row.name!==name||row.namespace!==this.host.name||row.payload?.protocol!=='goal-v1')throw new Error('Invalid stored goal');const config=validateGoal(row.payload.config);if(config.name!==name)throw new Error('Invalid stored goal identity');return config;},true);
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
      const routes = (channels: AlertChannel[]) => channels.filter(channel => channel.type === 'pagerduty').map(pagerDutyRoute).sort().join(',');
      if (routes(config.channels) !== routes(record.channels) && (active(record) || (record.pagerDuty && Object.keys(record.pagerDuty.tails).some(route => !record.pagerDuty!.settled.includes(route))))) throw new Error('PagerDuty routes cannot change while incident obligations remain');
      // A full definition replacement must remove omitted recovery/routing metadata.
      for (const key of ['description', 'severity', 'tags', 'runbook', 'autoResolve'] as const) delete record[key];
      Object.assign(record, config, { enabled: config.enabled ?? record.enabled });
    }));
  }
  onTrigger(callback: AlertLifecycleListener) { if (typeof callback !== 'function') throw new TypeError('Alert listener must be a function'); this.listeners.triggered.push(callback); }
  onResolve(callback: AlertLifecycleListener) { if (typeof callback !== 'function') throw new TypeError('Alert listener must be a function'); this.listeners.resolved.push(callback); }
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
      for (let row of rows) {
        if (!row.payload.enabled) continue;
        const goalDefinitions=new Map<string,GoalConfig>();
        const patterns = new Map<string, LogPatternCondition>();
        const ranges = new Map<string, { metric: string; from: number | undefined }>();
        const collect = (condition: AlertCondition): void => {
          if(condition.type==='business-goal'){if(condition.app!==this.host.name)throw new Error('Goal application mismatch');goalDefinitions.set(JSON.stringify(condition.goal),condition.goal);return;}
          if (condition.type === 'composite') { condition.conditions.forEach(collect); return; }
          if (condition.type === 'log-pattern') { patterns.set(logPatternObservationKey(condition, now - alertWindowMs(condition.window)), condition); return; }
          const from = condition.type === 'anomaly' ? undefined : now - alertWindowMs(condition.window);
          ranges.set(JSON.stringify([condition.metric, from ?? null]), { metric: condition.metric, from });
        };
        collect(row.payload.condition); if (row.payload.autoResolve?.enabled) collect(row.payload.autoResolve.condition);
        const observations = new Map<string, AlertMetricPoint[]>();
        for (const [key, { metric, from }] of ranges) observations.set(key, await this.host.observations(metric, from, now, this.config.maxObservations));
        const patternCounts = new Map<string, number>();
        for (const [key, condition] of patterns) {
          if (!this.host.logPatternCount) throw new Error('Log pattern evaluation is unavailable');
          patternCounts.set(key, await this.host.logPatternCount(condition, now - alertWindowMs(condition.window), now, this.config.maxObservations));
        }
        const goalValues=new Map<string,GoalProgress>();
        for(const [key,goal]of goalDefinitions){if(!this.host.goalProgress)throw new Error('Goal observations unavailable');if(now>=Date.parse(goal.startDate))goalValues.set(key,await this.host.goalProgress(goal,now,this.config.maxObservations));}
        if(row.payload.condition.type==='business-goal'){
          const period=goalValues.get(JSON.stringify(row.payload.condition.goal))?.periodStart;
          if(period!==undefined&&row.payload.goalPeriodStart!==period){
            const expectedRevision=row.revision+1;
            await this.mutate(row.id,record=>{
              if((record.lastEvaluated??-Infinity)>now)throw new Error('Goal evaluation time moved backwards');
              record.goalPeriodStart=period;record.lastEvaluated=now;
              if(active(record)){record.state='resolved';record.resolvedAt=now;record.resolvedBy='goal-period-ended';return {event:'resolved' as const};}
            },now,row.revision);
            row=await this.row(row.id);
            if(row.revision!==expectedRevision)throw new Conflict('Alert changed during goal period rollover');
          }
        }
        let matched: boolean | null = null;
        const alert = await this.mutate(row.id, record => {
          // Definition edits race safely: re-read observations on a later evaluation.
          if (JSON.stringify(record.condition) !== JSON.stringify(row.payload.condition) || JSON.stringify(record.autoResolve) !== JSON.stringify(row.payload.autoResolve)) throw new Conflict('Alert definition changed during evaluation');
          if (!record.enabled || (record.lastEvaluated ?? -Infinity) > now) return;
          const result = this.evaluator.evaluateResult(record.condition, new Map(), now, observations, patternCounts,goalValues); matched = result.matched;
          record.lastEvaluated = now;
          if (result.matched === true && !active(record)) { this.triggerState(record, now); return { event: 'triggered' as const, value: result.value }; }
          if (active(record) && record.autoResolve?.enabled) {
            const recovery = this.evaluator.evaluateResult(record.autoResolve.condition, new Map(), now, observations, patternCounts,goalValues);
            if (recovery.matched === true) { record.state = 'resolved'; record.resolvedAt = now; record.resolvedBy = 'autoResolve'; return { event: 'resolved' as const, value: recovery.value, threshold: record.autoResolve.condition.type === undefined || record.autoResolve.condition.type === 'threshold' || record.autoResolve.condition.type === 'log-pattern' ? record.autoResolve.condition.threshold : undefined }; }
          }
        }, now, row.revision);
        results.push({ alert, observed: matched !== null, matched });
      }
      return { results, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
    }, true);
  }
  private async mutate(id: string, change: (record: AlertRecord, now: number) => { event: AlertNotification['event']; value?: number; threshold?: number } | void, now = Date.now(), expectedRevision?: number): Promise<PublicAlert> {
    await this.assertDispatchProtocol();
    const committed = await this.transaction(async tx => {
      const row = await this.row(id, tx);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Conflict('Alert changed during evaluation; retry');
      const record = copy(row.payload), transition = change(record, now);
      record.updatedAt = now;
      if (transition?.event === 'triggered' && (record.condition.type === undefined || record.condition.type === 'threshold' || record.condition.type === 'log-pattern')) transition.threshold = record.condition.threshold;
      if (transition && record.pendingNotifications + record.channels.length > this.config.maxPendingPerAlert) throw new Error('Alert notification capacity reached; reconcile parked obligations');
      const jobs: Job[] = [];
      if (transition) {
        record.pendingNotifications += record.channels.length;
        const previous = record.pagerDuty;
        if (transition.event === 'triggered') record.pagerDuty = { episode: randomUUID(), tails: {}, settled: [] };
        for (const channel of record.channels) {
          const jobId = randomUUID();
          const notification: AlertNotification = { id: jobId, event: transition.event, timestamp: now, value: transition.value, threshold: transition.threshold,
            alert: { id, name: record.name, severity: record.severity ?? 'warning', state: record.state, description: record.description, runbook: record.runbook, triggeredAt: record.triggeredAt } };
          const payload: Job['payload'] = { notification, channel };
          if (channel.type === 'pagerduty' && record.pagerDuty) {
            const sequence = record.pagerDuty, route = pagerDutyRoute(channel);
            const prior = transition.event === 'triggered' ? previous : sequence;
            const predecessor = prior?.tails[route] ?? null;
            // Legacy active incidents have no trustworthy trigger identity.
            if (transition.event === 'triggered' || predecessor) {
              payload.pagerDuty = { episode: sequence.episode, route, predecessor, predecessorEpisode: predecessor ? prior!.episode : null };
              sequence.tails[route] = jobId; sequence.settled = sequence.settled.filter(value => value !== route);
            }
          }
          jobs.push({ id: jobId, namespace: this.namespace, alertId: id, revision: 0, state: 'pending', availableAt: now, leaseToken: null, attempts: 0, predecessorId: payload.pagerDuty?.predecessor ?? null, completedAt: null, payload });
        }
      }
      const changed = await tx.updateMany({ model: ALERTS, where: [...this.where(id), { field: 'revision', operator: 'eq', value: row.revision }], data: { revision: row.revision + 1, state: record.state, payload: record } });
      if (changed !== 1) throw new Conflict('Concurrent alert update; retry');
      for (const job of jobs) await tx.create({ model: ALERT_OUTBOX, data: job });
      return { record, transition };
    });
    const result = this.public(committed.record);
    if (committed.transition?.event === 'triggered' || committed.transition?.event === 'resolved') {
      const context: AlertLifecycleContext = { value: committed.transition.value, threshold: committed.transition.threshold, triggeredAt: committed.record.triggeredAt, timestamp: now, duration: now - (committed.record.triggeredAt ?? now) };
      const failures = await Promise.allSettled(this.listeners[committed.transition.event].map(callback => Promise.resolve().then(() => callback(copy(result), copy(context)))));
      // Durable state/outbox already committed; listener failures never undo them or retry sends.
      if (failures.some(outcome => outcome.status === 'rejected')) throw new Error('Alert transition committed; one or more listeners failed');
    }
    return result;
  }
  notifications(options: { limit?: number; after?: string } = {}) {
    const limit = this.limit(options.limit);
    return this.host.admit(async () => (await this.db.findMany<Job>({ model: ALERT_OUTBOX, where: [...this.where(), ...(options.after ? [{ field: 'id', operator: 'gt' as const, value: options.after }] : [])], orderBy: [{ field: 'id', direction: 'asc' }], limit })).map(job => ({ id: job.id, alertId: job.alertId, state: job.state, attempts: job.attempts, availableAt: job.availableAt, event: job.payload.notification.event, outcome: job.payload.delivery?.outcome ?? 'pending' })));
  }
  private async assertDispatchProtocol(): Promise<void> {
    await this.transaction(async tx => {
      const row = await tx.findOne<{ protocol: string }>({ model: ALERT_RUNTIME, where: [{ field: 'id', operator: 'eq', value: this.namespace }] });
      if (row) { if (row.protocol !== PROTOCOL) throw new Error('Alert namespace belongs to an incompatible dispatch protocol'); return; }
      const alert = await tx.findOne({ model: ALERTS, where: this.where() });
      const job = await tx.findOne({ model: ALERT_OUTBOX, where: this.where() });
      if (alert || job) throw new Error('Existing alert rows require explicit namespace ownership migration');
      try { await tx.create({ model: ALERT_RUNTIME, data: { id: this.namespace, protocol: PROTOCOL } }); }
      catch (error) {
        const code = (error as { code?: string })?.code;
        if (this.db.id === 'kysely' && ['ADAPTER_DUPLICATE_KEY', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(code ?? '')) throw new MarkerCollision(error);
        throw error;
      }
    });
  }
  /** Offline host operation: all legacy writers and provider work must be stopped. */
  migrateStoppedLegacyNamespace(options: { limit?: number } = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Migration limit must be 1..1000');
    return this.host.admit(() => this.transaction(async tx => {
      const owner = await tx.findOne<{ protocol: string }>({ model: ALERT_RUNTIME, where: [{ field: 'id', operator: 'eq', value: this.namespace }] });
      if (owner?.protocol !== 'ts-v1') throw new Error('Migration requires an existing ts-v1 namespace');
      const alerts = await tx.findMany<Row>({ model: ALERTS, where: this.where(), limit: limit + 1 });
      const jobs = await tx.findMany<Job>({ model: ALERT_OUTBOX, where: this.where(), limit: limit + 1 });
      if (alerts.length > limit || jobs.length > limit) throw new Error('Migration scan capacity exceeded');
      if (alerts.some(row => active(row.payload) && row.payload.channels.some(channel => channel.type === 'pagerduty')) || jobs.some(job => job.payload.channel?.type === 'pagerduty' || job.payload.pagerDuty)) throw new Error('Legacy PagerDuty obligations require explicit incident migration');
      for (const job of jobs) { this.validJob(job, true); if (job.payload.delivery) throw new Error('Legacy migration cannot reinterpret retained delivery receipts'); }
      let parked = 0;
      for (const job of jobs) {
        if (job.attempts > 0 || job.state !== 'pending') { await this.park(tx, job, 'unknown', 'legacy-migration'); parked++; }
      }
      const changed = await tx.updateMany({ model: ALERT_RUNTIME, where: [{ field: 'id', operator: 'eq', value: this.namespace }, { field: 'protocol', operator: 'eq', value: 'ts-v1' }], data: { protocol: 'ts-v2' } });
      if (changed !== 1) throw new Conflict('Concurrent namespace migration');
      return { alerts: alerts.length, notifications: jobs.length, parked, protocol: 'ts-v2' };
    }, true));
  }
  private retention() { return new ReceiptRetention(this.namespace, (action, migration) => this.transaction(action, migration), job => this.validJob(job, true)); }
  receiptRetentionStatus() { return this.host.admit(() => this.retention().status()); }
  migrateReceiptRetention(options: { limit?: number } = {}) {
    return this.host.admit(() => this.retention().migrate(options.limit));
  }
  pruneNotifications(options: { completedBefore: number; limit?: number; after?: { completedAt: number; id: string } }) {
    return this.host.admit(async () => { await this.assertDispatchProtocol(); return this.retention().prune(options); });
  }
  dismissNotification(id: string) {
    if (!text(id, 128)) throw new TypeError('Invalid notification id');
    return this.reconcileNotification(id, { outcome: 'dismissed', actor: 'operator', reason: 'Explicit dismissNotification call' });
  }
  reconcileNotification(id: string, input: { outcome: 'delivered' | 'dismissed'; actor: string; reason: string }) {
    const { outcome, actor, reason } = input;
    if (!text(id, 128) || !['delivered', 'dismissed'].includes(outcome) || !text(actor, 255) || !text(reason, 4096)) throw new TypeError('Reconciliation requires id, outcome, actor and reason');
    return this.host.admit(async () => {
      await this.assertDispatchProtocol();
      return this.transaction(async tx => {
        const job = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(id) });
        if (!job) return false;
        this.validJob(job);
        if (['delivered', 'dismissed'].includes(job.payload.delivery?.outcome ?? '')) return false;
        if (job.state !== 'dead') throw new Error('Only parked notifications can be reconciled');
        return this.receipt(tx, job, outcome, actor, reason);
      });
    });
  }
  private validJob(job: Job, legacy = false) {
    if (!legacy) validateReceiptProjection(job);
    const value = job.payload;
    if (!value || Buffer.byteLength(JSON.stringify(value)) > 524288 || value.notification?.id !== job.id || value.notification?.alert?.id !== job.alertId
        || !['triggered', 'acknowledged', 'resolved'].includes(value.notification.event)
        || !Number.isSafeInteger(job.revision) || job.revision < 0 || job.revision >= Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > 100) throw new TypeError('Invalid notification payload');
  }
  private async receipt(tx: TransactionAdapter, job: Job, outcome: 'delivered' | 'dismissed', actor?: string, reason?: string) {
    const row = await this.row(job.alertId, tx), record = copy(row.payload);
    if (!Number.isSafeInteger(record.pendingNotifications) || record.pendingNotifications < 1) throw new Conflict('Invalid notification accounting');
    record.pendingNotifications--;
    if (outcome === 'delivered') {
      record.lastNotification = { event: job.payload.notification.event, deliveredAt: Date.now() };
      const metadata = job.payload.pagerDuty, sequence = record.pagerDuty;
      if (metadata && sequence?.tails[metadata.route] === job.id) sequence.settled = [...new Set([...sequence.settled, metadata.route])];
    }
    const count = await tx.updateMany({ model: ALERTS, where: [...this.where(row.id), { field: 'revision', operator: 'eq', value: row.revision }], data: { revision: row.revision + 1, state: record.state, payload: record } });
    if (count !== 1) throw new Conflict('Concurrent alert delivery; retry');
    const payload: Job['payload'] = { notification: job.payload.notification, delivery: { outcome, completedAt: Date.now(), ...(actor ? { actor, reason } : {}) }, ...(job.payload.pagerDuty ? { pagerDuty: job.payload.pagerDuty } : {}) };
    const changed = await tx.updateMany({ model: ALERT_OUTBOX, where: [...this.where(job.id), { field: 'revision', operator: 'eq', value: job.revision }], data: { state: 'dead', leaseToken: null, revision: job.revision + 1, payload, completedAt: payload.delivery!.completedAt, predecessorId: outcome === 'delivered' ? null : job.predecessorId } });
    if (changed !== 1) throw new Conflict('Concurrent notification completion');
    return true;
  }
  private async park(tx: TransactionAdapter, job: Job, outcome: 'unknown' | 'rejected', reason: string) {
    const payload = copy(job.payload); payload.delivery = { outcome, reason };
    const changed = await tx.updateMany({ model: ALERT_OUTBOX, where: [...this.where(job.id), { field: 'revision', operator: 'eq', value: job.revision }], data: { state: 'dead', leaseToken: null, revision: job.revision + 1, payload } });
    if (changed !== 1) throw new Conflict('Concurrent notification update');
  }
  private async claim(id: string): Promise<Job | null> {
    return this.transaction(async tx => {
      const job = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(id) });
      if (!job || !['pending', 'sending'].includes(job.state) || job.availableAt > Date.now()) return null;
      this.validJob(job);
      if (job.state === 'sending') { await this.park(tx, job, 'unknown', 'expired-lease'); return null; }
      const channel = job.payload.channel;
      if (!channel) throw new TypeError('Missing notification channel');
      // Missing host configuration must not consume an attempt or obligation.
      if (channel.type === 'email' && !(this.config.emailSender || this.config.email)) return null;
      this.validate({ name: 'dispatch', condition: { metric: 'dispatch', window: '1m', operator: 'gt', threshold: 0 }, channels: [channel] });
      if (channel.type === 'pagerduty') {
        const metadata = job.payload.pagerDuty, event = job.payload.notification.event;
        if (!metadata || !text(metadata.episode, 128) || metadata.route !== pagerDutyRoute(channel)) throw new TypeError('PagerDuty job requires incident metadata migration');
        if (metadata.predecessor === null) {
          if (event !== 'triggered' || metadata.predecessorEpisode !== null) throw new TypeError('Missing PagerDuty predecessor');
        } else {
          if (!text(metadata.predecessor, 128)) throw new TypeError('Invalid PagerDuty predecessor');
          const previous = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(metadata.predecessor) });
          if (!previous) throw new TypeError('Missing retained PagerDuty predecessor receipt');
          this.validJob(previous);
          const prior = previous.payload.pagerDuty;
          if (previous.alertId !== job.alertId || prior?.episode !== metadata.predecessorEpisode || prior?.route !== metadata.route
              || (event === 'triggered' && (previous.payload.notification.event !== 'resolved' || prior.episode === metadata.episode))
              || (event !== 'triggered' && prior.episode !== metadata.episode)) throw new TypeError('Invalid PagerDuty predecessor ownership');
          if (previous.payload.delivery?.outcome !== 'delivered') return null;
        }
      }
      if (job.attempts >= this.config.maxAttempts) { await this.park(tx, job, 'rejected', 'retry-limit'); return null; }
      const update = { state: 'sending', revision: job.revision + 1, leaseToken: randomUUID(), availableAt: Date.now() + this.config.leaseMs, attempts: job.attempts + 1 };
      const count = await tx.updateMany({ model: ALERT_OUTBOX, where: [...this.where(id), { field: 'revision', operator: 'eq', value: job.revision }], data: update });
      if (count === 0) return null;
      if (count !== 1) throw new Conflict('Concurrent notification claim');
      return { ...job, ...update };
    });
  }
  private async settle(claimed: Job, outcome: Outcome) {
    return this.transaction(async tx => {
      const job = await tx.findOne<Job>({ model: ALERT_OUTBOX, where: this.where(claimed.id) });
      if (!job || job.state !== 'sending' || job.leaseToken !== claimed.leaseToken || job.revision !== claimed.revision || job.availableAt <= Date.now()) return false;
      this.validJob(job);
      if (outcome.outcome === 'delivered') return this.receipt(tx, job, 'delivered');
      if (outcome.outcome !== 'retryable' || job.attempts >= this.config.maxAttempts) {
        await this.park(tx, job, outcome.outcome === 'unknown' ? 'unknown' : 'rejected', outcome.outcome === 'retryable' ? 'retry-limit' : 'provider-outcome'); return true;
      }
      const payload = copy(job.payload); payload.delivery = { outcome: 'pending', reason: 'safe-retry' };
      const changed = await tx.updateMany({ model: ALERT_OUTBOX, where: [...this.where(job.id), { field: 'revision', operator: 'eq', value: job.revision }], data: { state: 'pending', revision: job.revision + 1, leaseToken: null, availableAt: Date.now() + Math.max(outcome.retryAfter ?? 0, Math.min(60000, 1000 * 2 ** Math.min(job.attempts - 1, 6))), payload } });
      if (changed !== 1) throw new Conflict('Concurrent notification update'); return true;
    });
  }
  processNotifications(options: { limit?: number; after?: string } = {}) {
    const limit = this.limit(options.limit), after = options.after;
    if (after !== undefined && !text(after, 128)) throw new TypeError('Invalid notification cursor');
    return this.host.admit(async () => {
      await this.assertDispatchProtocol();
      const rows = await this.db.findMany<Job>({ model: ALERT_OUTBOX, where: [...this.where(), { field: 'state', operator: 'in', value: ['pending', 'sending'] }, { field: 'availableAt', operator: 'lte', value: Date.now() }, ...(after ? [{ field: 'id', operator: 'gt' as const, value: after }] : [])], orderBy: [{ field: 'id', direction: 'asc' }], limit });
      let processed = 0;
      for (const row of rows) {
        const provider = row.payload?.channel?.type === 'email' && this.config.email && !this.config.emailSender ? await loadSesProvider() : undefined;
        const job = await this.claim(row.id); if (!job) continue;
        processed++;
        const outcome = await this.send(job.payload.notification, job.payload.channel!, job.payload.pagerDuty, provider);
        // A failed/ambiguous local receipt commit preserves the lease. Never
        // convert a persistence failure into permission to send again.
        await this.settle(job, outcome);
      }
      return { processed, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
    }, true);
  }
  private async send(notification: AlertNotification, channel: AlertChannel, metadata?: PagerDutyJob, provider?: Awaited<ReturnType<typeof loadSesProvider>>): Promise<Outcome> {
    const controller = new AbortController(), deadline = Date.now() + this.config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const timely = () => !controller.signal.aborted && Date.now() < deadline;
    try {
      if (channel.type === 'email' && !this.config.emailSender) {
        if (!this.config.email || !provider) return { outcome: 'unknown' };
        const delivered = await sendSesEmail(notification, channel, this.config.email, provider, controller.signal);
        return { outcome: delivered && timely() ? 'delivered' : 'unknown' };
      }
      if (channel.type === 'email' || (channel.type === 'pagerduty' && this.config.pagerDutySender)) {
        const sender = channel.type === 'email' ? this.config.emailSender : this.config.pagerDutySender;
        if (!sender) return { outcome: 'unknown' };
        // Legacy callbacks retain ownership until they settle; AbortSignal is
        // cooperative and cannot provide a hard bound for arbitrary host code.
        await sender(copy(notification), copy(channel), controller.signal);
        return { outcome: timely() ? 'delivered' : 'unknown' };
      }
      const payload = channel.type === 'pagerduty' ? pagerDutyRequest(this.namespace, notification, channel, metadata!)
        : channel.type === 'slack' ? { text: `[${notification.alert.severity}] ${notification.alert.name}: ${notification.event}` } : notification;
      const endpoint = channel.type === 'pagerduty' ? this.config.pagerDutyEndpoint! : channel.webhook!;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': notification.id, 'accept-encoding': 'identity' }, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' });
      try {
        if (response.ok) {
          if (channel.type === 'pagerduty' || channel.type === 'slack') {
            if ((response.headers.get('content-encoding') ?? 'identity') !== 'identity') return { outcome: 'unknown' };
            const maximum = channel.type === 'pagerduty' ? 4096 : 1024, reader = response.body?.getReader();
            const chunks: Uint8Array[] = []; let size = 0;
            if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { await reader.cancel(); return { outcome: 'unknown' }; } chunks.push(part.value); } } finally { reader.releaseLock(); }
            const body = Buffer.concat(chunks).toString('utf8');
            if (channel.type === 'slack') { if (response.status !== 200 || body.trim() !== 'ok') return { outcome: 'unknown' }; }
            else { const receipt = JSON.parse(body); if (response.status !== 202 || receipt?.status !== 'success' || receipt.dedup_key !== (payload as Record<string, unknown>).dedup_key) return { outcome: 'unknown' }; }
          }
          return { outcome: timely() ? 'delivered' : 'unknown' };
        }
        if (response.status === 429 && channel.type === 'slack') {
          const value = response.headers.get('retry-after') ?? '';
          if (/^\d{1,5}$/.test(value) && Number(value) <= 86400) return { outcome: 'retryable', retryAfter: Number(value) * 1000 };
          return { outcome: 'rejected' };
        }
        return { outcome: [400, 401, 403, 404, 410, 422].includes(response.status) ? 'rejected' : 'unknown' };
      } finally { await response.body?.cancel().catch(() => {}); }
    } catch (error) { if (error instanceof EmailCleanupError) throw error; return { outcome: 'unknown' }; }
    finally { clearTimeout(timeout); }
  }
}
