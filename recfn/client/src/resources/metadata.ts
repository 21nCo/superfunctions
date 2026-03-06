import type { MeetingMetadata } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export function createMetadataResource(client: RecFnHttpClient) {
  return {
    async get(botId: string): Promise<ApiResult<MeetingMetadata>> {
      return client.request('GET', `/api/v1/bots/${botId}/metadata`);
    },
  };
}
