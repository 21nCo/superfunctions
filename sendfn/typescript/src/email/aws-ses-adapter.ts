import {
  EmailProvider,
  EmailProviderCapabilities,
  SendEmailRequest,
  SendEmailResponse
} from './provider';
import { AwsSesConfig } from '../types';
import {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
  MessageRejected,
  LimitExceededException
} from '@aws-sdk/client-ses';
import { isBareEmail } from './address';
import { Readable } from 'node:stream';

export interface SesSendOptions { signal?: AbortSignal }
export type { AwsSesConfig } from '../types';
export type { SendEmailRequest, SendEmailResponse } from './provider';

function encodeSesAddress(value: string, foldLongHeader = false): string {
  if (/[\r\n]/.test(value)) throw new Error('Invalid sender address');
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  const mailboxStart = value.lastIndexOf('<');
  if (mailboxStart <= 0 || !value.endsWith('>')) return value;
  const mailbox = value.slice(mailboxStart);
  let displayName = value.slice(0, mailboxStart).trim();
  if (displayName.includes('<') || mailbox.slice(1, -1).includes('<') || mailbox.slice(1, -1).includes('>')) {
    return value;
  }
  if (displayName.startsWith('"') && displayName.endsWith('"')) {
    displayName = displayName.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  // Raw headers reserve six characters for `From: ` on the first physical line.
  const maxChunkBytes = foldLongHeader ? 42 : 45;
  for (const character of displayName) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (chunk && chunkBytes + bytes > maxChunkBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += bytes;
  }
  if (chunk) chunks.push(chunk);
  const encodedWords = chunks.map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
  if (foldLongHeader) {
    if (encodedWords.length > 1) return `${encodedWords.join('\n ')}\n ${mailbox}`;
    if (`From: ${encodedWords[0]} ${mailbox}`.length > 76) return `${encodedWords[0]}\n ${mailbox}`;
  }
  return `${encodedWords.join(' ')} ${mailbox}`;
}

export class AwsSesAdapter implements EmailProvider {
  readonly name = 'aws-ses';
  readonly capabilities: EmailProviderCapabilities = {
    supportsIdempotency: false,
    supportsTemplates: true,
    supportsAttachments: true,
    supportsBulkSend: true,
    supportsScheduling: false,
    maxRecipientsPerEmail: 50,
    maxAttachmentSize: 10 * 1024 * 1024,
  };

  private sesClient: SESClient;
  private readonly active = new Map<Promise<SendEmailResponse>, AbortController>();
  private closing = false;
  private closeTask?: Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private config: AwsSesConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 1024 * 1024;
    for (const [name, value] of Object.entries({ timeoutMs: this.timeoutMs, maxResponseBytes: this.maxResponseBytes })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid SES ${name}`);
    }
    if (config.endpoint !== undefined) {
      const endpoint = new URL(config.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid SES endpoint');
    }
    this.sesClient = new SESClient({
      maxAttempts: 1,
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    // Retain the SDK signing and transport. Bound its response before deserialization,
    // including bodies that stall after headers (SDK socket timers need not cover these).
    const handler = this.sesClient.config.requestHandler;
    const handle = handler.handle.bind(handler);
    handler.handle = async (request, options) => {
      const result = await handle(request, options);
      const body = result.response.body;
      if (!(body instanceof Readable)) throw new Error('Unsupported SES response stream');
      // Every send below supplies our native AbortController signal.
      const signal = (options && 'abortSignal' in options ? options.abortSignal : undefined) as AbortSignal | undefined;
      const abort = () => body.destroy(new Error('SES operation aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) abort();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > this.maxResponseBytes) throw new Error('SES response exceeds configured limit');
          chunks.push(buffer);
        }
        if (signal?.aborted) throw new Error('SES operation aborted');
        result.response.body = Readable.from([Buffer.concat(chunks, bytes)]);
        return result;
      } finally {
        signal?.removeEventListener('abort', abort);
        body.destroy();
      }
    };
  }

  async initialize(): Promise<void> {
    // No-op
  }

  sendEmail(params: SendEmailRequest, options: SesSendOptions = {}): Promise<SendEmailResponse> {
    if (this.closing) return Promise.resolve(this.handleError(new Error('SES provider is closed')));
    if (options.signal?.aborted) return Promise.resolve(this.handleError(new Error('SES operation aborted')));
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    const operation = (async () => {
      try {
        const raw = Boolean(params.attachments?.length || Object.keys(params.headers ?? {}).length || params.idempotencyKey);
        const result = await (raw ? this.sendRawEmail(params, controller.signal) : this.sendSimpleEmail(params, controller.signal));
        if (controller.signal.aborted) throw new Error('SES operation aborted');
        return result;
      } catch (error) {
        return this.handleError(error);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
    })();
    this.active.set(operation, controller);
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation));
    return operation;
  }

  private async sendSimpleEmail(params: SendEmailRequest, signal: AbortSignal): Promise<SendEmailResponse> {
    const command = new SendEmailCommand({
      Source: encodeSesAddress(params.from),
      Destination: {
        ToAddresses: params.to,
        CcAddresses: params.cc,
        BccAddresses: params.bcc,
      },
      Message: {
        Subject: { Data: params.subject },
        Body: {
          Html: params.html ? { Data: params.html } : undefined,
          Text: params.text ? { Data: params.text } : undefined,
        },
      },
      ConfigurationSetName: this.config.configurationSetName,
      ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
      Tags: Object.entries(params.tags ?? {}).map(([Name, Value]) => ({ Name, Value })),
    });

    const result = await this.sesClient.send(command, { abortSignal: signal });

    if (typeof result.MessageId !== 'string' || !result.MessageId.trim()) throw new Error('SES response has no message receipt');
    return {
      success: true,
      messageId: result.MessageId,
      providerMessageId: result.MessageId,
      timestamp: new Date(),
    };
  }

  private async sendRawEmail(params: SendEmailRequest, signal: AbortSignal): Promise<SendEmailResponse> {
    const boundary = `----=_Part_${Date.now()}`;
    let rawMessage = '';

    // Headers
    rawMessage += `From: ${encodeSesAddress(params.from, true)}\n`;
    rawMessage += `To: ${params.to.join(', ')}\n`;
    if (params.cc?.length) rawMessage += `Cc: ${params.cc.join(', ')}\n`;
    rawMessage += `Subject: ${params.subject}\n`;
    if (params.replyTo) rawMessage += `Reply-To: ${params.replyTo}\n`;
    for (const [name, value] of Object.entries(params.headers ?? {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid custom email header');
      rawMessage += `${name}: ${value}\n`;
    }
    if (params.idempotencyKey) rawMessage += `X-Sendfn-Idempotency-Key: ${params.idempotencyKey.replace(/[\r\n]/g, '')}\n`;
    rawMessage += `MIME-Version: 1.0\n`;
    rawMessage += `Content-Type: multipart/mixed; boundary="${boundary}"\n\n`;

    // Body (Multipart Alternative for Text/HTML)
    const altBoundary = `----=_Part_${Date.now()}_Alt`;
    rawMessage += `--${boundary}\n`;
    rawMessage += `Content-Type: multipart/alternative; boundary="${altBoundary}"\n\n`;

    // Text Part
    if (params.text) {
      rawMessage += `--${altBoundary}\n`;
      rawMessage += `Content-Type: text/plain; charset=UTF-8\n\n`;
      rawMessage += `${params.text}\n\n`;
    }

    // HTML Part
    if (params.html) {
      rawMessage += `--${altBoundary}\n`;
      rawMessage += `Content-Type: text/html; charset=UTF-8\n\n`;
      rawMessage += `${params.html}\n\n`;
    }

    rawMessage += `--${altBoundary}--

`;

    // Attachments
    if (params.attachments) {
      for (const att of params.attachments) {
        const filename = sanitizeMimeParameter(att.filename);
        const contentType = validateAttachmentContentType(att.contentType);
        rawMessage += `--${boundary}\n`;
        rawMessage += `Content-Type: ${contentType}; name="${filename}"\n`;
        rawMessage += `Content-Transfer-Encoding: base64\n`;
        rawMessage += `Content-Disposition: attachment; filename="${filename}"\n\n`;

        const content = typeof att.content === 'string'
          ? Buffer.from(att.content, att.encoding as BufferEncoding | undefined).toString('base64')
          : Buffer.from(att.content).toString('base64');

        const chunked = content.match(/.{1,76}/g)?.join('\n') || content;
        rawMessage += `${chunked}\n\n`;
      }
    }

    rawMessage += `--${boundary}--
`;

    const command = new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(rawMessage) },
      Destinations: [...params.to, ...(params.cc ?? []), ...(params.bcc ?? [])],
      ConfigurationSetName: this.config.configurationSetName,
      Tags: Object.entries(params.tags ?? {}).map(([Name, Value]) => ({ Name, Value })),
    });

    const result = await this.sesClient.send(command, { abortSignal: signal });

    if (typeof result.MessageId !== 'string' || !result.MessageId.trim()) throw new Error('SES response has no message receipt');
    return {
      success: true,
      messageId: result.MessageId,
      providerMessageId: result.MessageId,
      timestamp: new Date(),
    };
  }

  async sendBulkEmail(params: SendEmailRequest[]): Promise<SendEmailResponse[]> {
    const results: SendEmailResponse[] = [];
    for (const req of params) {
        results.push(await this.sendEmail(req));
    }
    return results;
  }

  validateEmail(email: string): boolean {
    return isBareEmail(email);
  }

  async isHealthy(): Promise<boolean> {
    try {
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    if (!this.closeTask) {
      this.closing = true;
      for (const controller of this.active.values()) controller.abort();
      this.closeTask = (async () => {
        await Promise.all([...this.active.keys()]);
        this.sesClient.destroy();
      })();
      void this.closeTask.catch(() => {});
    }
    return this.closeTask;
  }

  private handleError(error: unknown): SendEmailResponse {
    const failure = error instanceof Error ? error : new Error('Unknown SES failure');
    let code = 'SENDFN_INTERNAL_ERROR';
    let retryable = false;

    if (error instanceof MessageRejected) {
      code = 'MESSAGE_REJECTED';
    } else if (error instanceof LimitExceededException) {
      code = 'LIMIT_EXCEEDED';
      retryable = true;
    } else if (failure.name === 'ThrottlingException') {
      code = 'THROTTLING';
      retryable = true;
    }

    return {
      success: false,
      timestamp: new Date(),
      error: {
        code,
        message: failure.message || 'Unknown error occurred',
        retryable,
      },
    };
  }
}

function sanitizeMimeParameter(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f"\\/;]/g, '_').slice(0, 255) || 'attachment';
}

function validateAttachmentContentType(value: string | undefined): string {
  const contentType = value || 'application/octet-stream';
  if (/[\u0000-\u001f\u007f]/.test(contentType) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(contentType)) {
    throw new Error('Invalid attachment content type');
  }
  return contentType;
}

export function awsSesAdapter(config: AwsSesConfig): AwsSesAdapter {
  return new AwsSesAdapter(config);
}
