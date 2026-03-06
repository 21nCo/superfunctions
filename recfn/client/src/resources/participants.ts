import type { Participant } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export function createParticipantsResource(client: RecFnHttpClient) {
  return {
    async list(botId: string): Promise<ApiResult<{ participants: Participant[] }>> {
      return client.request('GET', `/api/v1/bots/${botId}/participants`);
    },
  };
}
