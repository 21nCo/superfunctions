# Phase 14: Analytics and transcript search (searchfn)

## Phase goal
Implement meeting analytics computation (talk time, silence, topic segmentation) and transcript full-text search via searchfn integration.

## In scope
- Analytics computation from transcript segments: talk time per participant, silence percentage, topic segmentation.
- GET /recordings/:recordingId/analytics endpoint.
- searchfn integration: index transcript segments on completion.
- GET /transcripts/search endpoint.
- Index update within 60s of transcript completion.

## Out of scope
- New ASR adapters. Calendar. Desktop.

## Deliverables
- `recfn/core/src/analytics/talk-time.ts` — talk time computation
- `recfn/core/src/analytics/silence.ts` — silence percentage computation
- `recfn/core/src/analytics/topics.ts` — topic segmentation (keyword clustering)
- `recfn/core/src/analytics/index.ts` — analytics entry point
- `recfn/server/src/routes/analytics.ts` — analytics API route
- `recfn/server/src/integrations/searchfn.ts` — searchfn client wrapper
- `recfn/server/src/search/indexer.ts` — transcript segment indexer
- `recfn/server/src/routes/search.ts` — transcript search route
- `recfn/core/__tests__/analytics.test.ts`
- `recfn/server/__tests__/api-analytics.test.ts`
- `recfn/server/__tests__/search-indexer.test.ts`
- `recfn/server/__tests__/api-search.test.ts`

## Requirements covered
- ANA-001, ANA-002, ANA-003, SRCH-001, SRCH-002, INT-003

## Implementation tasks
1. Implement talk-time.ts: sum (endTime - startTime) per speakerId from segments.
2. Implement silence.ts: compute silence = (totalDuration - sum of all segment durations) / totalDuration. Handle overlapping segments.
3. Implement topics.ts: keyword-frequency clustering (TF-IDF) over sliding window of segments. Produce TopicSegment[] with topic label, startTime, endTime, keywords.
4. Implement analytics entry point: combine talk time + silence + topics into Analytics object.
5. Implement GET /recordings/:recordingId/analytics: compute analytics from stored transcript. Return 422 ANALYTICS_NOT_READY if transcript not ready.
6. Create searchfn client wrapper: index(documents), search(query, opts).
7. Implement search indexer: on transcript completion (hook into transcription pipeline), index segments with metadata (botId, recordingId, participantId, timestamps).
8. Implement GET /transcripts/search: query searchfn, return results with context.
9. Write tests: analytics computation with known segments, search indexing and retrieval.

## Verification steps
- `cd recfn/core && npx vitest run` — analytics tests pass.
- `cd recfn/server && npx vitest run` — analytics and search tests pass.
- Tests cover: TV-ANA-001, TV-ANA-002, TV-ANA-003, TV-SRCH-001, TV-SRCH-002.

## Stop condition
- Analytics computed correctly from segments. Search indexes and returns results. All tests pass. Report: "Phase 14 complete; analytics and search ready for Phase 15."
