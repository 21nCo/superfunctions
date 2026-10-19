import type { TableSchema, TableSchemaMap } from '@superfunctions/db';

export const REC_FN_STORE_SCHEMA: TableSchemaMap = withIsoDateDefaults({
  bots: {
    modelName: 'bots',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      meetingUrl: { type: 'string', required: true },
      platform: { type: 'string', required: true },
      status: { type: 'string', required: true },
      config: { type: 'json', required: true },
      errorMessage: { type: 'string' },
      createdAt: { type: 'date', required: true },
      updatedAt: { type: 'date', required: true },
    },
    indexes: [
      { name: 'bots_namespace_created_at_idx', fields: ['namespace', 'createdAt'] },
      { name: 'bots_namespace_status_idx', fields: ['namespace', 'status'] },
    ],
  },
  recordings: {
    modelName: 'recordings',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      botId: { type: 'string', required: true },
      format: { type: 'string', required: true },
      duration: { type: 'number', required: true },
      storageRef: { type: 'string', required: true },
      size: { type: 'number', required: true },
      downloadUrl: { type: 'string' },
      createdAt: { type: 'date', required: true },
    },
    indexes: [
      { name: 'recordings_namespace_bot_idx', fields: ['namespace', 'botId'] },
    ],
  },
  transcripts: {
    modelName: 'transcripts',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      recordingId: { type: 'string', required: true },
      language: { type: 'string', required: true },
      status: { type: 'string', required: true },
      segments: { type: 'json', required: true },
      createdAt: { type: 'date', required: true },
    },
    indexes: [
      { name: 'transcripts_namespace_recording_idx', fields: ['namespace', 'recordingId'] },
    ],
  },
  participants: {
    modelName: 'participants',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      participantId: { type: 'string', required: true },
      botId: { type: 'string', required: true },
      name: { type: 'string', required: true },
      email: { type: 'string' },
      role: { type: 'string', required: true },
      joinedAt: { type: 'date', required: true },
      leftAt: { type: 'date' },
      consent: { type: 'string', required: true },
    },
    indexes: [
      { name: 'participants_namespace_bot_idx', fields: ['namespace', 'botId'] },
      { name: 'participants_namespace_participant_idx', fields: ['namespace', 'participantId'] },
    ],
  },
  chatMessages: {
    modelName: 'chatMessages',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      botId: { type: 'string', required: true },
      participantId: { type: 'string', required: true },
      text: { type: 'string', required: true },
      timestamp: { type: 'date', required: true },
    },
    indexes: [
      { name: 'chat_messages_namespace_bot_idx', fields: ['namespace', 'botId'] },
    ],
  },
  meetingMetadata: {
    modelName: 'meetingMetadata',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      botId: { type: 'string', required: true },
      title: { type: 'string' },
      startTime: { type: 'date' },
      endTime: { type: 'date' },
      platform: { type: 'string', required: true },
      chatMessages: { type: 'json', required: true },
    },
    indexes: [
      { name: 'meeting_metadata_namespace_bot_idx', fields: ['namespace', 'botId'], unique: true },
    ],
  },
  calendars: {
    modelName: 'calendars',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      provider: { type: 'string', required: true },
      autoSchedule: { type: 'boolean', required: true },
      createdAt: { type: 'date', required: true },
    },
    indexes: [
      { name: 'calendars_namespace_provider_idx', fields: ['namespace', 'provider'] },
    ],
  },
  webhooks: {
    modelName: 'webhooks',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      url: { type: 'string', required: true },
      events: { type: 'json', required: true },
      secret: { type: 'string' },
      createdAt: { type: 'date', required: true },
    },
    indexes: [
      { name: 'webhooks_namespace_created_at_idx', fields: ['namespace', 'createdAt'] },
    ],
  },
  calendarEventBots: {
    modelName: 'calendarEventBots',
    fields: {
      id: { type: 'string', required: true, unique: true },
      namespace: { type: 'string', required: true },
      calendarId: { type: 'string', required: true },
      eventId: { type: 'string', required: true },
      botId: { type: 'string', required: true },
    },
    indexes: [
      { name: 'calendar_event_bots_lookup_idx', fields: ['namespace', 'calendarId', 'eventId'] },
    ],
  },
});

function withIsoDateDefaults(schema: TableSchemaMap): TableSchemaMap {
  return Object.fromEntries(
    Object.entries(schema).map(([name, table]) => [name, normalizeTable(table)])
  );
}

function normalizeTable(table: TableSchema): TableSchema {
  return {
    ...table,
    fields: Object.fromEntries(
      Object.entries(table.fields).map(([name, field]) => [
        name,
        field.type === 'date' || field.type === 'datetime'
          ? {
              dateValueType: 'iso-string',
              dateStorageType: 'iso-text',
              ...field,
            }
          : field.type === 'json' ? { ...field, jsonStorageType: 'json-text' } : field,
      ])
    ),
  };
}

/** Application migration metadata; runtime wrapping is owned by createDbStore. */
export function getRecFnSchema(): TableSchemaMap {
  return structuredClone(REC_FN_STORE_SCHEMA);
}
