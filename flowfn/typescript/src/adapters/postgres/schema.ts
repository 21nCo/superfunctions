import { pgTable, varchar, text, jsonb, integer, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const jobs = pgTable('flowfn_jobs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  queue: varchar('queue', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  data: jsonb('data').notNull(),
  opts: jsonb('opts'),
  
  state: varchar('state', { length: 50 }).notNull(), // waiting, active, completed, failed, delayed, paused
  priority: integer('priority').default(0),
  progress: integer('progress').default(0),
  returnValue: jsonb('return_value'),
  
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  processedOn: bigint('processed_on', { mode: 'number' }),
  finishedOn: bigint('finished_on', { mode: 'number' }),
  delay: bigint('delay', { mode: 'number' }).default(0),
  
  attemptsMade: integer('attempts_made').default(0),
  failedReason: text('failed_reason'),
  stacktrace: jsonb('stacktrace'),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  queueStateIdx: index('idx_queue_state').on(table.queue, table.state),
  queuePriorityIdx: index('idx_queue_priority').on(table.queue, table.priority),
  timestampIdx: index('idx_timestamp').on(table.timestamp),
}));

export const messages = pgTable('flowfn_messages', {
  id: varchar('id', { length: 255 }).primaryKey(),
  stream: varchar('stream', { length: 255 }).notNull(),
  data: jsonb('data').notNull(),
  headers: jsonb('headers'),
  
  partition: integer('partition'),
  offset: bigint('offset', { mode: 'number' }),
  key: varchar('key', { length: 255 }),
  
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  streamTimestampIdx: index('idx_stream_timestamp').on(table.stream, table.timestamp),
}));

export const consumerGroups = pgTable('flowfn_consumer_groups', {
  id: varchar('id', { length: 255 }).primaryKey(),
  stream: varchar('stream', { length: 255 }).notNull(),
  groupId: varchar('group_id', { length: 255 }).notNull(),
  consumerId: varchar('consumer_id', { length: 255 }).notNull(),
  
  lastMessageId: varchar('last_message_id', { length: 255 }),
  lastOffset: bigint('last_offset', { mode: 'number' }),
  lag: integer('lag'),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  streamGroupConsumerIdx: uniqueIndex('idx_stream_group_consumer').on(table.stream, table.groupId, table.consumerId),
}));

export const workflows = pgTable('flowfn_workflows', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  definition: jsonb('definition').notNull(),
  version: integer('version').default(1),
  
  status: varchar('status', { length: 50 }).notNull(),
  metadata: jsonb('metadata'),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const workflowExecutions = pgTable('flowfn_workflow_executions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  workflowId: varchar('workflow_id', { length: 255 }).notNull(),
  workflowName: varchar('workflow_name', { length: 255 }),
  
  status: varchar('status', { length: 50 }).notNull(),
  input: jsonb('input'),
  state: jsonb('state'),
  output: jsonb('output'),
  error: text('error'),
  
  currentStep: varchar('current_step', { length: 255 }),
  completedSteps: jsonb('completed_steps'),
  
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  completedAt: bigint('completed_at', { mode: 'number' }),
  durationMs: integer('duration_ms'),
}, (table) => ({
  workflowIdx: index('idx_workflow').on(table.workflowId),
  statusIdx: index('idx_status').on(table.status),
}));

export const workflowEvents = pgTable('flowfn_workflow_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  executionId: varchar('execution_id', { length: 255 }).notNull(),
  
  type: varchar('type', { length: 50 }).notNull(),
  step: varchar('step', { length: 255 }),
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  data: jsonb('data'),
}, (table) => ({
  executionIdx: index('idx_execution').on(table.executionId),
}));
