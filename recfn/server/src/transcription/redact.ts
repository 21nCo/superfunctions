import type { Participant, Segment } from 'recfn';

const REDACTED = '[REDACTED]';

/**
 * Redacts participant names and emails from segment text.
 * Replaces occurrences of participant names and emails with [REDACTED].
 */
export function redactSegmentText(
  segments: Segment[],
  participants: Participant[],
): Segment[] {
  const namesAndEmails: string[] = [];
  for (const p of participants) {
    if (p.name?.trim()) namesAndEmails.push(p.name.trim());
    if (p.email?.trim()) namesAndEmails.push(p.email.trim());
  }
  if (namesAndEmails.length === 0) return segments;

  // Sort by length descending so longer strings are replaced first
  // (e.g. "John Smith" before "John")
  const sorted = [...namesAndEmails].sort((a, b) => b.length - a.length);

  return segments.map((seg) => {
    let text = seg.text;
    for (const s of sorted) {
      if (!s) continue;
      // Replace whole occurrences (case-sensitive for emails, names)
      text = text.split(s).join(REDACTED);
    }
    return { ...seg, text };
  });
}

/**
 * Returns the display label for a speaker for use in formatted output.
 * When redact is true and speakerId maps to a participant, returns [REDACTED].
 * Otherwise returns participant name when available, else speakerId.
 */
export function getSpeakerDisplayLabel(
  speakerId: string,
  participants: Participant[],
  redact: boolean,
): string {
  const participant = participants.find((p) => p.id === speakerId);
  if (redact && participant) return REDACTED;
  if (participant?.name) return participant.name;
  return speakerId;
}
