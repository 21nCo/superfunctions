export interface SendFnNotification {
  runId: string;
  status: 'success' | 'failure';
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
      });
      return response.ok;
    } catch (err) {
      console.error('SendFn webhook notification failed:', err);
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
    // In a real implementation, this would call an email service
    console.log(`[SendFn] Would send email to ${this.emailTo} for run ${notification.runId} (${notification.status})`);
    return true;
  }
}
