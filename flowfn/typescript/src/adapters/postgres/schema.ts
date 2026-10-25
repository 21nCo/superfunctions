import { sql } from "drizzle-orm";
import {
  pgTable,
  type PgTableFn,
  pgSchema,
  text,
  jsonb,
  doublePrecision,
  bigint,
  bigserial,
  primaryKey,
  index,
  integer,
  check,
} from "drizzle-orm/pg-core";
/** Current adapter tables. Legacy tables require migrateLegacySchema(); intermediate queues require migrateQueueOrderingSchema(). */
export function getPostgresSchema(namespace?: string) {
  const table: PgTableFn<string | undefined> = namespace ? pgSchema(namespace).table : pgTable;
  const jobs = table(
    "flowfn_jobs",
    {
      queue: text("queue").notNull(),
      id: text("id").notNull(),
      name: text("name").notNull(),
      state: text("state").notNull(),
      priority: doublePrecision("priority").notNull().default(0),
      availableAt: bigint("available_at", { mode: "number" }).notNull(),
      enqueueOrder: bigserial("enqueue_order", { mode: "bigint" }).notNull().unique(),
      timestamp: bigint("timestamp", { mode: "number" }).notNull(),
      finishedOn: bigint("finished_on", { mode: "number" }),
      data: jsonb("data").notNull(),
    },
    (value) => ({
      pk: primaryKey({ columns: [value.queue, value.id] }),
      claimOrder: index("flowfn_jobs_claim_order").on(
        value.queue,
        value.priority.desc().nullsFirst(),
        sql`(CASE WHEN COALESCE((${value.data}->'opts'->>'lifo')::boolean,false) THEN 0 ELSE 1 END)`,
        sql`(CASE WHEN COALESCE((${value.data}->'opts'->>'lifo')::boolean,false) THEN ${value.enqueueOrder} END) DESC`,
        value.enqueueOrder.asc(),
      ).where(sql`${value.state} IN ('waiting','delayed')`),
      ready: index("flowfn_jobs_ready").on(
        value.queue,
        value.state,
        value.availableAt,
      ),
    }),
  );
  const streamPolicies = table('flowfn_stream_policies', {
    stream: text('stream').primaryKey(),
    partitions: integer('partitions'),
    routing: text('routing'),
  }, value => ({ positive: check('flowfn_stream_policies_partitions_check', sql`${value.partitions}>0`) }));
  const partitionProgress = table('flowfn_partition_progress', {
    stream: text('stream').notNull(),
    groupId: text('group_id').notNull(),
    partition: integer('partition').notNull(),
    lastOffset: bigint('last_offset', { mode: 'number' }).notNull(),
  }, value => ({ pk: primaryKey({ columns: [value.stream, value.groupId, value.partition] }) }));
  const partitionBarriers = table('flowfn_partition_barriers', {
    stream: text('stream').notNull(),
    groupId: text('group_id').notNull(),
    partition: integer('partition').notNull(),
    messageId: text('message_id').notNull(),
    receipt: text('receipt').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  }, value => ({ pk: primaryKey({ columns: [value.stream, value.groupId, value.partition] }) }));
  const messages = table(
    "flowfn_messages",
    {
      id: text("id").primaryKey(),
      stream: text("stream").notNull(),
      position: bigserial("position", { mode: "number" }).unique(),
      timestamp: bigint("timestamp", { mode: "number" }).notNull(),
      data: jsonb("data").notNull(),
    },
    (value) => ({
      streamPosition: index("flowfn_messages_stream_offset").on(
        value.stream,
        value.position,
      ),
    }),
  );
  const consumerGroups = table("flowfn_consumer_groups", {
    id: text("id").primaryKey(),
    stream: text("stream").notNull(),
    groupId: text("group_id").notNull(),
    lastOffset: bigint("last_offset", { mode: "number" }).notNull(),
  });
  const deliveries = table(
    "flowfn_deliveries",
    {
      stream: text("stream").notNull(),
      groupId: text("group_id").notNull(),
      messageId: text("message_id")
        .notNull()
        .references(() => messages.id, { onDelete: "cascade" }),
      consumerId: text("consumer_id").notNull(),
      receipt: text("receipt").notNull(),
      state: text("state").notNull(),
      deliveredAt: bigint("delivered_at", { mode: "number" }).notNull(),
    },
    (value) => ({
      pk: primaryKey({
        columns: [value.stream, value.groupId, value.messageId],
      }),
    }),
  );
  const workflowExecutions = table("flowfn_workflow_executions", {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    state: jsonb("state").notNull(),
  });
  return { jobs, messages, consumerGroups, deliveries, workflowExecutions, streamPolicies, partitionProgress, partitionBarriers };
}
export const {
  jobs,
  messages,
  consumerGroups,
  deliveries,
  workflowExecutions,
  streamPolicies,
  partitionProgress,
  partitionBarriers,
} = getPostgresSchema();
