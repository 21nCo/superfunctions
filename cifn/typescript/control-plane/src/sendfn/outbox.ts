import type { DatabaseStore } from '../store/database-store.js';
import type { ControlPlaneStore } from '../store/store.js';
import { deliverSendFnEmail, type EmailDeliveryResult } from './email-transport.js';
import type { SendFnNotification, NotificationDestination } from './sendfn-client.js';

export interface NotificationIntent {
  id: string;
  destination: NotificationDestination;
  payload: SendFnNotification & { eventId: string };
  attempts: number;
  nextAttemptAt: number;
  lease?: { token: string; expiresAt: number };
  deliveredAt?: string;
  emailReceipt?: { transactionId: string; status: 'sent' | 'delivered' };
  reconciliation?: { reason: string; transactionId?: string; at: string };
}
export type NotificationStore = Pick<DatabaseStore, 'configureNotifications' | 'listNotificationRuns' | 'claimNotification' | 'finishNotification'>;
export function isNotificationStore(store: ControlPlaneStore): store is ControlPlaneStore & NotificationStore {
  const value = store as Partial<NotificationStore>;
  return ['configureNotifications', 'listNotificationRuns', 'claimNotification', 'finishNotification']
    .every(key => typeof value[key as keyof NotificationStore] === 'function');
}
export const NOTIFICATION_TIMEOUT_MS = 3_000;
export const NOTIFICATION_LEASE_MS = 10_000;
export const notificationBackoff = (attempts: number) => Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));

/** At-least-once HTTP delivery. Receiver deduplication uses the stable event ID. */
export class NotificationPublisher {
  private cursor?: string;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: NotificationStore) {}
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      const page = await this.store.listNotificationRuns(this.cursor);
      for (const runId of page.runIds) {
        const intent = await this.store.claimNotification(runId, Date.now(), NOTIFICATION_LEASE_MS);
        if (!intent?.lease) continue;
        let delivered: boolean | EmailDeliveryResult = false;
        if (typeof intent.destination !== 'string') {
          delivered = await deliverSendFnEmail(intent.destination, intent.payload, intent.id);
          await this.store.finishNotification(runId, intent.id, intent.lease.token, delivered, Date.now());
          continue;
        }
        try {
          const response = await fetch(intent.destination, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': intent.id, 'X-CiFn-Event-Id': intent.id },
            body: JSON.stringify(intent.payload), signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS), redirect: 'error',
          });
          delivered = response.ok;
          await response.body?.cancel();
        } catch { /* Never include destination credentials or payload in diagnostics. */ }
        await this.store.finishNotification(runId, intent.id, intent.lease.token, delivered, Date.now());
      }
      this.cursor = page.nextCursor;
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
  start(): void {
    if (this.timer) return;
    const tick = () => { void this.tick().catch(() => console.error('CiFn notification delivery pending retry')); };
    this.timer = setInterval(tick, 1_000); this.timer.unref(); tick();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.active; }
}
