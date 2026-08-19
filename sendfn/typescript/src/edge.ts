import { resendAdapter } from './email/resend-adapter';
import type { EmailProvider } from './email/provider';
import type { EmailTransaction, SendEmailParams } from './types';

export { resendAdapter };
export {
  createSendFnDeliveryProvider,
  type SendFnDeliveryProviderOptions,
  type SendFnDeliveryRenderer,
  type SendFnEmailClient
} from './delivery';

export interface SendFnEdgeConfig {
  emailProvider: EmailProvider;
  email?: {
    /**
     * Full RFC 5322-ish sender string, for example:
     * `Nucleum <no-reply@example.com>`.
     */
    from?: string;
    /**
     * Bare sender email address. Display names belong in `fromName`.
     */
    fromEmail?: string;
    fromName?: string;
  };
}

export interface SendFnEdgeClient {
  email(params: SendEmailParams): Promise<EmailTransaction>;
  close(): Promise<void>;
}

export function createSendFn(config: SendFnEdgeConfig): SendFnEdgeClient {
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (!initialized) {
      await config.emailProvider.initialize();
      initialized = true;
    }
  }

  return {
    async email(params) {
      await ensureInitialized();
      const now = new Date();
      const recipients = toArray(params.to) ?? [];
      const sender = resolveSender(config.email);
      const response = await config.emailProvider.sendEmail({
        from: sender.header,
        to: recipients,
        cc: toArray(params.cc),
        bcc: toArray(params.bcc),
        subject: params.subject ?? '',
        html: params.html ?? '',
        text: params.text,
        attachments: params.attachments,
        metadata: params.metadata
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'SendFn email delivery failed');
      }

      return {
        id: response.messageId ?? response.providerMessageId ?? crypto.randomUUID(),
        userId: params.userId,
        to: recipients[0] ?? '',
        from: sender.email,
        subject: params.subject ?? '',
        templateId: params.templateId ?? null,
        templateData: params.templateData ?? null,
        status: 'sent',
        provider: config.emailProvider.name,
        providerMessageId: response.providerMessageId ?? response.messageId ?? null,
        deliveredAt: null,
        bouncedAt: null,
        complainedAt: null,
        metadata: params.metadata ?? {},
        createdAt: now,
        updatedAt: now,
        sentAt: response.timestamp
      } as EmailTransaction;
    },
    async close() {
      await config.emailProvider.close();
    }
  };
}

export const sendFn = createSendFn;
export const sendfn = createSendFn;

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

interface SenderConfig {
  from?: string;
  fromEmail?: string;
  fromName?: string;
}

interface ResolvedSender {
  header: string;
  email: string;
}

function resolveSender(config: SenderConfig | undefined): ResolvedSender {
  const explicitFrom = config?.from?.trim();
  if (explicitFrom) {
    return parseSender(explicitFrom, 'email.from');
  }

  const rawFromEmail = (config?.fromEmail ?? 'noreply@example.com').trim();
  const fromName = config?.fromName?.trim();
  const parsedFromEmail = tryParseSender(rawFromEmail);
  if (parsedFromEmail) {
    const displayName = fromName || parsedFromEmail.name;
    return {
      header: displayName ? `${displayName} <${parsedFromEmail.email}>` : parsedFromEmail.email,
      email: parsedFromEmail.email,
    };
  }

  assertBareEmail(rawFromEmail, 'email.fromEmail');
  return {
    header: fromName ? `${fromName} <${rawFromEmail}>` : rawFromEmail,
    email: rawFromEmail,
  };
}

function parseSender(value: string, fieldName: string): ResolvedSender {
  const parsed = tryParseSender(value);
  if (!parsed) {
    throw new Error(
      `Invalid ${fieldName}. Use email@example.com or Name <email@example.com>.`
    );
  }

  return {
    header: parsed.name ? `${parsed.name} <${parsed.email}>` : parsed.email,
    email: parsed.email,
  };
}

function tryParseSender(value: string): { name?: string; email: string } | null {
  if (isBareEmail(value)) {
    return { email: value };
  }

  const match = value.match(/^(.+?)\s*<([^<>]+)>$/);
  if (!match) {
    return null;
  }

  const name = match[1].trim().replace(/^"(.+)"$/, '$1');
  const email = match[2].trim();
  if (!name || !isBareEmail(email)) {
    return null;
  }

  return { name, email };
}

function assertBareEmail(value: string, fieldName: string): void {
  if (!isBareEmail(value)) {
    throw new Error(
      `Invalid ${fieldName}. Use a bare email address or set email.from to Name <email@example.com>.`
    );
  }
}

function isBareEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}
