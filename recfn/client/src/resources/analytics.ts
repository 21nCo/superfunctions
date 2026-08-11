import type { Analytics } from '@recfn/core';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export function createAnalyticsResource(client: RecFnHttpClient) {
  return {
    async get(recordingId: string): Promise<ApiResult<Analytics>> {
      return client.request('GET', `/api/v1/recordings/${recordingId}/analytics`);
    },
  };
}
