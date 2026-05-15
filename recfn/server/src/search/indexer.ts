import type { Segment } from '@recfn/core';
import type { SearchFnClient, TranscriptSearchDocument } from '../integrations/searchfn.js';
import { sortSegmentsDeterministically } from '@recfn/shared-cloud';

export interface IndexTranscriptInput {
  recordingId: string;
  botId: string;
  segments: Segment[];
}

/**
 * Index transcript segments into searchfn.
 * Called when transcript becomes ready (within 60s of completion).
 * Re-indexing replaces existing segments for the recording.
 */
export function createTranscriptSearchDocuments(
  input: IndexTranscriptInput,
): TranscriptSearchDocument[] {
  const sortedSegments = sortSegmentsDeterministically(input.segments);
  return sortedSegments.map((seg, i) => ({
    segmentId: `${input.recordingId}::seg::${i}`,
    segmentIndex: i,
    recordingId: input.recordingId,
    botId: input.botId,
    participantId: seg.speakerId,
    startTime: seg.startTime,
    endTime: seg.endTime,
    text: seg.text,
  }));
}

export function indexTranscript(
  input: IndexTranscriptInput,
  searchClient: SearchFnClient,
): Promise<void> {
  return (async () => {
    await searchClient.removeByRecording(input.recordingId);

    const documents = createTranscriptSearchDocuments(input);

    await searchClient.index(documents);
  })();
}
