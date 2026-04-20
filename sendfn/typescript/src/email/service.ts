import {
  Attachment,
  EmailConfig,
  EmailTemplate,
  EmailTransaction,
  SendEmailParams,
  SendfnOptions
} from '../types';
import {
  EmailProviderError,
  SuppressionError,
  TemplateError,
  ValidationError
} from '../errors';
import { SendfnDatabaseAdapter } from '../database/adapter';
import { EmailProvider, SendEmailRequest, SendEmailResponse } from './provider';
import { TemplateEngine, TemplateRegistry } from '../templates/engine';
import { mapWithConcurrency, resolveConcurrency } from '../utils/concurrency';

const DEFAULT_MAX_RECIPIENTS = 50;
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_BULK_CONCURRENCY = 5;

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
    const recipients = this.normalizeRecipients(params);
    await this.assertRecipientsNotSuppressed(recipients.to);

    const rendered = this.resolveContent(params);
    this.assertResolvedContent(rendered.subject, rendered.html);
    this.assertProviderLimits(recipients, params.attachments);

    const transaction = await this.adapter.createEmailTransaction({
      userId: params.userId,
      to: recipients.to.join(','),
      from: this.config.fromEmail,
      subject: rendered.subject,
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
      const response = await this.sendWithRetry({
        from: this.config.fromEmail,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: params.attachments,
        replyTo: this.config.replyTo,
      });

      await this.adapter.updateEmailTransaction(transaction.id, {
        status: 'sent',
        providerMessageId: response.providerMessageId,
        sentAt: response.timestamp,
      });

      await this.adapter.recordEvent({
        referenceId: transaction.id,
        referenceType: 'email',
        eventType: 'sent',
        provider: this.provider.name,
        providerEventId: response.providerMessageId || null,
        recipientEmail: recipients.to[0] || null,
        recipientPhone: null,
        deviceToken: null,
        metadata: {},
        eventTimestamp: response.timestamp,
      });

      return (await this.adapter.getEmailTransaction(transaction.id)) as EmailTransaction;
    } catch (error) {
      const sendError =
        error instanceof EmailProviderError
          ? error
          : new EmailProviderError(
              error instanceof Error ? error.message : 'Email sending failed',
              {
                code: 'SENDFN_INTERNAL_ERROR',
                retryable: false,
                details: {
                  provider: this.provider.name,
                },
              }
            );

      await this.adapter.updateEmailTransaction(transaction.id, {
        status: 'failed',
        metadata: {
          ...(params.metadata || {}),
          error: sendError.message,
          errorCode: sendError.code,
        },
      });

      await this.adapter.recordEvent({
        referenceId: transaction.id,
        referenceType: 'email',
        eventType: 'failed',
        provider: this.provider.name,
        providerEventId: null,
        recipientEmail: recipients.to[0] || null,
        recipientPhone: null,
        deviceToken: null,
        metadata: {
          code: sendError.code,
          message: sendError.message,
        },
        eventTimestamp: new Date(),
      });

      throw sendError;
    }
  }

  async sendBulkEmail(recipients: SendEmailParams[]): Promise<EmailTransaction[]> {
    return mapWithConcurrency(
      recipients,
      resolveConcurrency(this.options.bulkConcurrency, DEFAULT_BULK_CONCURRENCY),
      async (recipient) => this.sendEmail(recipient)
    );
  }

  private normalizeRecipients(params: SendEmailParams): {
    to: string[];
    cc: string[];
    bcc: string[];
  } {
    return {
      to: Array.isArray(params.to) ? params.to : [params.to],
      cc: params.cc ? (Array.isArray(params.cc) ? params.cc : [params.cc]) : [],
      bcc: params.bcc ? (Array.isArray(params.bcc) ? params.bcc : [params.bcc]) : [],
    };
  }

  private resolveContent(params: SendEmailParams): {
    subject: string;
    html: string;
    text?: string;
  } {
    let subject = params.subject;
    let html = params.html;
    let text = params.text;

    if (params.templateId) {
      const template = this.templateRegistry.get(params.templateId);
      if (!template) {
        throw new TemplateError(`Template \`${params.templateId}\` was not found`, {
          code: 'SENDFN_TEMPLATE_NOT_FOUND',
          retryable: false,
        });
      }

      const data = params.templateData || {};
      this.templateEngine.validate(template, data);

      try {
        subject = this.templateEngine.render(template.subject, data);
        html = this.templateEngine.render(template.html, data);
        text = template.text ? this.templateEngine.render(template.text, data) : text;
      } catch (error) {
        if (error instanceof TemplateError) {
          throw error;
        }

        throw new TemplateError('Failed to render email template', {
          code: 'SENDFN_TEMPLATE_RENDER_ERROR',
          details: {
            templateId: params.templateId,
          },
        });
      }
    }

    return {
      subject: subject?.trim() || '',
      html: html?.trim() || '',
      text,
    };
  }

  private assertResolvedContent(subject: string, html: string): void {
    if (!subject || !html) {
      throw new ValidationError('Email must include a subject and HTML body', {
        code: 'SENDFN_VALIDATION_ERROR',
        retryable: false,
      });
    }
  }

  private async assertRecipientsNotSuppressed(recipients: string[]): Promise<void> {
    if (this.options.suppressionEnabled === false) {
      return;
    }

    for (const email of recipients) {
      if (await this.adapter.isEmailSuppressed(email)) {
        throw new SuppressionError('Recipient is suppressed', {
          code: 'SENDFN_SUPPRESSED',
          retryable: false,
          details: {
            recipient: email,
          },
        });
      }
    }
  }

  private assertProviderLimits(
    recipients: { to: string[]; cc: string[]; bcc: string[] },
    attachments?: Attachment[]
  ): void {
    const recipientCount = recipients.to.length + recipients.cc.length + recipients.bcc.length;
    const maxRecipients = this.provider.capabilities.maxRecipientsPerEmail || DEFAULT_MAX_RECIPIENTS;
    const maxAttachmentBytes =
      this.provider.capabilities.maxAttachmentSize || DEFAULT_MAX_ATTACHMENT_BYTES;

    if (recipientCount > maxRecipients || this.getAttachmentBytes(attachments) > maxAttachmentBytes) {
      throw new EmailProviderError('Email request exceeds provider limits', {
        code: 'SENDFN_PROVIDER_LIMIT',
        retryable: false,
        details: {
          recipientCount,
          attachmentBytes: this.getAttachmentBytes(attachments),
          maxRecipients,
          maxAttachmentBytes,
        },
      });
    }
  }

  private getAttachmentBytes(attachments?: Attachment[]): number {
    if (!attachments?.length) {
      return 0;
    }

    return attachments.reduce((total, attachment) => {
      if (Buffer.isBuffer(attachment.content)) {
        return total + attachment.content.length;
      }
      return total + Buffer.byteLength(attachment.content, attachment.encoding as BufferEncoding | undefined);
    }, 0);
  }

  private async sendWithRetry(request: SendEmailRequest): Promise<SendEmailResponse> {
    const maxAttempts = Math.max(1, this.options.retryAttempts ?? 3);
    const retryDelay = Math.max(0, this.options.retryDelay ?? 1000);
    let lastError: SendEmailResponse['error'];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.provider.sendEmail(request);

      if (response.success) {
        return response;
      }

      if (!response.error?.retryable) {
        throw new EmailProviderError(response.error?.message || 'Email sending failed', {
          code: response.error?.code || 'SENDFN_INTERNAL_ERROR',
          retryable: false,
          details: {
            attempts: attempt,
            provider: this.provider.name,
          },
        });
      }

      lastError = response.error;

      if (attempt < maxAttempts) {
        await this.wait(retryDelay);
      }
    }

    throw new EmailProviderError('Email provider retry limit exhausted', {
      code: 'SENDFN_PROVIDER_RETRY_EXHAUSTED',
      retryable: false,
      details: {
        attempts: maxAttempts,
        provider: this.provider.name,
        providerCode: lastError?.code,
      },
    });
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
