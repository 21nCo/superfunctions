import type { AlertCondition } from './conditions';
export interface AlertChannel {
  type: 'email' | 'slack' | 'pagerduty' | 'webhook';
  recipients?: string[]; webhook?: string; integrationKey?: string; channel?: string;
}
export interface AlertConfig {
  name: string; description?: string; enabled?: boolean; condition: AlertCondition;
  channels: AlertChannel[]; severity?: 'info' | 'warning' | 'error' | 'critical';
  tags?: string[]; runbook?: string;
  autoResolve?: { enabled: boolean; condition: AlertCondition };
}
export interface AlertNotification {
  id: string; event: 'triggered' | 'resolved' | 'acknowledged'; timestamp: number;
  alert: { id: string; name: string; severity: string; state: string; description?: string; runbook?: string; triggeredAt?: number };
  value?: number;
}
/** Senders must honor AbortSignal and use notification.id for downstream deduplication. */
export type AlertSender = (notification: AlertNotification, channel: AlertChannel, signal: AbortSignal) => Promise<void>;
export interface AlertRuntimeConfig {
  namespace?: string; maxObservations?: number; maxPendingPerAlert?: number;
  timeoutMs?: number; leaseMs?: number; maxAttempts?: number;
  emailSender?: AlertSender; pagerDutySender?: AlertSender;
}
export interface AlertNote { content: string; createdBy: string; createdAt: number }
export interface AlertRecord extends AlertConfig {
  id: string; enabled: boolean; state: 'normal' | 'triggered' | 'acknowledged' | 'resolved';
  createdAt: number; updatedAt: number; triggeredAt?: number; resolvedAt?: number;
  acknowledgedBy?: string; resolvedBy?: string; lastEvaluated?: number;
  notes: AlertNote[]; pendingNotifications: number; lastNotification?: { event: string; deliveredAt: number };
}
export interface PublicAlert extends Omit<AlertRecord, 'channels'> { channels: { type: AlertChannel['type']; configured: boolean }[] }
