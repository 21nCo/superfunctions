export interface SendFnNotification {
  runId: string;
  status: 'success' | 'failure' | 'cancelled';
  pipelineRef: { repo: string; ref: string; configPath?: string };
  trigger: { type: string; payload?: Record<string, unknown> };
  createdAt: string;
  completedAt: string;
  summary: string;
}

export interface SendFnClient {
  sendNotification(notification: SendFnNotification): Promise<boolean>;
}

export interface SendFnConfig {
  enabled: boolean;
  webhookUrl?: string;
  emailTo?: string;
}

/**
 * Memory/mock SendFn client for testing
 */
export class MemorySendFnClient implements SendFnClient {
  public sentNotifications: SendFnNotification[] = [];

  async sendNotification(notification: SendFnNotification): Promise<boolean> {
    this.sentNotifications.push(notification);
    return true;
  }

  reset() {
    this.sentNotifications = [];
  }
}

/**
 * Webhook-based SendFn client
 */
export class WebhookSendFnClient implements SendFnClient {
  constructor(private webhookUrl: string) {}

  async sendNotification(notification: SendFnNotification): Promise<boolean> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(3_000), redirect: 'error',
      });
      const delivered = response.ok;
      await response.body?.cancel();
      return delivered;
    } catch (err) {
      console.error('CiFn webhook notification delivery failed');
      return false;
    }
  }
}

/**
 * Email-based SendFn client (placeholder - would integrate with actual email service)
 */
export class EmailSendFnClient implements SendFnClient {
  constructor(private emailTo: string) {}

  async sendNotification(notification: SendFnNotification): Promise<boolean> {
    throw new Error('CiFn email notification delivery is not configured; supply a real SendFn integration');
  }
}


export function notificationDestination(config: SendFnConfig): string | undefined {
  if (typeof config.enabled !== 'boolean') throw new Error('CiFn notification enabled must be a boolean');
  if (!config.enabled) return undefined;
  if (config.emailTo) throw new Error('CiFn durable email notifications require a real SendFn integration');
  if (!config.webhookUrl) throw new Error('Enabled CiFn notifications require an explicit webhook URL');
  let url: URL;
  try { url = new URL(config.webhookUrl); } catch { throw new Error('Invalid CiFn notification webhook URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('CiFn notification webhook must use HTTP(S) without userinfo or fragment');
  return url.toString();
}
export function parseNotificationConfig(env: Record<string, string | undefined>): SendFnConfig {
  const flag = env.CIFN_NOTIFY_ON_RUN_COMPLETE;
  if (flag !== undefined && flag !== 'true' && flag !== 'false') throw new Error('CIFN_NOTIFY_ON_RUN_COMPLETE must be true or false');
  const config = { enabled: flag === 'true', webhookUrl: env.CIFN_NOTIFICATION_WEBHOOK_URL, emailTo: env.CIFN_NOTIFICATION_EMAIL_TO };
  notificationDestination(config);
  return config;
}
