import type { Adapter, TransactionAdapter } from '@superfunctions/db';
import type { Bot } from '@recfn/core';
import { assertBotWritable, blocked } from './deletion.js';

export interface BotWork {
  id: string;
  namespace: string;
  state: 'pending' | 'owned' | 'uncertain' | 'closed';
  ownerToken?: string;
  heldTerminalCapacity: boolean;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
export const workWhere = (id: string, namespace: string) => [
  { field: 'id', operator: 'eq' as const, value: id },
  { field: 'namespace', operator: 'eq' as const, value: namespace },
];
export const unresolvedWork = (work: BotWork | null) => work?.state === 'owned' || work?.state === 'uncertain';
type Admit = <T>(namespace: string, action: (tx: TransactionAdapter) => Promise<T>) => Promise<T>;

export function botWorkMethods(adapter: Adapter, admit: Admit) {
  const mutateOwned = async (id: string, namespace: string, token: string, state: 'uncertain' | 'closed', reason: string, finalStatus?: 'done' | 'error') => {
    if (!token || !reason.trim() || reason.length > 1000) throw blocked();
    return admit(namespace, async tx => {
      await assertBotWritable(tx, id, namespace);
      const work = await tx.findOne<BotWork>({ model: 'botWork', where: workWhere(id, namespace) });
      if (!work || work.ownerToken !== token || !unresolvedWork(work)) throw blocked();
      const bot = await tx.findOne<Bot>({ model: 'bots', where: workWhere(id, namespace) });
      if (!bot) throw blocked();
      const updatedAt = new Date().toISOString();
      await tx.update({ model: 'botWork', where: workWhere(id, namespace), data: { state, reason, updatedAt, heldTerminalCapacity: state === 'uncertain' } });
      const updated = await tx.update<Bot>({ model: 'bots', where: workWhere(id, namespace), data: {
        updatedAt, ...(state === 'uncertain' ? { status: 'error', ...(bot?.status !== 'error' ? { errorMessage: reason } : {}) } : {}),
        ...(state === 'closed' ? { status: finalStatus ?? 'error', ...((finalStatus ?? 'error') === 'error' && bot.status !== 'error' ? { errorMessage: reason } : {}) } : {}),
      } });
      return { before: bot, after: updated };
    });
  };
  return {
    getBotWork(id: string, namespace: string): Promise<BotWork | null> {
      return adapter.findOne({ model: 'botWork', where: workWhere(id, namespace) });
    },
    listPendingBotJoins(namespace: string, limit = 100, cursor?: string): Promise<BotWork[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Pending join page must be 1..100.');
      return adapter.findMany({ model: 'botWork', where: [{ field: 'namespace', operator: 'eq', value: namespace }, { field: 'state', operator: 'eq', value: 'pending' }, ...(cursor ? [{ field: 'id', operator: 'gt' as const, value: cursor }] : [])], limit,
        orderBy: [{ field: 'id', direction: 'asc' }] });
    },
    async claimBotJoin(id: string, namespace: string, token: string): Promise<Bot | null> {
      if (!token) throw new TypeError('Owner token is required.');
      return admit(namespace, async tx => {
        const bot = await tx.findOne<Bot>({ model: 'bots', where: workWhere(id, namespace) });
        if (!bot || bot.status !== 'creating') return null;
        await assertBotWritable(tx, id, namespace);
        const work = await tx.findOne<BotWork>({ model: 'botWork', where: workWhere(id, namespace) });
        if (!work || work.state !== 'pending' || work.ownerToken) return null;
        const updatedAt = new Date().toISOString();
        await tx.update({ model: 'botWork', where: workWhere(id, namespace), data: { state: 'owned', ownerToken: token, updatedAt } });
        return tx.update<Bot>({ model: 'bots', where: workWhere(id, namespace), data: { status: 'joining', updatedAt } });
      });
    },
    markBotWorkUncertain(id: string, namespace: string, token: string, reason: string) {
      return mutateOwned(id, namespace, token, 'uncertain', reason);
    },
    /** Owner calls only after join has settled, provider leave acknowledged and local capture stopped. */
    completeBotWork(id: string, namespace: string, token: string, status: 'done' | 'error', reason: string) {
      if (status !== 'done' && status !== 'error') throw new TypeError('Completed bot work requires a terminal status.');
      return mutateOwned(id, namespace, token, 'closed', reason, status);
    },
    /** Operator-only: stop the original worker and establish provider termination first. No age-based takeover. */
    reconcileBotWork(id: string, namespace: string, token: string, proof: { workerStopped: true; providerStopped: true; reason: string }) {
      if (proof.workerStopped !== true || proof.providerStopped !== true || typeof proof.reason !== 'string' || !proof.reason.trim() || proof.reason.length > 950) throw blocked();
      return mutateOwned(id, namespace, token, 'closed', `Reconciled stopped owner: ${proof.reason}`, 'error');
    },
  };
}
