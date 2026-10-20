import { createRouteContext } from '@superfunctions/http';
import type { SendFnEmailDestination, SendFnNotification } from './sendfn-client.js';

export type EmailDeliveryResult =
  | { status: 'accepted'; transactionId: string; transactionStatus: 'sent' | 'delivered' }
  | { status: 'retry' }
  | { status: 'reconciliation'; reason: string; transactionId?: string };

/** SendFn's existing POST /email contract. A successful envelope is not itself delivery. */
export async function deliverSendFnEmail(destination: SendFnEmailDestination, notification: SendFnNotification, eventId: string): Promise<EmailDeliveryResult> {
  try {
    const response = await fetch(destination.url, {
      method: 'POST', headers: { Authorization: `Bearer ${destination.adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: destination.userId, to: destination.to, idempotencyKey: eventId,
        subject: `CiFn run ${notification.runId}: ${notification.status}`, text: notification.summary,
        metadata: { cifnEventId: eventId, cifnRunId: notification.runId } }),
      signal: AbortSignal.timeout(3_000), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 429 || response.status >= 500 ? { status: 'retry' } : { status: 'reconciliation', reason: 'sendfn_request_rejected' };
    }
    const request = new Request('http://cifn.invalid/response', { method: 'POST', body: response.body, duplex: 'half' } as RequestInit & { duplex: 'half' });
    const envelope = await createRouteContext(request, {}, { maxBodyBytes: 65_536 }).json() as { ok?: unknown; data?: Record<string, unknown> };
    const result = envelope?.data;
    if (envelope?.ok !== true || !result || typeof result.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.id)
      || result.userId !== destination.userId || result.to !== destination.to || (result.metadata as Record<string, unknown> | undefined)?.cifnEventId !== eventId) return { status: 'reconciliation', reason: 'sendfn_invalid_receipt' };
    const transactionId = result.id;
    if (result.status === 'pending') return { status: 'retry' };
    if (result.status === 'sent' || result.status === 'delivered') {
      if (typeof result.providerMessageId !== 'string' || !result.providerMessageId || typeof result.sentAt !== 'string' || !Number.isFinite(Date.parse(result.sentAt))) return { status: 'reconciliation', reason: 'sendfn_invalid_receipt', transactionId };
      return { status: 'accepted', transactionId, transactionStatus: result.status };
    }
    return { status: 'reconciliation', reason: ['failed', 'bounced', 'complained'].includes(String(result.status)) ? `sendfn_${result.status}` : 'sendfn_invalid_receipt', transactionId };
  } catch {
    // A timeout/response loss is uncertain: retry the same key, never a fresh send identity.
    return { status: 'retry' };
  }
}
