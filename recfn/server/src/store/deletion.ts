import { randomUUID } from 'node:crypto';
import type { Adapter, TransactionAdapter, WhereClause } from '@superfunctions/db';
import { createError, ErrorCode, isTerminalState, type Bot, type Recording } from '@recfn/core';
import type { RecFnStore } from './types.js';

export interface ProducerIntent {
  id: string; namespace: string; botId: string; recordingId: string; storageRef?: string;
  state: 'active' | 'uncertain' | 'settled'; createdAt: string; reconciliationReason?: string;
}
export interface BotDeletion {
  id: string; namespace: string; state: 'pending' | 'completed';
  resources: Array<{ recordingId: string; storageRef?: string }>; createdAt: string;
}
const transactionalView = (tx: TransactionAdapter): Adapter => Object.assign(Object.create(tx), { transaction: <T>(fn: (inner: TransactionAdapter) => Promise<T>) => fn(tx), close: async () => { throw new Error('Cannot close a borrowed transaction'); } });
const where = (id: string, namespace: string) => [{ field: 'id', operator: 'eq' as const, value: id }, { field: 'namespace', operator: 'eq' as const, value: namespace }];
const botWhere = (botId: string, namespace: string) => [{ field: 'botId', operator: 'eq' as const, value: botId }, { field: 'namespace', operator: 'eq' as const, value: namespace }];
export async function readAll<T extends { id: string }>(adapter: Pick<Adapter, 'findMany'>, model: string, conditions: WhereClause[]): Promise<T[]> {
  const rows: T[] = []; const seen = new Set<string>();
  for (;;) {
    const page = await adapter.findMany<T>({ model, where: conditions, limit: 100, offset: rows.length, orderBy: [{ field: 'id', direction: 'asc' }] });
    if (!page.length) return rows;
    for (const row of page) {
      if (seen.has(row.id)) throw new Error('Cleanup pagination did not advance');
      seen.add(row.id); rows.push(row);
    }
  }
}
export const blocked = () => createError(ErrorCode.BOT_STILL_ACTIVE, 'Bot deletion or an unresolved external producer blocks this operation.');

export async function lockBot(adapter: Pick<Adapter, 'update' | 'findOne'>, botId: string, namespace: string): Promise<void> {
  // A write on the aggregate root serializes admission with tombstone creation.
  const bot = await adapter.update<Bot>({ model: 'bots', where: where(botId, namespace), data: { id: botId } });
  if (!bot || bot.id !== botId || !await adapter.findOne({ model: 'bots', where: where(botId, namespace) })) throw blocked();
}
export async function assertBotWritable(adapter: Pick<Adapter, 'update' | 'findOne'>, botId: string, namespace: string): Promise<void> {
  await lockBot(adapter, botId, namespace);
  if (await adapter.findOne({ model: 'botDeletions', where: where(botId, namespace) })) throw blocked();
}

