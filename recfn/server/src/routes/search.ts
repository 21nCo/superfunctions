import type { Route, RouteContext } from '@superfunctions/http';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { SearchFnClient } from '../integrations/searchfn.js';
import { authenticate } from '../middleware/auth.js';
import { checkSearchQueryLength } from '../middleware/limits.js';
import { ok, err } from '../middleware/envelope.js';
import { ErrorCode } from 'recfn';

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

        const results = searchClient.search(trimmed, { limit: limitNum, botId });

        const enriched = await Promise.all(
          results.map(async (item) => {
            const doc = item.document;
            if (!doc) {
              return {
                recordingId: '',
                botId: '',
                segment: {},
                context: [] as unknown[],
              };
            }

            const recording = await store.getRecording(doc.recordingId, auth.namespace);
            const transcript = recording
              ? await store.getTranscript(doc.recordingId, auth.namespace)
              : null;

            let context: unknown[] = [];
            if (transcript?.segments) {
              const idx = transcript.segments.findIndex(
                (s) =>
                  s.speakerId === doc.participantId &&
                  s.startTime === doc.startTime &&
                  s.text === doc.text,
              );
              if (idx >= 0) {
                const before = transcript.segments.slice(Math.max(0, idx - 1), idx);
                const after = transcript.segments.slice(idx + 1, idx + 2);
                context = [...before, transcript.segments[idx], ...after].filter(Boolean);
              }
            }

            return {
              recordingId: doc.recordingId,
              botId: doc.botId,
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
          results: enriched.filter((r) => r.recordingId),
          nextCursor: null,
        });
      },
    },
  ];
}
