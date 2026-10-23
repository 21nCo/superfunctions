import { createHash } from 'node:crypto';
import type { AlertChannel, AlertNotification } from '../types';
export interface PagerDutyJob { episode: string; route: string; predecessor: string | null; predecessorEpisode: string | null }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const pagerDutyRoute = (channel: AlertChannel) => hash(channel.integrationKey!);
// JSON escaping is pinned to Python's ensure_ascii=True wire identity.
const asciiJSON = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
export function pagerDutyRequest(namespace: string, notification: AlertNotification, channel: AlertChannel, metadata: PagerDutyJob) {
  const action = { triggered: 'trigger', acknowledged: 'acknowledge', resolved: 'resolve' }[notification.event];
  const body: Record<string, unknown> = { routing_key: channel.integrationKey, event_action: action,
    dedup_key: 'watchfn:' + hash(asciiJSON([namespace, notification.alert.id, metadata.episode])) };
  if (action === 'trigger') body.payload = { summary: notification.alert.name, source: namespace,
    severity: channel.severity ?? notification.alert.severity,
    custom_details: { alertId: notification.alert.id, description: notification.alert.description ?? '' } };
  return body;
}
