import { getRecFnSchema } from './schema.js';
import { NotFoundError, wrapWithSchema, type Adapter, type WhereClause } from '@superfunctions/db';
import type {
  Bot,
  Calendar,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Recording,
  Transcript,
  Webhook,
} from '@recfn/core';
import type {
  CreateBotInput,
  ListBotsOptions,
  ListResult,
  RecFnStore,
} from './types.js';

export interface CreateDbStoreOptions {
  adapter: Adapter;
  /** Explicit assertion that the configured backend persists across process restarts.
   * Defaults false; database adapter identity alone cannot distinguish SQLite :memory:.
   * The built-in memory adapter is always rejected when true.
   */
  durable?: boolean;
  adapterName?: string;
}

type StoredParticipant = Omit<Participant, 'id'> & {
  id: string;
  participantId: string;
  namespace: string;
};

type StoredChatMessage = ChatMessage & {
  id: string;
  botId: string;
  namespace: string;
};

type StoredMetadata = MeetingMetadata & { namespace: string };
type StoredCalendarEventBot = {
  id: string;
  namespace: string;
  calendarId: string;
  eventId: string;
  botId: string;
};

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${ts}${rand}`;
}

function withNamespace(
  namespace: string,
  where: WhereClause[] = [],
): WhereClause[] {
  return [{ field: 'namespace', operator: 'eq', value: namespace }, ...where];
}

function stripNamespace<T extends { namespace?: string }>(record: T): Omit<T, 'namespace'> {
  const { namespace: _namespace, ...rest } = record;
  return rest;
}

function mapParticipant(record: StoredParticipant): Participant {
  return {
    id: record.participantId,
    botId: record.botId,
    name: record.name,
    email: record.email,
    role: record.role,
    joinedAt: record.joinedAt,
    leftAt: record.leftAt,
    consent: record.consent,
  };
}

function mapMetadata(record: StoredMetadata): MeetingMetadata {
  return {
    id: record.id,
    botId: record.botId,
    title: record.title,
    startTime: record.startTime,
    endTime: record.endTime,
    platform: record.platform,
    chatMessages: record.chatMessages,
  };
}

async function findOptional<T>(
  adapter: Adapter,
  model: string,
  namespace: string,
  where: WhereClause[],
): Promise<T | null> {
  return adapter.findOne<T>({
    model,
    where: withNamespace(namespace, where),
  });
}

export function assertProductionStore(store: RecFnStore): void {
  if (!store.capabilities.durable) {
    throw new Error(
      `RecFn production server requires a durable @superfunctions/db-backed store; received ${store.capabilities.adapterName}.`,
    );
  }
}

export function createDbStore(options: CreateDbStoreOptions): RecFnStore {
  const isMemory = options.adapter.id === 'memory';
  if (isMemory && options.durable === true) {
    throw new TypeError('The shared memory adapter cannot be declared durable');
  }
  const durable = options.durable === true && !isMemory;
  const adapterName = options.adapterName ?? options.adapter.name;
  const adapter = wrapWithSchema(options.adapter, getRecFnSchema());

  return {
    capabilities: {
      durable,
      backend: isMemory ? 'memory' : 'db',
      adapterName,
    },

    async createBot(input: CreateBotInput): Promise<Bot> {
      const now = new Date().toISOString();
      return adapter.create<Bot>({
        model: 'bots',
        data: {
          id: generateId('bot'),
          namespace: input.namespace,
          meetingUrl: input.meetingUrl,
          platform: input.platform,
          status: 'creating',
          config: input.config,
          createdAt: now,
          updatedAt: now,
        },
      });
    },

    async getBot(id: string, namespace: string): Promise<Bot | null> {
      return findOptional<Bot>(adapter, 'bots', namespace, [
        { field: 'id', operator: 'eq', value: id },
      ]);
    },

    async listBots(
      namespace: string,
      opts: ListBotsOptions,
    ): Promise<ListResult<Bot>> {
      const limit = Math.min(opts.limit ?? 20, 100);
      const where: WhereClause[] = [];
      if (opts.status) {
        where.push({ field: 'status', operator: 'eq', value: opts.status });
      }
      if (opts.platform) {
        where.push({ field: 'platform', operator: 'eq', value: opts.platform });
      }

      const items = await adapter.findMany<Bot>({
        model: 'bots',
        where: withNamespace(namespace, where),
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
      });

      let startIndex = 0;
      if (opts.cursor) {
        const cursorIndex = items.findIndex((item: Bot) => item.id === opts.cursor);
        if (cursorIndex >= 0) {
          startIndex = cursorIndex + 1;
        }
      }

      const page = items.slice(startIndex, startIndex + limit);
      return {
        items: page,
        nextCursor: startIndex + limit < items.length ? page.at(-1)?.id : undefined,
      };
    },

    async updateBot(
      id: string,
      namespace: string,
      updates: Partial<Pick<Bot, 'status' | 'errorMessage' | 'updatedAt'>>,
    ): Promise<Bot | null> {
      try {
        return await adapter.update<Bot>({
          model: 'bots',
          where: withNamespace(namespace, [
            { field: 'id', operator: 'eq', value: id },
          ]),
          data: {
            ...updates,
            updatedAt: updates.updatedAt ?? new Date().toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof NotFoundError) {
          return null;
        }
        throw error;
      }
    },

    async deleteBot(id: string, namespace: string): Promise<boolean> {
      if (!adapter.capabilities.transactions.supported) {
        throw new Error('Deleting a bot aggregate requires database transactions');
      }
      return adapter.transaction(async transaction => {
        const bot = await transaction.findOne<Bot>({
          model: 'bots',
          where: withNamespace(namespace, [{ field: 'id', operator: 'eq', value: id }]),
        });
        if (!bot) {
          return false;
        }

        const recordings = await transaction.findMany<Recording>({
          model: 'recordings',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: id },
          ]),
        });

        for (const recording of recordings) {
          await transaction.deleteMany({
            model: 'transcripts',
            where: withNamespace(namespace, [
              { field: 'recordingId', operator: 'eq', value: recording.id },
            ]),
          });
        }

        await transaction.deleteMany({
          model: 'participants',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: id },
          ]),
        });
        await transaction.deleteMany({
          model: 'chatMessages',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: id },
          ]),
        });
        await transaction.deleteMany({
          model: 'meetingMetadata',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: id },
          ]),
        });
        await transaction.deleteMany({
          model: 'calendarEventBots',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: id },
          ]),
        });
        await transaction.deleteMany({
          model: 'recordings',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: id },
          ]),
        });
        await transaction.delete({
          model: 'bots',
          where: withNamespace(namespace, [
            { field: 'id', operator: 'eq', value: id },
          ]),
        });
        return true;
      });
    },

    async createRecording(recording: Recording, namespace: string): Promise<Recording> {
      const stored = await adapter.create<Recording & { namespace: string }>({
        model: 'recordings',
        data: { ...recording, namespace },
      });
      return stripNamespace(stored);
    },

    async getRecordings(botId: string, namespace: string): Promise<Recording[]> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        return [];
      }
      const recordings = await adapter.findMany<Recording & { namespace: string }>({
        model: 'recordings',
        where: withNamespace(namespace, [
          { field: 'botId', operator: 'eq', value: botId },
        ]),
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
      });
      return recordings.map(stripNamespace);
    },

    async getRecording(
      id: string,
      namespace: string,
    ): Promise<(Recording & { namespace?: string }) | null> {
      const recording = await findOptional<Recording & { namespace: string }>(
        adapter,
        'recordings',
        namespace,
        [{ field: 'id', operator: 'eq', value: id }],
      );
      return recording ? stripNamespace(recording) : null;
    },

    async createTranscript(transcript: Transcript, namespace: string): Promise<Transcript> {
      const stored = await adapter.create<Transcript & { namespace: string }>({
        model: 'transcripts',
        data: { ...transcript, namespace },
      });
      return stripNamespace(stored);
    },

    async updateTranscript(
      id: string,
      namespace: string,
      updates: Partial<Pick<Transcript, 'status' | 'segments'>>,
    ): Promise<Transcript | null> {
      try {
        const transcript = await adapter.update<Transcript & { namespace: string }>({
          model: 'transcripts',
          where: withNamespace(namespace, [
            { field: 'id', operator: 'eq', value: id },
          ]),
          data: updates,
        });
        return stripNamespace(transcript);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return null;
        }
        throw error;
      }
    },

    async getTranscript(recordingId: string, namespace: string): Promise<Transcript | null> {
      const transcript = await findOptional<Transcript & { namespace: string }>(
        adapter,
        'transcripts',
        namespace,
        [{ field: 'recordingId', operator: 'eq', value: recordingId }],
      );
      return transcript ? stripNamespace(transcript) : null;
    },

    async getParticipants(botId: string, namespace: string): Promise<Participant[]> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        return [];
      }
      const participants = await adapter.findMany<StoredParticipant>({
        model: 'participants',
        where: withNamespace(namespace, [
          { field: 'botId', operator: 'eq', value: botId },
        ]),
        orderBy: [{ field: 'joinedAt', direction: 'asc' }],
      });
      return participants.map(mapParticipant);
    },

    async addParticipant(
      botId: string,
      participant: Participant,
      namespace: string,
    ): Promise<Participant> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        throw new Error('Bot not found or namespace mismatch');
      }

      const recordId = `${namespace}:${botId}:${participant.id}`;
      await adapter.upsert({
        model: 'participants',
        conflictTarget: 'id',
        where: withNamespace(namespace, [
          { field: 'id', operator: 'eq', value: recordId },
        ]),
        create: {
          id: recordId,
          namespace,
          participantId: participant.id,
          botId,
          name: participant.name,
          email: participant.email,
          role: participant.role,
          joinedAt: participant.joinedAt,
          leftAt: participant.leftAt,
          consent: participant.consent,
        },
        update: {
          participantId: participant.id,
          name: participant.name,
          email: participant.email,
          role: participant.role,
          joinedAt: participant.joinedAt,
          leftAt: participant.leftAt,
          consent: participant.consent,
        },
      });
      return participant;
    },

    async updateParticipant(
      botId: string,
      participantId: string,
      namespace: string,
      updates: Partial<Pick<Participant, 'leftAt' | 'consent'>>,
    ): Promise<Participant | null> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        return null;
      }

      try {
        const updated = await adapter.update<StoredParticipant>({
          model: 'participants',
          where: withNamespace(namespace, [
            { field: 'botId', operator: 'eq', value: botId },
            { field: 'participantId', operator: 'eq', value: participantId },
          ]),
          data: updates,
        });
        return mapParticipant(updated);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return null;
        }
        throw error;
      }
    },

    async getChatMessages(botId: string, namespace: string): Promise<ChatMessage[]> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        return [];
      }
      const messages = await adapter.findMany<StoredChatMessage>({
        model: 'chatMessages',
        where: withNamespace(namespace, [
          { field: 'botId', operator: 'eq', value: botId },
        ]),
        orderBy: [{ field: 'timestamp', direction: 'asc' }],
      });
      return messages.map((message: StoredChatMessage) => ({
        participantId: message.participantId,
        text: message.text,
        timestamp: message.timestamp,
      }));
    },

    async addChatMessage(
      botId: string,
      message: ChatMessage,
      namespace: string,
    ): Promise<ChatMessage> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        throw new Error('Bot not found or namespace mismatch');
      }

      await adapter.create<StoredChatMessage>({
        model: 'chatMessages',
        data: {
          id: generateId('chat'),
          namespace,
          botId,
          participantId: message.participantId,
          text: message.text,
          timestamp: message.timestamp,
        },
      });

      return {
        participantId: message.participantId,
        text: message.text,
        timestamp: message.timestamp,
      };
    },

    async getMetadata(botId: string, namespace: string): Promise<MeetingMetadata | null> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        return null;
      }
      const metadata = await findOptional<StoredMetadata>(
        adapter,
        'meetingMetadata',
        namespace,
        [{ field: 'botId', operator: 'eq', value: botId }],
      );
      return metadata ? mapMetadata(metadata) : null;
    },

    async upsertMetadata(
      botId: string,
      metadata: MeetingMetadata,
      namespace: string,
    ): Promise<MeetingMetadata> {
      const bot = await this.getBot(botId, namespace);
      if (!bot) {
        throw new Error('Bot not found or namespace mismatch');
      }

      const recordId = metadata.id || `meta_${botId}`;
      const stored = await adapter.upsert<StoredMetadata>({
        model: 'meetingMetadata',
        conflictTarget: ['namespace', 'botId'],
        where: withNamespace(namespace, [
          { field: 'botId', operator: 'eq', value: botId },
        ]),
        create: {
          id: recordId,
          namespace,
          botId,
          title: metadata.title,
          startTime: metadata.startTime,
          endTime: metadata.endTime,
          platform: metadata.platform || bot.platform,
          chatMessages: metadata.chatMessages,
        },
        update: {
          id: recordId,
          botId,
          title: metadata.title,
          startTime: metadata.startTime,
          endTime: metadata.endTime,
          platform: metadata.platform || bot.platform,
          chatMessages: metadata.chatMessages,
        },
      });

      return mapMetadata(stored);
    },

    async createWebhook(
      webhook: Omit<Webhook, 'id' | 'createdAt'>,
      namespace: string,
    ): Promise<Webhook> {
      const stored = await adapter.create<Webhook & { namespace: string }>({
        model: 'webhooks',
        data: {
          ...webhook,
          id: generateId('wh'),
          createdAt: new Date().toISOString(),
          namespace,
        },
      });
      return stripNamespace(stored);
    },

    async listWebhooks(namespace: string): Promise<Webhook[]> {
      const webhooks = await adapter.findMany<Webhook & { namespace: string }>({
        model: 'webhooks',
        where: withNamespace(namespace),
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
      });
      return webhooks.map(stripNamespace);
    },

    async getWebhook(id: string, namespace: string): Promise<Webhook | null> {
      const webhook = await findOptional<Webhook & { namespace: string }>(
        adapter,
        'webhooks',
        namespace,
        [{ field: 'id', operator: 'eq', value: id }],
      );
      return webhook ? stripNamespace(webhook) : null;
    },

    async deleteWebhook(id: string, namespace: string): Promise<boolean> {
      const webhook = await this.getWebhook(id, namespace);
      if (!webhook) {
        return false;
      }
      await adapter.delete({
        model: 'webhooks',
        where: withNamespace(namespace, [
          { field: 'id', operator: 'eq', value: id },
        ]),
      });
      return true;
    },

    async createCalendar(
      calendar: Omit<Calendar, 'id' | 'createdAt'>,
      namespace: string,
    ): Promise<Calendar> {
      const stored = await adapter.create<Calendar & { namespace: string }>({
        model: 'calendars',
        data: {
          ...calendar,
          id: generateId('cal'),
          createdAt: new Date().toISOString(),
          namespace,
        },
      });
      return stripNamespace(stored);
    },

    async listCalendars(namespace: string): Promise<Calendar[]> {
      const calendars = await adapter.findMany<Calendar & { namespace: string }>({
        model: 'calendars',
        where: withNamespace(namespace),
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
      });
      return calendars.map(stripNamespace);
    },

    async getCalendar(id: string, namespace: string): Promise<Calendar | null> {
      const calendar = await findOptional<Calendar & { namespace: string }>(
        adapter,
        'calendars',
        namespace,
        [{ field: 'id', operator: 'eq', value: id }],
      );
      return calendar ? stripNamespace(calendar) : null;
    },

    async deleteCalendar(id: string, namespace: string): Promise<boolean> {
      const calendar = await this.getCalendar(id, namespace);
      if (!calendar) {
        return false;
      }
      await adapter.deleteMany({
        model: 'calendarEventBots',
        where: withNamespace(namespace, [
          { field: 'calendarId', operator: 'eq', value: id },
        ]),
      });
      await adapter.delete({
        model: 'calendars',
        where: withNamespace(namespace, [
          { field: 'id', operator: 'eq', value: id },
        ]),
      });
      return true;
    },

    async setEventBotId(
      calendarId: string,
      eventId: string,
      botId: string,
      namespace: string,
    ): Promise<void> {
      const recordId = `${namespace}:${calendarId}:${eventId}`;
      await adapter.upsert({
        model: 'calendarEventBots',
        conflictTarget: 'id',
        where: withNamespace(namespace, [
          { field: 'id', operator: 'eq', value: recordId },
        ]),
        create: {
          id: recordId,
          namespace,
          calendarId,
          eventId,
          botId,
        },
        update: { botId },
      });
    },

    async getEventBotIds(
      calendarId: string,
      eventIds: string[],
      namespace: string,
    ): Promise<Map<string, string>> {
      if (eventIds.length === 0) {
        return new Map();
      }
      const rows = await adapter.findMany<StoredCalendarEventBot>({
        model: 'calendarEventBots',
        where: withNamespace(namespace, [
          { field: 'calendarId', operator: 'eq', value: calendarId },
          { field: 'eventId', operator: 'in', value: eventIds },
        ]),
      });
      return new Map(rows.map((row: StoredCalendarEventBot) => [row.eventId, row.botId]));
    },
  };
}
