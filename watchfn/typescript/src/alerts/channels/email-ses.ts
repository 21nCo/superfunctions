import { z } from 'zod';
import type { AwsSesAdapter } from 'sendfn/adapters/aws-ses';
import type { AlertChannel, AlertEmailConfig, AlertNotification } from '../types';

type SesConstructor = typeof AwsSesAdapter;
export class EmailCleanupError extends Error {
  constructor() { super('Email transport cleanup failed; notification ownership retained'); }
}
export function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && !/[\s<>\x00-\x1f\x7f]/.test(value) && z.string().email().safeParse(value).success;
}
export function validateEmailConfig(value: AlertEmailConfig): AlertEmailConfig {
  const ses = value?.awsSes;
  if (!value || !validEmail(value.from) || (value.replyTo !== undefined && !validEmail(value.replyTo)) || !ses
      || [ses.region, ses.accessKeyId, ses.secretAccessKey].some(item => typeof item !== 'string' || !item.trim() || item.length > 1024)
      || (ses.configurationSetName !== undefined && (typeof ses.configurationSetName !== 'string' || !ses.configurationSetName || ses.configurationSetName.length > 256))) throw new TypeError('Invalid alert email configuration');
  for (const limit of [ses.timeoutMs, ses.maxResponseBytes]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647)) throw new TypeError('Invalid alert email transport limit');
  if (ses.endpoint !== undefined) {
    let endpoint: URL; try { endpoint = new URL(ses.endpoint); } catch { throw new TypeError('Invalid alert email endpoint'); }
    if (typeof ses.endpoint !== 'string' || ses.endpoint.length > 4096 || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new TypeError('Invalid alert email endpoint');
  }
  return { from: value.from, ...(value.replyTo ? { replyTo: value.replyTo } : {}), awsSes: { ...ses } };
}
/** Resolve the optional transport before claiming an obligation; importing sends nothing. */
export async function loadSesProvider(): Promise<SesConstructor> {
  try {
    const { AwsSesAdapter } = await import('sendfn/adapters/aws-ses');
    if (typeof AwsSesAdapter !== 'function' || typeof AwsSesAdapter.prototype.sendEmail !== 'function' || typeof AwsSesAdapter.prototype.close !== 'function') throw new Error();
    return AwsSesAdapter;
  } catch { throw new Error('Built-in email requires SendFn with the adapters/aws-ses transport entry point'); }
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export async function sendSesEmail(notification: AlertNotification, channel: AlertChannel, config: AlertEmailConfig, Provider: SesConstructor, signal: AbortSignal): Promise<boolean> {
  const provider = new Provider(config.awsSes);
  try {
    const subject = `[${notification.alert.severity}] ${notification.alert.name}: ${notification.event}`.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 500);
    const text = `${subject}\n${notification.alert.description ?? ''}\nAlert: ${notification.alert.id}\nNotification: ${notification.id}`;
    const result = await provider.sendEmail({ from: config.from, to: channel.recipients!, subject, text, html: `<pre>${escape(text)}</pre>`, ...(config.replyTo ? { replyTo: config.replyTo } : {}) }, { signal });
    return result.success === true && typeof result.providerMessageId === 'string' && !!result.providerMessageId.trim();
  } finally {
    // Never release the host operation while the transport still owns a send.
    try { await provider.close(); } catch { throw new EmailCleanupError(); }
  }
}
