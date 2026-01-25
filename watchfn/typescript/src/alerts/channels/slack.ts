"""Slack notification channel."""

export interface SlackWebhookPayload {
  text?: string;
  blocks?: any[];
  attachments?: any[];
}

export class SlackChannel {
  constructor(private webhookUrl: string) {}

  /**
   * Send notification to Slack
   */
  async send(alert: {
    name: string;
    description?: string;
    severity: string;
    value?: number;
    timestamp: number;
    runbook?: string;
  }): Promise<void> {
    const payload = this.buildPayload(alert);

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Slack webhook failed: ${response.statusText}`);
      }
    } catch (error) {
      console.error("Failed to send Slack notification:", error);
      throw error;
    }
  }

  private buildPayload(alert: {
    name: string;
    description?: string;
    severity: string;
    value?: number;
    timestamp: number;
    runbook?: string;
  }): SlackWebhookPayload {
    const color = this.getSeverityColor(alert.severity);
    const icon = this.getSeverityIcon(alert.severity);

    return {
      text: `${icon} Alert: ${alert.name}`,
      attachments: [
        {
          color,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `${icon} ${alert.name}`,
              },
            },
            ...(alert.description
              ? [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: alert.description,
                    },
                  },
                ]
              : []),
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*Severity:*\n${alert.severity.toUpperCase()}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Time:*\n<!date^${Math.floor(alert.timestamp / 1000)}^{date_short_pretty} {time}|${new Date(alert.timestamp).toISOString()}>`,
                },
                ...(alert.value !== undefined
                  ? [
                      {
                        type: "mrkdwn",
                        text: `*Value:*\n${alert.value.toFixed(2)}`,
                      },
                    ]
                  : []),
              ],
            },
            ...(alert.runbook
              ? [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `<${alert.runbook}|View Runbook>`,
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    };
  }

  private getSeverityColor(severity: string): string {
    switch (severity) {
      case "critical":
        return "#DC143C"; // Crimson
      case "warning":
        return "#FFA500"; // Orange
      case "info":
        return "#4169E1"; // Royal Blue
      default:
        return "#808080"; // Gray
    }
  }

  private getSeverityIcon(severity: string): string {
    switch (severity) {
      case "critical":
        return "🚨";
      case "warning":
        return "⚠️";
      case "info":
        return "ℹ️";
      default:
        return "📊";
    }
  }
}
