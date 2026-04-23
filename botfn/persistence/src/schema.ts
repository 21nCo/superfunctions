import { pgTable, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';

export const issues = pgTable('issues', {
  id: text('id').primaryKey(),
  githubIssueId: text('github_issue_id'),
  linearIssueId: text('linear_issue_id'),
  status: text('status').notNull(),
  isLiveStatusNotifiedOnDiscord: boolean('is_live_status_notified_on_discord').default(false),
  createdAt: integer('created_at').notNull(), // Unix timestamp
  updatedAt: integer('updated_at').notNull(),
});

export const discordThreads = pgTable('discord_threads', {
  id: text('id').primaryKey(),
  issueId: text('issue_id').notNull().references(() => issues.id),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  threadUrl: text('thread_url').notNull(),
  createdAt: integer('created_at').notNull(),
});