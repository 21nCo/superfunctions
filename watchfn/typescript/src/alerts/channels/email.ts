/** Email notification channel (placeholder - requires email service). */

export interface EmailOptions {
  from: string;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  };
}

export class EmailChannel {
  constructor(private options: EmailOptions) {}

  /**
   * Send email notification
   */
  async send(alert: {
    name: string;
    description?: string;
    severity: string;
    value?: number;
    timestamp: number;
    runbook?: string;
  }, recipients: string[]): Promise<void> {
    const subject = `[${alert.severity.toUpperCase()}] ${alert.name}`;
    const html = this.buildEmailHtml(alert);

    // In production, use a proper email service (SendGrid, AWS SES, etc.)
    // For now, this is a placeholder
    console.log(`Would send email to ${recipients.join(", ")}:`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${html}`);

    // TODO: Implement actual email sending
    // Example with sendFn integration:
    // await sendFn.email.send({
    //   from: this.options.from,
    //   to: recipients,
    //   subject,
    //   html,
    // });
  }

  private buildEmailHtml(alert: {
    name: string;
    description?: string;
    severity: string;
    value?: number;
    timestamp: number;
    runbook?: string;
  }): string {
    const severityColor = this.getSeverityColor(alert.severity);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .alert-header { background: ${severityColor}; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
          .alert-body { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-top: none; }
          .alert-field { margin: 10px 0; }
          .alert-label { font-weight: bold; }
          .btn { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="alert-header">
            <h2>${alert.name}</h2>
          </div>
          <div class="alert-body">
            ${alert.description ? `<p>${alert.description}</p>` : ""}
            <div class="alert-field">
              <span class="alert-label">Severity:</span> ${alert.severity.toUpperCase()}
            </div>
            <div class="alert-field">
              <span class="alert-label">Time:</span> ${new Date(alert.timestamp).toLocaleString()}
            </div>
            ${alert.value !== undefined ? `<div class="alert-field"><span class="alert-label">Value:</span> ${alert.value.toFixed(2)}</div>` : ""}
            ${alert.runbook ? `<a href="${alert.runbook}" class="btn">View Runbook</a>` : ""}
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private getSeverityColor(severity: string): string {
    switch (severity) {
      case "critical":
        return "#DC143C";
      case "warning":
        return "#FFA500";
      case "info":
        return "#4169E1";
      default:
        return "#808080";
    }
  }
}
