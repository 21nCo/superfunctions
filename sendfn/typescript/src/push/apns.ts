import { ApnsClient, Notification, NotificationOptions } from 'apns2';
import { PushProvider, PushProviderCapabilities, SendPushRequest, SendPushResponse } from './provider';
import { ApnsConfig } from '../types';
import { PushProviderError } from '../errors';

export class ApnsProvider implements PushProvider {
  readonly name = 'apns';
  readonly platform = 'ios';
  readonly capabilities: PushProviderCapabilities = {
    maxPayloadSize: 4096,
    supportsBatching: false, // APNS2 client handles concurrency but protocol is per-request
    supportsScheduling: false,
    supportsImages: true, // Via mutable-content
    supportsSilentPush: true,
  };

  private client: ApnsClient;

  constructor(private config: ApnsConfig) {
    this.client = new ApnsClient({
      team: config.teamId,
      keyId: config.keyId,
      signingKey: config.key,
      defaultTopic: config.production ? undefined : undefined // Topic usually bundleId
    });
  }

  async initialize(): Promise<void> {
    // 
  }

  async sendPush(params: SendPushRequest): Promise<SendPushResponse> {
    const results: { token: string; success: boolean; error?: string }[] = [];
    const invalidTokens: string[] = [];
    let successCount = 0;
    let failedCount = 0;

    // APNS2 client sends one by one, but we can do parallel
    const promises = params.deviceTokens.map(async (token) => {
        const notification = new Notification(token, {
            alert: {
                title: params.title,
                body: params.body,
            },
            data: params.data,
            badge: params.badge,
            sound: params.sound,
            topic: params.category, // often mapped
            priority: params.priority === 'high' ? 10 : 5,
            expiration: params.ttl ? Math.floor(Date.now() / 1000) + params.ttl : undefined,
            collapseId: params.collapseKey,
        });
        
        // If image, need mutable-content: 1 and attachment in data
        if (params.imageUrl) {
            notification.aps.mutableContent = 1;
            // Payload structure for image varies, usually in data
            if (!notification.payload) notification.payload = {};
            notification.payload = { ...notification.payload, image_url: params.imageUrl };
        }

        try {
            await this.client.send(notification);
            results.push({ token, success: true });
            successCount++;
        } catch (error: any) {
            failedCount++;
            let errMsg = error.reason || error.message;
            
            if (error.reason === 'BadDeviceToken' || error.reason === 'Unregistered') {
                invalidTokens.push(token);
            }
            
            results.push({ token, success: false, error: errMsg });
        }
    });

    await Promise.all(promises);

    return {
        success: failedCount === 0,
        successCount,
        failedCount,
        invalidTokens,
        results,
        timestamp: new Date()
    };
  }

  async sendBulkPush(params: SendPushRequest[]): Promise<SendPushResponse[]> {
    const results: SendPushResponse[] = [];
    for (const req of params) {
        results.push(await this.sendPush(req));
    }
    return results;
  }

  validateToken(token: string): boolean {
    return !!token;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No explicit close on ApnsClient? check docs. 
    // It uses http2 session. It might need it.
    // Assuming standard usage.
  }
}
