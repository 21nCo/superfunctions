export type OutputFormat = 'text' | 'json';

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatBotList(data: { bots: unknown[]; nextCursor?: string | null }): string {
  if (data.bots.length === 0) {
    return 'No bots found.';
  }
  const lines = data.bots.map((b) => {
    const x = b as { id?: string; status?: string; platform?: string };
    return `  ${x.id}  ${x.status ?? '-'}  ${x.platform ?? '-'}`;
  });
  return ['ID\tStatus\tPlatform', ...lines].join('\n');
}

export function formatBot(bot: { id: string; status: string; platform: string; meetingUrl?: string }): string {
  return [
    `ID: ${bot.id}`,
    `Status: ${bot.status}`,
    `Platform: ${bot.platform}`,
    bot.meetingUrl ? `Meeting: ${bot.meetingUrl}` : null,
  ].filter(Boolean).join('\n');
}

export function formatRecordingList(data: { recordings: unknown[] }): string {
  if (data.recordings.length === 0) {
    return 'No recordings found.';
  }
  const lines = data.recordings.map((r) => {
    const x = r as { id?: string; format?: string; duration?: number };
    return `  ${x.id}  ${x.format ?? '-'}  ${(x.duration ?? 0) / 1000}s`;
  });
  return ['ID\tFormat\tDuration', ...lines].join('\n');
}

export function formatTranscriptSearch(data: { results: unknown[]; nextCursor?: string | null }): string {
  if (data.results.length === 0) {
    return 'No results found.';
  }
  const lines = data.results.map((r) => {
    const x = r as { recordingId?: string; segment?: { text?: string } };
    const seg = x.segment;
    return `  ${x.recordingId}  ${seg?.text?.slice(0, 50) ?? '-'}...`;
  });
  return ['Recording\tSnippet', ...lines].join('\n');
}

export function formatAnalytics(data: {
  recordingId: string;
  totalDuration: number;
  talkTime: Record<string, number>;
  silencePercentage: number;
}): string {
  const lines = [
    `Recording: ${data.recordingId}`,
    `Duration: ${(data.totalDuration / 1000).toFixed(1)}s`,
    `Silence: ${(data.silencePercentage * 100).toFixed(1)}%`,
    'Talk time:',
    ...Object.entries(data.talkTime ?? {}).map(([id, ms]) => `  ${id}: ${(ms / 1000).toFixed(1)}s`),
  ];
  return lines.join('\n');
}

export function formatCalendarList(data: { calendars: unknown[] }): string {
  if (data.calendars.length === 0) {
    return 'No calendars connected.';
  }
  const lines = data.calendars.map((c) => {
    const x = c as { id?: string; provider?: string };
    return `  ${x.id}  ${x.provider ?? '-'}`;
  });
  return ['ID\tProvider', ...lines].join('\n');
}
