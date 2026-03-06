import type { CalendarEvent } from 'recfn';

export interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  description?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
  hangoutLink?: string;
}

export interface GoogleCalendarClient {
  listEvents(
    accessToken: string,
    opts: { from: string; to: string },
  ): Promise<GoogleCalendarEvent[]>;
  validateToken(accessToken: string): Promise<boolean>;
}

function extractMeetingUrl(event: GoogleCalendarEvent): string | undefined {
  if (event.hangoutLink) return event.hangoutLink;
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  for (const ep of entryPoints) {
    const uri = ep.uri;
    if (uri && (uri.includes('zoom') || uri.includes('meet') || uri.includes('teams'))) {
      return uri;
    }
  }
  if (event.description) {
    const urlMatch = event.description.match(
      /https?:\/\/(?:zoom\.us|meet\.google|teams\.microsoft)[^\s)]+/i,
    );
    if (urlMatch) return urlMatch[0];
  }
  return undefined;
}

export function createGoogleCalendarClient(): GoogleCalendarClient {
  return {
    async validateToken(accessToken: string): Promise<boolean> {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return res.ok;
    },

    async listEvents(
      accessToken: string,
      opts: { from: string; to: string },
    ): Promise<GoogleCalendarEvent[]> {
      const params = new URLSearchParams({
        timeMin: opts.from,
        timeMax: opts.to,
        singleEvents: 'true',
        orderBy: 'startTime',
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error(`Google Calendar API error: ${res.status}`);
      const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
      return data.items ?? [];
    },
  };
}

export function googleEventsToCalendarEvents(
  events: GoogleCalendarEvent[],
  calendarId: string,
  botIdByEventId: Map<string, string>,
): CalendarEvent[] {
  return events.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? '';
    const end = e.end?.dateTime ?? e.end?.date ?? '';
    return {
      id: e.id,
      calendarId,
      title: e.summary ?? 'Untitled',
      startTime: start,
      endTime: end,
      meetingUrl: extractMeetingUrl(e),
      botId: botIdByEventId.get(e.id),
    };
  });
}