export function deletionMethods(adapter: Adapter) {
  const transaction = <T>(fn: (tx: Adapter) => Promise<T>) => {
    if (!adapter.capabilities.transactions.supported) throw new Error('Producer fencing and deletion require database transactions');
    return adapter.transaction(tx => fn(transactionalView(tx)));
  };
  return {
    async getBotDeletion(id: string, namespace: string): Promise<BotDeletion | null> {
      return adapter.findOne<BotDeletion>({ model: 'botDeletions', where: where(id, namespace) });
    },
    async beginBotDeletion(id: string, namespace: string): Promise<BotDeletion | null> {
      return transaction(async tx => {
        const existing = await tx.findOne<BotDeletion>({ model: 'botDeletions', where: where(id, namespace) });
        if (existing) return existing;
        const bot = await tx.findOne<Bot>({ model: 'bots', where: where(id, namespace) });
        if (!bot) return null;
        await lockBot(tx, id, namespace);
        const concurrent = await tx.findOne<BotDeletion>({ model: 'botDeletions', where: where(id, namespace) });
        if (concurrent) return concurrent;
        const current = await tx.findOne<Bot>({ model: 'bots', where: where(id, namespace) });
        if (!current || (!isTerminalState(current.status) && current.status !== 'left')) throw blocked();
        const recordings = await readAll<Recording>(tx, 'recordings', botWhere(id, namespace));
        const producers = await readAll<ProducerIntent>(tx, 'botProducers', botWhere(id, namespace));
        const resources = [...recordings.map(r => ({ recordingId: r.id, storageRef: r.storageRef })), ...producers.map(p => ({ recordingId: p.recordingId, ...(p.storageRef ? { storageRef: p.storageRef } : {}) }))];
        return tx.create<BotDeletion>({ model: 'botDeletions', data: { id, namespace, state: 'pending', resources, createdAt: new Date().toISOString() } });
      });
    },
    async beginBotProducer(input: Omit<ProducerIntent, 'id' | 'state' | 'createdAt' | 'reconciliationReason'>): Promise<ProducerIntent> {
      return transaction(async tx => {
        await assertBotWritable(tx, input.botId, input.namespace);
        const existing = await tx.count({ model: 'botProducers', where: botWhere(input.botId, input.namespace) });
        if (existing >= 64) throw blocked();
        return tx.create<ProducerIntent>({ model: 'botProducers', data: { ...input, id: randomUUID(), state: 'active', createdAt: new Date().toISOString() } });
      });
    },
    async finishBotProducer(id: string, namespace: string, succeeded: boolean): Promise<void> {
      await transaction(async tx => {
        const producer = await tx.findOne<ProducerIntent>({ model: 'botProducers', where: where(id, namespace) });
        if (!producer) return;
        await lockBot(tx, producer.botId, namespace);
        const deletion = await tx.findOne<BotDeletion>({ model: 'botDeletions', where: where(producer.botId, namespace) });
        const persisted = await tx.findOne<Recording>({ model: 'recordings', where: where(producer.recordingId, namespace) });
        const recorded = persisted?.botId === producer.botId && (!producer.storageRef || persisted?.storageRef === producer.storageRef);
        if (succeeded && !deletion && recorded) await tx.delete({ model: 'botProducers', where: where(id, namespace) });
        else await tx.update({ model: 'botProducers', where: where(id, namespace), data: { state: succeeded ? 'settled' : 'uncertain' } });
      });
    },
    async listBotProducers(botId: string, namespace: string): Promise<ProducerIntent[]> {
      return readAll<ProducerIntent>(adapter, 'botProducers', botWhere(botId, namespace));
    },
    /** Explicit operator recovery only after the original external operation is known stopped.
     * Never invoke on timeout/lease expiry alone: a late writer could recreate deleted objects. */
    async reconcileBotProducer(id: string, namespace: string, proof: { operationStopped: true; reason: string }): Promise<void> {
      if (proof.operationStopped !== true || !proof.reason.trim() || proof.reason.length > 1000) throw blocked();
      await transaction(async tx => {
        const producer = await tx.findOne<ProducerIntent>({ model: 'botProducers', where: where(id, namespace) });
        if (!producer) throw blocked();
        await lockBot(tx, producer.botId, namespace);
        const deletion = await tx.findOne<BotDeletion>({ model: 'botDeletions', where: where(producer.botId, namespace) });
        if (!deletion || deletion.state !== 'pending') throw blocked();
        await tx.update({ model: 'botProducers', where: where(id, namespace), data: { state: 'settled', reconciliationReason: proof.reason } });
      });
    },
    async completeBotDeletion(id: string, namespace: string): Promise<void> {
      await transaction(async tx => {
        if (await tx.findOne({ model: 'bots', where: where(id, namespace) })) throw blocked();
        const producers = await readAll<ProducerIntent>(tx, 'botProducers', botWhere(id, namespace));
        if (producers.some(p => p.state !== 'settled')) throw blocked();
        await tx.update({ model: 'botDeletions', where: where(id, namespace), data: { state: 'completed', resources: [] } });
        await tx.deleteMany({ model: 'botProducers', where: botWhere(id, namespace) });
      });
    },
  };
}

export function fenceStore(store: RecFnStore, adapter: Adapter, scoped: (tx: Adapter) => RecFnStore): RecFnStore {
  const botMethods = new Set(['addParticipant', 'updateParticipant', 'addChatMessage', 'upsertMetadata']);
  const guarded = new Set([...botMethods, 'createRecording', 'createTranscript', 'updateTranscript', 'setEventBotId']);
  return new Proxy(store, { get(target, property, receiver) {
    if (typeof property !== 'string' || !guarded.has(property)) return Reflect.get(target, property, receiver);
    return async (...args: any[]) => {
      if (!adapter.capabilities.transactions.supported) throw new Error('Producer fencing requires database transactions');
      return adapter.transaction(async borrowed => {
        const tx = transactionalView(borrowed);
        let botId: string; let namespace: string;
        if (property === 'createRecording') { botId = args[0].botId; namespace = args[1]; }
        else if (property === 'setEventBotId') { botId = args[2]; namespace = args[3]; }
        else if (property === 'createTranscript' || property === 'updateTranscript') {
          namespace = args[1]; let recordingId = args[0].recordingId;
          if (property === 'updateTranscript') {
            const transcript = await tx.findOne<{ recordingId: string }>({ model: 'transcripts', where: where(args[0], namespace) });
            if (!transcript) return null; recordingId = transcript.recordingId;
          }
          const recording = await tx.findOne<Recording>({ model: 'recordings', where: where(recordingId, namespace) });
          if (!recording) throw blocked(); botId = recording.botId;
        } else { botId = args[0]; namespace = property === 'updateParticipant' ? args[2] : property === 'addParticipant' || property === 'addChatMessage' || property === 'upsertMetadata' ? args[2] : args[1]; }
        await assertBotWritable(tx, botId, namespace);
        const raw = scoped(tx);
        return (raw[property as keyof RecFnStore] as (...values: any[]) => unknown).apply(raw, args);
      });
    };
  } });
}
