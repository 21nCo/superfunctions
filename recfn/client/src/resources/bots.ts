import type { Bot, BotConfig, Platform } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export interface CreateBotInput {
  meetingUrl: string;
  platform?: Platform;
  config?: Partial<BotConfig>;
}

export interface ListBotsOptions {
  limit?: number;
  cursor?: string;
  status?: Bot['status'];
  platform?: Platform;
}

export interface ListBotsResult {
  bots: Bot[];
  nextCursor?: string | null;
}

export function createBotsResource(client: RecFnHttpClient) {
  return {
    async create(input: CreateBotInput): Promise<ApiResult<Bot>> {
      return client.request<Bot>('POST', '/api/v1/bots', {
        body: {
          meetingUrl: input.meetingUrl,
          platform: input.platform,
          config: input.config,
        },
      });
    },

    async get(botId: string): Promise<ApiResult<Bot>> {
      return client.request<Bot>('GET', `/api/v1/bots/${botId}`);
    },

    async list(opts: ListBotsOptions = {}): Promise<ApiResult<ListBotsResult>> {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (opts.status) params.set('status', opts.status);
      if (opts.platform) params.set('platform', opts.platform);
      const qs = params.toString();
      const path = qs ? `/api/v1/bots?${qs}` : '/api/v1/bots';
      return client.request<ListBotsResult>('GET', path);
    },

    async leave(botId: string): Promise<ApiResult<{ botId: string; status: string }>> {
      return client.request('POST', `/api/v1/bots/${botId}/leave`);
    },

    async delete(botId: string): Promise<ApiResult<{ botId: string; deleted: boolean }>> {
      return client.request('DELETE', `/api/v1/bots/${botId}`);
    },
  };
}
