import { createHash, randomUUID } from 'node:crypto';
import { createError, ErrorCode } from '@recfn/core';
import type { Adapter, TransactionAdapter } from '@superfunctions/db';

export const activeBotWhere = (namespace: string) => [
  { field: 'namespace', operator: 'eq' as const, value: namespace },
  { field: 'status', operator: 'not_in' as const, value: ['done', 'error'] },
];
export function validateBotLimit(maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('maxConcurrentBots must be a positive safe integer.');
  return maximum;
}
/** First database operation in the transaction: write-lock the namespace before taking a count snapshot. */
export async function lockBotAdmission(tx: TransactionAdapter, namespace: string, maximum: number): Promise<void> {
  const id = createHash('sha256').update(namespace).digest('hex');
  const nonce = randomUUID();
  const policy = await tx.upsert<{ namespace: string; maximum: number }>({
    model: 'botAdmission', where: [{ field: 'id', operator: 'eq', value: id }], conflictTarget: 'id',
    create: { id, namespace, maximum, nonce }, update: { nonce },
  });
  if (policy.namespace !== namespace || policy.maximum !== maximum) throw new Error('Bot admission policy differs from persisted namespace policy; migrate policy with writers stopped.');
}
export async function assertBotCapacity(tx: Pick<Adapter, 'count'>, namespace: string, maximum: number): Promise<void> {
  const count = await tx.count({ model: 'bots', where: activeBotWhere(namespace) });
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Database returned an invalid active bot count.');
  if (count >= maximum) throw createError(ErrorCode.RATE_LIMIT_EXCEEDED, `Maximum ${maximum} concurrent bots per namespace.`, { limit: maximum, active: count });
}

