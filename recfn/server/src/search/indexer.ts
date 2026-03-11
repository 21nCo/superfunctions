import type { Segment } from 'recfn';
import type { SearchFnClient, TranscriptSearchDocument } from '../integrations/searchfn.js';

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
export function indexTranscript(
  input: IndexTranscriptInput,
  searchClient: SearchFnClient,
): Promise<void> {
  return (async () => {
    await searchClient.removeByRecording(input.recordingId);

    const documents: TranscriptSearchDocument[] = input.segments.map((seg, i) => ({
      segmentId: `${input.recordingId}::seg::${i}`,
      recordingId: input.recordingId,
      botId: input.botId,
      participantId: seg.speakerId,
      startTime: seg.startTime,
      endTime: seg.endTime,
      text: seg.text,
    }));

    await searchClient.index(documents);
  })();
}
