import { InMemorySearchFn } from '@searchfn/client';

export interface TranscriptSearchDocument {
  segmentId?: string;
  recordingId: string;
  botId: string;
  participantId: string;
  startTime: number;
  endTime: number;
  text: string;
}

const FIELDS = ['text'];

export interface SearchFnClient {
  index(documents: TranscriptSearchDocument[]): void;
  search(query: string, opts?: { limit?: number; botId?: string }): TranscriptSearchResultItem[];
  removeByRecording(recordingId: string): void;
}

export interface TranscriptSearchResultItem {
  docId: string;
  score: number;
  document?: TranscriptSearchDocument;
}

function createSegmentId(recordingId: string, index: number): string {
  return `${recordingId}::seg::${index}`;
}

export function createSearchFnClient(): SearchFnClient {
  const search = new InMemorySearchFn({ fields: FIELDS });
  const docIdToMeta = new Map<string, TranscriptSearchDocument>();

  return {
    index(documents: TranscriptSearchDocument[]) {
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i]!;
        const segmentId = doc.segmentId ?? createSegmentId(doc.recordingId, i);
        const toStore = { ...doc, segmentId };
        search.add({
          id: segmentId,
          fields: { text: doc.text },
          store: toStore,
        });
        docIdToMeta.set(segmentId, toStore);
      }
    },

    search(query: string, opts?: { limit?: number; botId?: string }) {
      const results = search.searchDetailed(query, {
        limit: opts?.limit ?? 20,
        includeStored: true,
      });

      let items = results.map((r) => ({
        docId: r.docId as string,
        score: r.score,
        document: r.document as TranscriptSearchDocument | undefined,
      }));

      if (opts?.botId) {
        items = items.filter((i) => i.document?.botId === opts.botId);
      }

      return items;
    },

    removeByRecording(recordingId: string) {
      const toRemove: string[] = [];
      for (const [docId, doc] of docIdToMeta.entries()) {
        if (doc.recordingId === recordingId) {
          toRemove.push(docId);
        }
      }
      for (const docId of toRemove) {
        search.remove(docId);
        docIdToMeta.delete(docId);
      }
    },
  };
}
