import * as admin from 'firebase-admin';
import { PushProvider, PushProviderCapabilities, SendPushRequest, SendPushResponse } from './provider';
import { FcmConfig } from '../types';
import { PushProviderError } from '../errors';

export class FcmProvider implements PushProvider {
  readonly name = 'fcm';
  readonly platform = 'android'; // Also supports web, but spec says Android primarily for FCM
  readonly capabilities: PushProviderCapabilities = {
    maxPayloadSize: 4096,
    supportsBatching: true, // Multicast
    supportsScheduling: false,
    supportsImages: true,
    supportsSilentPush: true,
  };

  private app: admin.app.App;

  constructor(private config: FcmConfig) {
    // Prevent multiple initializations
    if (admin.apps.length > 0) {
        this.app = admin.apps[0]!;
    } else {
        this.app = admin.initializeApp({
            credential: admin.credential.cert(config.serviceAccountKey as admin.ServiceAccount),
            projectId: config.projectId,
        });
    }
  }

  async initialize(): Promise<void> {
    // Initialized in constructor
  }

  async sendPush(params: SendPushRequest): Promise<SendPushResponse> {
    // FCM Multicast
    const message: admin.messaging.MulticastMessage = {
      tokens: params.deviceTokens,
      notification: {
        title: params.title,
        body: params.body,
        imageUrl: params.imageUrl,
      },
      data: params.data as { [key: string]: string },
      android: {
        priority: params.priority === 'high' ? 'high' : 'normal',
        ttl: params.ttl ? params.ttl * 1000 : undefined, // ms
        collapseKey: params.collapseKey,
        notification: {
            sound: params.sound || 'default',
        }
      },
      // Also add webpush config if needed
    };

    try {
      const response = await this.app.messaging().sendEachForMulticast(message);
      
      const invalidTokens: string[] = [];
      const results = response.responses.map((res, idx) => {
        if (!res.success) {
            if (res.error?.code === 'messaging/registration-token-not-registered' || 
                res.error?.code === 'messaging/invalid-registration-token') {
                invalidTokens.push(params.deviceTokens[idx]);
            }
        }
        return {
            token: params.deviceTokens[idx],
            success: res.success,
            error: res.error?.message
        };
      });

      return {
        success: response.failureCount === 0, // Partial success is still success-ish, but overall... let's say true if at least one worked? 
        // Actually typical pattern is if method didn't throw, it "succeeded" to execute.
        successCount: response.successCount,
        failedCount: response.failureCount,
        invalidTokens,
        results,
        timestamp: new Date(),
      };

    } catch (error: any) {
        throw new PushProviderError(`FCM Error: ${error.message}`);
    }
  }

  async sendBulkPush(params: SendPushRequest[]): Promise<SendPushResponse[]> {
      // Just iterate for now
      const results: SendPushResponse[] = [];
      for (const req of params) {
          results.push(await this.sendPush(req));
      }
      return results;
  }

  validateToken(token: string): boolean {
    return !!token; // Basic check
  }

  async isHealthy(): Promise<boolean> {
    return true; // Hard to check without sending
  }

  async close(): Promise<void> {
    await this.app.delete();
  }
}
