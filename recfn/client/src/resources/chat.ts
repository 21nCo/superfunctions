import type { ChatMessage } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export function createChatResource(client: RecFnHttpClient) {
  return {
    async list(botId: string): Promise<ApiResult<{ messages: ChatMessage[] }>> {
      return client.request('GET', `/api/v1/bots/${botId}/chat`);
    },
  };
}
