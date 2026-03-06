import type {
  Bot,
  Calendar,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Recording,
  Transcript,
  Webhook,
} from 'recfn';
import type {
  CreateBotInput,
  ListBotsOptions,
  ListResult,
  RecFnStore,
} from './types.js';

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${ts}${rand}`;
}

export function createMemoryStore(): RecFnStore {
  const bots = new Map<string, Bot & { namespace: string }>();
  const recordings = new Map<string, Recording & { namespace: string }>();
  const transcripts = new Map<string, Transcript & { namespace: string }>();
  const participants = new Map<string, (Participant & { namespace: string })[]>();
  const chatMessages = new Map<string, (ChatMessage & { namespace: string })[]>();
  const metadata = new Map<string, MeetingMetadata & { namespace: string }>();
  const webhooks = new Map<string, Webhook & { namespace: string }>();
  const calendars = new Map<string, Calendar & { namespace: string }>();
  const eventBotIds = new Map<string, string>();

  return {
    async createBot(input: CreateBotInput): Promise<Bot> {
      const now = new Date().toISOString();
      const bot: Bot & { namespace: string } = {
        id: generateId('bot'),
        namespace: input.namespace,
        meetingUrl: input.meetingUrl,
        platform: input.platform,
        status: 'creating',
        config: input.config,
        createdAt: now,
        updatedAt: now,
      };
      bots.set(bot.id, bot);
      return { ...bot };
    },

    async getBot(id: string, namespace: string): Promise<Bot | null> {
      const bot = bots.get(id);
      if (!bot || bot.namespace !== namespace) return null;
      return { ...bot };
    },

    async listBots(
      namespace: string,
      opts: ListBotsOptions,
    ): Promise<ListResult<Bot>> {
      const limit = Math.min(opts.limit ?? 20, 100);
      let items = [...bots.values()]
        .filter((b) => b.namespace === namespace)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

      if (opts.status) {
        items = items.filter((b) => b.status === opts.status);
      }
      if (opts.platform) {
        items = items.filter((b) => b.platform === opts.platform);
      }

      let startIndex = 0;
      if (opts.cursor) {
        const cursorIndex = items.findIndex((b) => b.id === opts.cursor);
        if (cursorIndex >= 0) {
          startIndex = cursorIndex + 1;
        }
      }

      const page = items.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < items.length;

      return {
        items: page.map((b) => ({ ...b })),
        nextCursor: hasMore ? page[page.length - 1]?.id : undefined,
      };
    },

    async updateBot(
      id: string,
      namespace: string,
      updates: Partial<Pick<Bot, 'status' | 'errorMessage' | 'updatedAt'>>,
    ): Promise<Bot | null> {
      const bot = bots.get(id);
      if (!bot || bot.namespace !== namespace) return null;

      if (updates.status !== undefined) bot.status = updates.status;
      if (updates.errorMessage !== undefined)
        bot.errorMessage = updates.errorMessage;
      bot.updatedAt = updates.updatedAt ?? new Date().toISOString();
      return { ...bot };
    },

    async deleteBot(id: string, namespace: string): Promise<boolean> {
      const bot = bots.get(id);
      if (!bot || bot.namespace !== namespace) return false;
      bots.delete(id);

      // Cascade: delete recordings, transcripts, participants, chat, metadata
      for (const [recId, rec] of recordings) {
        if (rec.botId === id) {
          recordings.delete(recId);
          // Delete transcripts for this recording
          for (const [trxId, trx] of transcripts) {
            if (trx.recordingId === recId) transcripts.delete(trxId);
          }
        }
      }
      participants.delete(id);
      chatMessages.delete(id);
      metadata.delete(id);

      return true;
    },

    async createWebhook(
      input: Omit<Webhook, 'id' | 'createdAt'>,
      namespace: string,
    ): Promise<Webhook> {
      const id = `wh_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
      const createdAt = new Date().toISOString();
      const webhook: Webhook & { namespace: string } = {
        ...input,
        id,
        createdAt,
        namespace,
      };
      webhooks.set(id, webhook);
      return { ...webhook, namespace: undefined as unknown as string };
    },

    async listWebhooks(namespace: string): Promise<Webhook[]> {
      return [...webhooks.values()]
        .filter((w) => w.namespace === namespace)
        .map(({ namespace: _ns, ...rest }) => rest);
    },

    async getWebhook(id: string, namespace: string): Promise<Webhook | null> {
      const w = webhooks.get(id);
      if (!w || w.namespace !== namespace) return null;
      const { namespace: _ns, ...rest } = w;
      return rest;
    },

    async deleteWebhook(id: string, namespace: string): Promise<boolean> {
      const w = webhooks.get(id);
      if (!w || w.namespace !== namespace) return false;
      webhooks.delete(id);
      return true;
    },

    async createRecording(
      recording: Recording,
      namespace: string,
    ): Promise<Recording> {
      const rec: Recording & { namespace: string } = {
        ...recording,
        namespace,
      };
      recordings.set(recording.id, rec);
      return { ...recording };
    },

    async getRecordings(
      botId: string,
      namespace: string,
    ): Promise<Recording[]> {
      const bot = bots.get(botId);
      if (!bot || bot.namespace !== namespace) return [];

      return [...recordings.values()]
        .filter((r) => r.botId === botId && r.namespace === namespace)
        .map(({ namespace: _ns, ...rest }) => rest);
    },

    async getRecording(
      id: string,
      namespace: string,
    ): Promise<(Recording & { namespace?: string }) | null> {
      const rec = recordings.get(id);
      if (!rec || rec.namespace !== namespace) return null;
      return { ...rec };
    },

    async createTranscript(
      transcript: Transcript,
      namespace: string,
    ): Promise<Transcript> {
      const trx: Transcript & { namespace: string } = {
        ...transcript,
        namespace,
      };
      transcripts.set(transcript.id, trx);
      return { ...transcript };
    },

    async updateTranscript(
      id: string,
      namespace: string,
      updates: Partial<Pick<Transcript, 'status' | 'segments'>>,
    ): Promise<Transcript | null> {
      const trx = transcripts.get(id);
      if (!trx || trx.namespace !== namespace) return null;

      if (updates.status !== undefined) trx.status = updates.status;
      if (updates.segments !== undefined) trx.segments = updates.segments;

      const { namespace: _ns, ...rest } = trx;
      return rest;
    },

    async getTranscript(
      recordingId: string,
      namespace: string,
    ): Promise<Transcript | null> {
      for (const trx of transcripts.values()) {
        if (
          trx.recordingId === recordingId &&
          trx.namespace === namespace
        ) {
          const { namespace: _ns, ...rest } = trx;
          return rest;
        }
      }
      return null;
    },

    async getParticipants(
      botId: string,
      namespace: string,
    ): Promise<Participant[]> {
      const bot = bots.get(botId);
      if (!bot || bot.namespace !== namespace) return [];

      const parts = participants.get(botId) ?? [];
      return parts
        .filter((p) => p.namespace === namespace)
        .map(({ namespace: _ns, ...rest }) => rest);
    },

    async addParticipant(
      botId: string,
      participant: Participant,
      namespace: string,
    ): Promise<Participant> {
      const bot = bots.get(botId);
      if (!bot || bot.namespace !== namespace) {
        throw new Error('Bot not found or namespace mismatch');
      }
      const parts = participants.get(botId) ?? [];
      const withNs: Participant & { namespace: string } = {
        ...participant,
        namespace,
      };
      const existing = parts.findIndex((p) => p.id === participant.id);
      if (existing >= 0) {
        parts[existing] = withNs;
      } else {
        parts.push(withNs);
      }
      participants.set(botId, parts);
      return participant;
    },

    async updateParticipant(
      botId: string,
      participantId: string,
      namespace: string,
      updates: Partial<Pick<Participant, 'leftAt' | 'consent'>>,
    ): Promise<Participant | null> {
      const bot = bots.get(botId);
      if (!bot || bot.namespace !== namespace) return null;

      const parts = participants.get(botId) ?? [];
      const idx = parts.findIndex((p) => p.id === participantId);
      if (idx < 0) return null;

      const p = parts[idx];
      if (updates.leftAt !== undefined) p.leftAt = updates.leftAt;
      if (updates.consent !== undefined) p.consent = updates.consent;
      participants.set(botId, parts);

      const { namespace: _ns, ...rest } = p;
      return rest;
    },

    async getChatMessages(
      botId: string,
      namespace: string,
    ): Promise<ChatMessage[]> {
      const bot = bots.get(botId);
      if (!bot || bot.namespace !== namespace) return [];

      const msgs = chatMessages.get(botId) ?? [];
      return msgs
        .filter((m) => m.namespace === namespace)
        .map(({ namespace: _ns, ...rest }) => rest);
    },

    async getMetadata(
      botId: string,
      namespace: string,
    ): Promise<MeetingMetadata | null> {
      const bot = bots.get(botId);
      if (!bot || bot.namespace !== namespace) return null;

      const meta = metadata.get(botId);
      if (!meta || meta.namespace !== namespace) return null;
      const { namespace: _ns, ...rest } = meta;
      return rest;
    },

    async createCalendar(
      input: Omit<Calendar, 'id' | 'createdAt'>,
      namespace: string,
    ): Promise<Calendar> {
      const id = `cal_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
      const createdAt = new Date().toISOString();
      const cal: Calendar & { namespace: string } = {
        ...input,
        id,
        createdAt,
        namespace,
      };
      calendars.set(id, cal);
      return { ...cal, namespace: undefined as unknown as string };
    },

    async listCalendars(namespace: string): Promise<Calendar[]> {
      return [...calendars.values()]
        .filter((c) => c.namespace === namespace)
        .map(({ namespace: _ns, ...rest }) => rest);
    },

    async getCalendar(id: string, namespace: string): Promise<Calendar | null> {
      const cal = calendars.get(id);
      if (!cal || cal.namespace !== namespace) return null;
      const { namespace: _ns, ...rest } = cal;
      return rest;
    },

    async deleteCalendar(id: string, namespace: string): Promise<boolean> {
      const cal = calendars.get(id);
      if (!cal || cal.namespace !== namespace) return false;
      calendars.delete(id);
      for (const [key] of eventBotIds) {
        if (key.startsWith(`${id}:`)) eventBotIds.delete(key);
      }
      return true;
    },

    async setEventBotId(
      calendarId: string,
      eventId: string,
      botId: string,
      _namespace: string,
    ): Promise<void> {
      eventBotIds.set(`${calendarId}:${eventId}`, botId);
    },

    async getEventBotIds(
      calendarId: string,
      eventIds: string[],
      _namespace: string,
    ): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      for (const eid of eventIds) {
        const bid = eventBotIds.get(`${calendarId}:${eid}`);
        if (bid) map.set(eid, bid);
      }
      return map;
    },
  };
}
