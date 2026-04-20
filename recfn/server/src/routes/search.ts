import type { Route, RouteContext } from '@superfunctions/http';
import type { Participant } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type {
  SearchFnClient,
  TranscriptSearchDocument,
  TranscriptSearchResultItem,
} from '../integrations/searchfn.js';
import { authenticate } from '../middleware/auth.js';
import { checkSearchQueryLength } from '../middleware/limits.js';
import { ok, err } from '../middleware/envelope.js';
import { ErrorCode } from 'recfn';
import { createTranscriptSearchDocuments } from '../search/indexer.js';

type SearchParticipant = Pick<Participant, 'id' | 'name' | 'email' | 'role'>;

type SearchContextSegment = {
  speakerId: string;
  startTime: number;
  endTime: number;
  text: string;
};

type TranscriptSearchHit = {
  recordingId: string;
  botId: string;
  participant: SearchParticipant | null;
  segment: SearchContextSegment & { confidence: number };
  context: SearchContextSegment[];
};

function compareSearchResults(
  a: TranscriptSearchResultItem,
  b: TranscriptSearchResultItem,
): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }

  const aDoc = a.document;
  const bDoc = b.document;
  const recordingCmp = (aDoc?.recordingId ?? '').localeCompare(bDoc?.recordingId ?? '');
  if (recordingCmp !== 0) {
    return recordingCmp;
  }

  const aIndex = aDoc?.segmentIndex ?? Number.MAX_SAFE_INTEGER;
  const bIndex = bDoc?.segmentIndex ?? Number.MAX_SAFE_INTEGER;
  if (aIndex !== bIndex) {
    return aIndex - bIndex;
  }

  return a.docId.localeCompare(b.docId);
}

function toContextSegment(doc: TranscriptSearchDocument): SearchContextSegment {
  return {
    speakerId: doc.participantId,
    startTime: doc.startTime,
    endTime: doc.endTime,
    text: doc.text,
  };
}

function toParticipantSummary(
  participant: Participant | undefined,
): SearchParticipant | null {
  if (!participant) {
    return null;
  }

  return {
    id: participant.id,
    name: participant.name,
    email: participant.email,
    role: participant.role,
  };
}

export interface SearchRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  limits: import('../config.js').RecFnLimitsConfig;
  searchClient: SearchFnClient | null;
}

export function createSearchRoutes(deps: SearchRouteDeps): Route[] {
  const { store, validateApiKey, limits, searchClient } = deps;

  return [
    {
      method: 'GET',
      path: '/api/v1/transcripts/search',
      handler: async (request: Request, _ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);

        if (!searchClient) {
          return err(
            ErrorCode.INTERNAL_ERROR,
            'Search is not configured.',
          );
        }

        const url = new URL(request.url);
        const q = url.searchParams.get('q');
        const botId = url.searchParams.get('botId') ?? undefined;
        const limit = url.searchParams.get('limit');
        const limitNum = limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 20;

        if (!q || !q.trim()) {
          return err(
            ErrorCode.BAD_REQUEST,
            'Query parameter "q" is required.',
          );
        }

        const trimmed = q.trim();
        try {
          checkSearchQueryLength(trimmed, limits);
        } catch (e) {
          return err(
            (e as import('recfn').RecFnError).code,
            (e as Error).message,
          );
        }

        const results = await searchClient.search(trimmed, { limit: limitNum, botId });
        const orderedResults = [...results].sort(compareSearchResults);
        const participantCache = new Map<string, Map<string, Participant>>();
        const transcriptDocumentCache = new Map<string, TranscriptSearchDocument[]>();

        const enriched = await Promise.all(
          orderedResults.map(async (item): Promise<TranscriptSearchHit | null> => {
            const doc = item.document;
            if (!doc) {
              return null;
            }

            const recording = await store.getRecording(doc.recordingId, auth.namespace);
            if (!recording) {
              return null;
            }

            let transcriptDocs = transcriptDocumentCache.get(doc.recordingId);
            if (!transcriptDocs) {
              const transcript = await store.getTranscript(doc.recordingId, auth.namespace);
              if (!transcript) {
                return null;
              }
              transcriptDocs = createTranscriptSearchDocuments({
                recordingId: doc.recordingId,
                botId: doc.botId,
                segments: transcript.segments,
              });
              transcriptDocumentCache.set(doc.recordingId, transcriptDocs);
            }

            let participantsById = participantCache.get(doc.botId);
            if (!participantsById) {
              const participants = await store.getParticipants(doc.botId, auth.namespace);
              participantsById = new Map(
                participants.map((participant) => [participant.id, participant]),
              );
              participantCache.set(doc.botId, participantsById);
            }

            const contextIndex = transcriptDocs.findIndex(
              (segmentDoc) =>
                segmentDoc.segmentId === doc.segmentId ||
                (segmentDoc.participantId === doc.participantId &&
                  segmentDoc.startTime === doc.startTime &&
                  segmentDoc.endTime === doc.endTime &&
                  segmentDoc.text === doc.text),
            );
            const context =
              contextIndex >= 0
                ? transcriptDocs
                    .slice(Math.max(0, contextIndex - 1), contextIndex + 2)
                    .map(toContextSegment)
                : [toContextSegment(doc)];

            return {
              recordingId: doc.recordingId,
              botId: doc.botId,
              participant: toParticipantSummary(participantsById.get(doc.participantId)),
              segment: {
                speakerId: doc.participantId,
                startTime: doc.startTime,
                endTime: doc.endTime,
                text: doc.text,
                confidence: 0.9,
              },
              context,
            };
          }),
        );

        return ok({
          results: enriched.filter(
            (result): result is TranscriptSearchHit => result !== null,
          ),
          nextCursor: null,
        });
      },
    },
  ];
}
