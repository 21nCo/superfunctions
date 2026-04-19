import type { Adapter } from '@superfunctions/db';
import { sendfn } from '../src';

const database = {} as Adapter;

export async function main() {
  const client = sendfn({
    database,
    push: {
      providers: {
        fcm: {
          serviceAccountKey: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '{}',
        },
      },
    },
  });

  await client.registerDevice({
    userId: 'user-123',
    token: 'fcm-device-token',
    platform: 'android',
    appVersion: '1.0.0',
  });

  const notification = await client.push({
    userId: 'user-123',
    title: 'Alert',
    body: 'Something happened.',
    data: {
      screen: 'inbox',
    },
  });

  const devices = await client.getDevices('user-123');
  return { notification, devices };
}
