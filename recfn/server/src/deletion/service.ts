import type { RecFnStore } from '../store/types.js';
import type { StorageAdapter } from '../integrations/storage.js';
import type { SearchFnClient } from '../integrations/searchfn.js';

export type DeleteBotResult = { deleted: true; state: 'completed' } | { deleted: false; state: 'pending' | 'blocked'; producerIds?: string[]; reason?: string };

/** Retry the same bot ID after failure/restart. Tombstones are retained permanently. */
export async function deleteBotAggregate(botId: string, namespace: string, deps: { store: RecFnStore; storage?: StorageAdapter; searchClient?: SearchFnClient | null }): Promise<DeleteBotResult | null> {
  const { store, storage, searchClient } = deps;
  const intent = await store.beginBotDeletion(botId, namespace);
  if (!intent) return null;
  if (intent.state === 'completed') return { deleted: true, state: 'completed' };
  const producers = await store.listBotProducers(botId, namespace);
  const unresolved = producers.filter(p => p.state !== 'settled');
  if (unresolved.length) return { deleted: false, state: 'blocked', producerIds: unresolved.map(p => p.id), reason: 'External producer completion is unknown; reconcile only after proving the operation stopped.' };
  if (intent.resources.some(r => r.storageRef) && !storage) return { deleted: false, state: 'blocked', reason: 'Recording storage is required for cleanup.' };
  if (intent.resources.length && !searchClient) return { deleted: false, state: 'blocked', reason: 'Search cleanup adapter is required for recording cleanup; absence does not prove the index is empty.' };
  // Repeating idempotent removals is intentional: a crash between an external
  // delete and its database acknowledgement must not lose cleanup ownership.
  try {
    for (const recordingId of new Set(intent.resources.map(r => r.recordingId))) {
      if (searchClient) await searchClient.removeByRecording(recordingId);
    }
    for (const key of new Set(intent.resources.flatMap(r => r.storageRef ? [r.storageRef] : []))) {
      await storage!.deleteObject({ key });
    }
    await store.deleteBot(botId, namespace);
    await store.completeBotDeletion(botId, namespace);
    return { deleted: true, state: 'completed' };
  } catch {
    return { deleted: false, state: 'pending', reason: 'Cleanup failed; retry deletion using the same bot ID.' };
  }
}
