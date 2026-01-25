import {
  SendEmailParams,
  EmailConfig,
  SendfnOptions,
  EmailTransaction,
  EmailTemplate
} from '../types';
import { TemplateError, SuppressionError } from '../errors';
import { SendfnDatabaseAdapter } from '../database/adapter';
import { EmailProvider } from './provider';
import { TemplateEngine, TemplateRegistry } from '../templates/engine';

export class EmailService {
  constructor(
    private provider: EmailProvider,
    private adapter: SendfnDatabaseAdapter,
    private templateEngine: TemplateEngine,
    private templateRegistry: TemplateRegistry,
    private config: EmailConfig,
    private options: SendfnOptions
  ) {}

  async sendEmail(params: SendEmailParams): Promise<EmailTransaction> {
    // 1. Check suppression list (if enabled)
    if (this.options.suppressionEnabled !== false) {
      const recipients = Array.isArray(params.to) ? params.to : [params.to];
      for (const email of recipients) {
        if (await this.adapter.isEmailSuppressed(email)) {
             // For single recipient, throw. For multiple, maybe just filter?
             // Spec says "If suppressed, throw SuppressionError or skip (configurable)"
             // Let's throw for now if any recipient is suppressed, to be safe.
             throw new SuppressionError(`Email ${email} is suppressed`);
        }
      }
    }

    // 2. Render template if provided
    let subject = params.subject;
    let html = params.html;
    let text = params.text;

    if (params.templateId) {
      const template = this.templateRegistry.get(params.templateId);
      if (!template) {
        throw new TemplateError(`Template not found: ${params.templateId}`);
      }
      
      const data = params.templateData || {};
      this.templateEngine.validate(template, data);
      
      subject = this.templateEngine.render(template.subject, data);
      html = this.templateEngine.render(template.html, data);
      if (template.text) {
        text = this.templateEngine.render(template.text, data);
      }
    }

    if (!subject || !html) {
      throw new Error('Subject and HTML content are required');
    }

    // 3. Create EmailTransaction record
    const transaction = await this.adapter.createEmailTransaction({
      userId: params.userId,
      to: Array.isArray(params.to) ? params.to.join(',') : params.to,
      from: this.config.fromEmail,
      subject,
      templateId: params.templateId || null,
      templateData: params.templateData || null,
      provider: this.provider.name,
      providerMessageId: null,
      status: 'pending',
      sentAt: null,
      deliveredAt: null,
      bouncedAt: null,
      complainedAt: null,
      metadata: params.metadata || {},
    });

    try {
      // 4. Call provider
      const response = await this.provider.sendEmail({
        from: this.config.fromEmail,
        to: Array.isArray(params.to) ? params.to : [params.to],
        cc: params.cc ? (Array.isArray(params.cc) ? params.cc : [params.cc]) : undefined,
        bcc: params.bcc ? (Array.isArray(params.bcc) ? params.bcc : [params.bcc]) : undefined,
        subject,
        html,
        text,
        attachments: params.attachments,
        replyTo: this.config.replyTo,
      });

      if (response.success) {
        // 5. Update transaction
        await this.adapter.updateEmailTransaction(transaction.id, {
          status: 'sent',
          providerMessageId: response.providerMessageId,
          sentAt: response.timestamp,
        });
        
        // 6. Record event
        await this.adapter.recordEvent({
            referenceId: transaction.id,
            referenceType: 'email',
            eventType: 'sent',
            provider: this.provider.name,
            providerEventId: response.providerMessageId || null,
            recipientEmail: Array.isArray(params.to) ? params.to[0] : params.to, // Simplified for v0
            recipientPhone: null,
            deviceToken: null,
            metadata: {},
            eventTimestamp: response.timestamp
        });
        
        return await this.adapter.getEmailTransaction(transaction.id) as EmailTransaction;
      } else {
        throw new Error(response.error?.message || 'Email sending failed');
      }
    } catch (error: any) {
        // 7. Handle errors
        await this.adapter.updateEmailTransaction(transaction.id, {
            status: 'failed',
            metadata: { ...params.metadata, error: error.message }
        });
        
        await this.adapter.recordEvent({
            referenceId: transaction.id,
            referenceType: 'email',
            eventType: 'failed',
            provider: this.provider.name,
            providerEventId: null,
            recipientEmail: Array.isArray(params.to) ? params.to[0] : params.to,
            recipientPhone: null,
            deviceToken: null,
            metadata: { error: error.message },
            eventTimestamp: new Date()
        });

        throw error;
    }
  }

  async sendBulkEmail(recipients: SendEmailParams[]): Promise<EmailTransaction[]> {
    const results: EmailTransaction[] = [];
    // Sequential for safety in v0
    for (const recipient of recipients) {
        results.push(await this.sendEmail(recipient));
    }
    return results;
  }
}
