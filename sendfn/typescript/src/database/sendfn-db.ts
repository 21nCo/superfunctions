import { Adapter } from '@superfunctions/db';
import { v4 as uuidv4 } from 'uuid';
import {
  EmailTransaction,
  CreateEmailTransaction,
  SmsTransaction,
  CreateSmsTransaction,
  PushNotification,
  CreatePushNotification,
  DeviceToken,
  CreateDeviceToken,
  SuppressionList,
  CreateSuppression,
  CommunicationEvent,
  CreateEvent,
  Platform
} from '../types';

export interface FindEmailParams {
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface FindSmsParams {
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface FindPushParams {
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface FindSuppressionParams {
  reason?: string;
  limit?: number;
  offset?: number;
}

export interface FindEventParams {
  referenceId?: string;
  referenceType?: 'email' | 'push' | 'sms';
  eventType?: string;
  limit?: number;
  offset?: number;
}

export class SendfnDb {
  constructor(private adapter: Adapter) {}

  // --- Email Transactions ---

  async createEmailTransaction(data: CreateEmailTransaction): Promise<EmailTransaction> {
    return this.adapter.create<EmailTransaction>({
      model: 'email_transactions',
      data: {
        ...data,
        id: uuidv4(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    });
  }

  async updateEmailTransaction(id: string, data: Partial<EmailTransaction>): Promise<EmailTransaction> {
    return this.adapter.update<EmailTransaction>({
      model: 'email_transactions',
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: {
        ...data,
        updatedAt: new Date(),
      }
    });
  }

  async getEmailTransaction(id: string): Promise<EmailTransaction | null> {
    return this.adapter.findOne<EmailTransaction>({
      model: 'email_transactions',
      where: [{ field: 'id', operator: 'eq', value: id }]
    });
  }

  async findEmailTransactions(params: FindEmailParams): Promise<EmailTransaction[]> {
    const where: any[] = [];
    if (params.userId) where.push({ field: 'userId', operator: 'eq', value: params.userId });
    if (params.status) where.push({ field: 'status', operator: 'eq', value: params.status });

    return this.adapter.findMany<EmailTransaction>({
      model: 'email_transactions',
      where,
      limit: params.limit,
      offset: params.offset,
      orderBy: [{ field: 'createdAt', direction: 'desc' }]
    });
  }

  // --- SMS Transactions ---

  async createSmsTransaction(data: CreateSmsTransaction): Promise<SmsTransaction> {
    return this.adapter.create<SmsTransaction>({
      model: 'sms_transactions',
      data: {
        ...data,
        id: uuidv4(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    });
  }

  async updateSmsTransaction(id: string, data: Partial<SmsTransaction>): Promise<SmsTransaction> {
    return this.adapter.update<SmsTransaction>({
      model: 'sms_transactions',
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: {
        ...data,
        updatedAt: new Date(),
      }
    });
  }

  async getSmsTransaction(id: string): Promise<SmsTransaction | null> {
    return this.adapter.findOne<SmsTransaction>({
      model: 'sms_transactions',
      where: [{ field: 'id', operator: 'eq', value: id }]
    });
  }

  async findSmsTransactions(params: FindSmsParams): Promise<SmsTransaction[]> {
    const where: any[] = [];
    if (params.userId) where.push({ field: 'userId', operator: 'eq', value: params.userId });
    if (params.status) where.push({ field: 'status', operator: 'eq', value: params.status });

    return this.adapter.findMany<SmsTransaction>({
      model: 'sms_transactions',
      where,
      limit: params.limit,
      offset: params.offset,
      orderBy: [{ field: 'createdAt', direction: 'desc' }]
    });
  }

  // --- Push Notifications ---

  async createPushNotification(data: CreatePushNotification): Promise<PushNotification> {
    return this.adapter.create<PushNotification>({
      model: 'push_notifications',
      data: {
        ...data,
        id: uuidv4(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    });
  }

  async updatePushNotification(id: string, data: Partial<PushNotification>): Promise<PushNotification> {
    return this.adapter.update<PushNotification>({
      model: 'push_notifications',
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: {
        ...data,
        updatedAt: new Date(),
      }
    });
  }

  async getPushNotification(id: string): Promise<PushNotification | null> {
    return this.adapter.findOne<PushNotification>({
      model: 'push_notifications',
      where: [{ field: 'id', operator: 'eq', value: id }]
    });
  }

  async findPushNotifications(params: FindPushParams): Promise<PushNotification[]> {
    const where: any[] = [];
    if (params.userId) where.push({ field: 'userId', operator: 'eq', value: params.userId });
    if (params.status) where.push({ field: 'status', operator: 'eq', value: params.status });

    return this.adapter.findMany<PushNotification>({
      model: 'push_notifications',
      where,
      limit: params.limit,
      offset: params.offset,
      orderBy: [{ field: 'createdAt', direction: 'desc' }]
    });
  }

  // --- Device Tokens ---

  async upsertDeviceToken(data: CreateDeviceToken): Promise<DeviceToken> {
    // Check if exists
    const existing = await this.adapter.findOne<DeviceToken>({
      model: 'device_tokens',
      where: [
        { field: 'userId', operator: 'eq', value: data.userId },
        { field: 'token', operator: 'eq', value: data.token },
        { field: 'platform', operator: 'eq', value: data.platform }
      ]
    });

    if (existing) {
      return this.adapter.update<DeviceToken>({
        model: 'device_tokens',
        where: [{ field: 'id', operator: 'eq', value: existing.id }],
        data: {
          ...data,
          isActive: true,
          updatedAt: new Date()
        }
      });
    }

    return this.adapter.create<DeviceToken>({
      model: 'device_tokens',
      data: {
        ...data,
        id: uuidv4(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    });
  }

  async getDeviceTokensByUser(userId: string, platform?: Platform): Promise<DeviceToken[]> {
    const where: any[] = [
      { field: 'userId', operator: 'eq', value: userId },
      { field: 'isActive', operator: 'eq', value: true }
    ];
    
    if (platform) {
      where.push({ field: 'platform', operator: 'eq', value: platform });
    }

    return this.adapter.findMany<DeviceToken>({
      model: 'device_tokens',
      where
    });
  }

  async deactivateDeviceToken(token: string): Promise<void> {
    // We need to find it first or update many
    const tokens = await this.adapter.findMany<DeviceToken>({
        model: 'device_tokens',
        where: [{ field: 'token', operator: 'eq', value: token }]
    });

    for (const t of tokens) {
        await this.adapter.update({
            model: 'device_tokens',
            where: [{ field: 'id', operator: 'eq', value: t.id }],
            data: { isActive: false, updatedAt: new Date() }
        });
    }
  }

  async deleteDeviceToken(id: string): Promise<void> {
    await this.adapter.delete({
      model: 'device_tokens',
      where: [{ field: 'id', operator: 'eq', value: id }]
    });
  }

  // --- Suppression List ---

  async addToSuppressionList(data: CreateSuppression): Promise<SuppressionList> {
    const existing = await this.adapter.findOne<SuppressionList>({
        model: 'suppression_list',
        where: [{ field: 'email', operator: 'eq', value: data.email }]
    });

    if (existing) return existing;

    return this.adapter.create<SuppressionList>({
      model: 'suppression_list',
      data: {
        ...data,
        id: uuidv4(),
        createdAt: new Date(),
      }
    });
  }

  async isEmailSuppressed(email: string): Promise<boolean> {
    const entry = await this.getSuppressionListEntry(email);
    return !!entry;
  }

  async getSuppressionListEntry(email: string): Promise<SuppressionList | null> {
    return this.adapter.findOne<SuppressionList>({
      model: 'suppression_list',
      where: [{ field: 'email', operator: 'eq', value: email }]
    });
  }

  async removeFromSuppressionList(email: string): Promise<void> {
    const entry = await this.getSuppressionListEntry(email);
    if (entry) {
        await this.adapter.delete({
            model: 'suppression_list',
            where: [{ field: 'id', operator: 'eq', value: entry.id }]
        });
    }
  }

  async findSuppressionList(params: FindSuppressionParams): Promise<SuppressionList[]> {
    const where: any[] = [];
    if (params.reason) where.push({ field: 'reason', operator: 'eq', value: params.reason });

    return this.adapter.findMany<SuppressionList>({
      model: 'suppression_list',
      where,
      limit: params.limit,
      offset: params.offset
    });
  }

  // --- Events ---

  async recordEvent(data: CreateEvent): Promise<CommunicationEvent> {
    return this.adapter.create<CommunicationEvent>({
      model: 'communication_events',
      data: {
        ...data,
        id: uuidv4(),
        createdAt: new Date(),
      }
    });
  }

  async getEventsByReference(referenceId: string, referenceType: 'email' | 'push' | 'sms'): Promise<CommunicationEvent[]> {
    return this.adapter.findMany<CommunicationEvent>({
      model: 'communication_events',
      where: [
        { field: 'referenceId', operator: 'eq', value: referenceId },
        { field: 'referenceType', operator: 'eq', value: referenceType }
      ],
      orderBy: [{ field: 'eventTimestamp', direction: 'asc' }]
    });
  }

  async findEvents(params: FindEventParams): Promise<CommunicationEvent[]> {
    const where: any[] = [];
    if (params.referenceId) where.push({ field: 'referenceId', operator: 'eq', value: params.referenceId });
    if (params.referenceType) where.push({ field: 'referenceType', operator: 'eq', value: params.referenceType });
    if (params.eventType) where.push({ field: 'eventType', operator: 'eq', value: params.eventType });

    return this.adapter.findMany<CommunicationEvent>({
      model: 'communication_events',
      where,
      limit: params.limit,
      offset: params.offset
    });
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}