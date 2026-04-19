import type { Adapter } from '@superfunctions/db';
import { sendfn } from '../src';

const database = {} as Adapter;

export async function main() {
  const client = sendfn({
    database,
    enableApi: true,
    apiConfig: {
      adminKey: process.env.SENDFN_ADMIN_KEY ?? 'top-secret',
    },
  });

  const webhookHandler = client.getWebhookHandlers().awsSes;
  const events = await client.queryEvents({
    provider: 'aws-ses',
    limit: 20,
  });

  return {
    router: client.router,
    webhookHandler,
    events,
  };
}
