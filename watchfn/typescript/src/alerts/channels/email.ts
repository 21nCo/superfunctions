/** Email notification channel backed by an explicitly configured sender. */

export interface EmailOptions {
  from: string;
  sender?: (message: { from: string; to: string[]; subject: string; html: string }) => Promise<void>;
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

    if (!this.options.sender) throw new Error('EmailChannel requires a configured email sender');
    await this.options.sender({ from: this.options.from, to: [...recipients], subject, html });

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
    const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
    let runbook: string | undefined;
    if (alert.runbook) {
      try { const url = new URL(alert.runbook); if (['http:', 'https:'].includes(url.protocol)) runbook = escape(url.href); } catch { /* Omit invalid links. */ }
    }
    alert = { ...alert, name: escape(alert.name), description: alert.description ? escape(alert.description) : undefined, severity: escape(alert.severity), runbook };

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
