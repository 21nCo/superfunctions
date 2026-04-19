import { SendfnDatabaseAdapter } from '../database/adapter';
import { RegisterDeviceParams, DeviceToken, Platform } from '../types';
import { ValidationError } from '../errors';

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

  async refreshDeviceToken(
    oldToken: string,
    newToken: string,
    userId: string,
    platform: Platform
  ): Promise<DeviceToken> {
    const existingDevices = await this.adapter.findDeviceTokens({
      userId,
      platform,
      isActive: true,
    });
    const existing = existingDevices.find((device) => device.token === oldToken);

    if (!existing) {
      throw new ValidationError('Old device token was not found for the supplied user and platform');
    }

    await this.deactivateTokens([oldToken]);
    return this.registerDevice({
      userId,
      token: newToken,
      platform,
      appVersion: existing.appVersion ?? undefined,
      deviceInfo: existing.deviceInfo ?? undefined,
    });
  }

  async cleanupInactiveDevices(olderThan: Date): Promise<number> {
    const inactiveDevices = await this.adapter.findDeviceTokens({
      isActive: false,
      olderThan
    });

    for (const device of inactiveDevices) {
      await this.adapter.deleteDeviceToken(device.id);
    }

    return inactiveDevices.length;
  }

  // Not in spec specifically but useful
  async deleteToken(id: string): Promise<void> {
      await this.adapter.deleteDeviceToken(id);
  }
}
