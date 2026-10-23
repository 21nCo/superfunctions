import { MemoryAdapter } from '@searchfn/adapter-memory';

export interface TranscriptSearchDocument {
  segmentId?: string;
  segmentIndex?: number;
  recordingId: string;
  botId: string;
  participantId: string;
  startTime: number;
  endTime: number;
  text: string;
}

const RESOURCE = 'transcripts';

export interface SearchFnClient {
  index(documents: TranscriptSearchDocument[]): Promise<void>;
  search(query: string, opts?: { limit?: number; botId?: string }): Promise<TranscriptSearchResultItem[]>;
  removeByRecording(recordingId: string): Promise<void>;
}

export interface TranscriptSearchResultItem {
  docId: string;
  score: number;
  document?: TranscriptSearchDocument;
}

type SearchResultRow = {
  id: string | number;
  score: number;
};

function createSegmentId(recordingId: string, index: number): string {
  return `${recordingId}::seg::${index}`;
}

export function createSearchFnClient(): SearchFnClient {
  const search = new MemoryAdapter();
  const docIdToMeta = new Map<string, TranscriptSearchDocument>();

  return {
    async index(documents: TranscriptSearchDocument[]) {
      const payload: Array<{ id: string; fields: Record<string, string> }> = [];
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i]!;
        const segmentId = doc.segmentId ?? createSegmentId(doc.recordingId, i);
        const toStore = { ...doc, segmentId };
        payload.push({ id: segmentId, fields: { text: doc.text } });
        docIdToMeta.set(segmentId, toStore);
      }

      if (payload.length > 0) {
        await search.index({ resource: RESOURCE, documents: payload });
      }
    },

    async search(query: string, opts?: { limit?: number; botId?: string }) {
      const results = await search.searchAll!({
        query,
        resources: [RESOURCE],
        limit: opts?.limit ?? 20,
      });

      let items = results.map((r: SearchResultRow) => ({
        docId: String(r.id),
        score: r.score,
        document: docIdToMeta.get(String(r.id)),
      }));

      if (opts?.botId) {
        items = items.filter(
          (i: TranscriptSearchResultItem) => i.document?.botId === opts.botId,
        );
      }

      return items;
    },

    async removeByRecording(recordingId: string) {
      const toRemove: string[] = [];
      for (const [docId, doc] of docIdToMeta.entries()) {
        if (doc.recordingId === recordingId) {
          toRemove.push(docId);
        }
      }

      if (toRemove.length > 0) {
        await search.remove({ resource: RESOURCE, ids: toRemove });
      }

      for (const docId of toRemove) {
        docIdToMeta.delete(docId);
      }
    },
  };
}
