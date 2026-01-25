import { SendfnDatabaseAdapter } from '../database/adapter';
import { RegisterDeviceParams, DeviceToken, Platform } from '../types';

export class DeviceTokenManager {
  constructor(private adapter: SendfnDatabaseAdapter) {}

  async registerDevice(params: RegisterDeviceParams): Promise<DeviceToken> {
    // Upsert device token
    // Assuming upsertDeviceToken in adapter handles uniqueness
    return await this.adapter.upsertDeviceToken({
        userId: params.userId,
        token: params.token,
        platform: params.platform,
        appVersion: params.appVersion || null,
        deviceInfo: params.deviceInfo || null,
        isActive: true,
        lastUsedAt: new Date()
    });
  }

  async getActiveDevices(userId: string, platform?: Platform): Promise<DeviceToken[]> {
    return this.adapter.getDeviceTokensByUser(userId, platform);
  }

  async deactivateTokens(tokens: string[]): Promise<void> {
    for (const token of tokens) {
        await this.adapter.deactivateDeviceToken(token);
    }
  }

  // Not in spec specifically but useful
  async deleteToken(id: string): Promise<void> {
      await this.adapter.deleteDeviceToken(id);
  }
}
