import type { CalendarEvent } from 'recfn';

export interface OutlookCalendarEvent {
  id: string;
  subject?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  body?: { content?: string };
  onlineMeeting?: { joinUrl?: string };
  isOnlineMeeting?: boolean;
}

export interface OutlookCalendarClient {
  listEvents(
    accessToken: string,
    opts: { from: string; to: string },
  ): Promise<OutlookCalendarEvent[]>;
  validateToken(accessToken: string): Promise<boolean>;
}

function extractMeetingUrl(event: OutlookCalendarEvent): string | undefined {
  if (event.onlineMeeting?.joinUrl) return event.onlineMeeting.joinUrl;
  if (event.body?.content) {
    const urlMatch = event.body.content.match(
      /https?:\/\/(?:teams\.microsoft|zoom\.us|meet\.google)[^\s"<>)]+/i,
    );
    if (urlMatch) return urlMatch[0];
  }
  return undefined;
}

export function createOutlookCalendarClient(): OutlookCalendarClient {
  return {
    async validateToken(accessToken: string): Promise<boolean> {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return res.ok;
    },

    async listEvents(
      accessToken: string,
      opts: { from: string; to: string },
    ): Promise<OutlookCalendarEvent[]> {
      const params = new URLSearchParams({
        startDateTime: opts.from,
        endDateTime: opts.to,
        $orderby: 'start/dateTime',
      });
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarView?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error(`Microsoft Graph API error: ${res.status}`);
      const data = (await res.json()) as { value?: OutlookCalendarEvent[] };
      return data.value ?? [];
    },
  };
}

export function outlookEventsToCalendarEvents(
  events: OutlookCalendarEvent[],
  calendarId: string,
  botIdByEventId: Map<string, string>,
): CalendarEvent[] {
  return events.map((e) => ({
    id: e.id,
    calendarId,
    title: e.subject ?? 'Untitled',
    startTime: e.start?.dateTime ?? '',
    endTime: e.end?.dateTime ?? '',
    meetingUrl: extractMeetingUrl(e),
    botId: botIdByEventId.get(e.id),
  }));
}
