import type { Webhook } from '@recfn/core';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export interface CreateWebhookInput {
  url: string;
  events: string[];
  secret?: string;
}

export function createWebhooksResource(client: RecFnHttpClient) {
  return {
    async create(input: CreateWebhookInput): Promise<ApiResult<Webhook>> {
      return client.request('POST', '/api/v1/webhooks', {
        body: {
          url: input.url,
          events: input.events,
          secret: input.secret,
        },
      });
    },

    async list(): Promise<ApiResult<{ webhooks: Webhook[] }>> {
      return client.request('GET', '/api/v1/webhooks');
    },

    async delete(webhookId: string): Promise<ApiResult<{ webhookId: string; deleted: boolean }>> {
      return client.request('DELETE', `/api/v1/webhooks/${webhookId}`);
    },
  };
}
