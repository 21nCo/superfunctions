import type { TableSchema } from '@superfunctions/db';

export const SENDFN_SCHEMA_VERSION = 1;

export interface SendfnSchemaOptions {
  namespace?: string;
}

export function getSchema(_options: SendfnSchemaOptions = {}): { version: number; schemas: TableSchema[] } {
  return {
    version: SENDFN_SCHEMA_VERSION,
    schemas: [
      {
        modelName: 'email_transactions',
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          to: { type: 'string', required: true, fieldName: 'to' },
          from: { type: 'string', required: true, fieldName: 'from' },
          subject: { type: 'string', required: true, fieldName: 'subject' },
          templateId: { type: 'string', required: false, fieldName: 'template_id' },
          templateData: { type: 'json', required: false, fieldName: 'template_data' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          providerMessageId: { type: 'string', required: false, fieldName: 'provider_message_id' },
          status: { type: 'string', required: true, fieldName: 'status' },
          sentAt: { type: 'date', required: false, fieldName: 'sent_at' },
          deliveredAt: { type: 'date', required: false, fieldName: 'delivered_at' },
          bouncedAt: { type: 'date', required: false, fieldName: 'bounced_at' },
          complainedAt: { type: 'date', required: false, fieldName: 'complained_at' },
          metadata: { type: 'json', required: true, fieldName: 'metadata' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_sendfn_email_transactions_user_id', fields: ['userId'] },
          { name: 'idx_sendfn_email_transactions_provider_message_id', fields: ['providerMessageId'] },
          { name: 'idx_sendfn_email_transactions_status', fields: ['status'] }
        ]
      },
      {
        modelName: 'sms_transactions',
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          to: { type: 'string', required: true, fieldName: 'to' },
          message: { type: 'string', required: true, fieldName: 'message' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          providerMessageId: { type: 'string', required: false, fieldName: 'provider_message_id' },
          status: { type: 'string', required: true, fieldName: 'status' },
          sentAt: { type: 'date', required: false, fieldName: 'sent_at' },
          metadata: { type: 'json', required: true, fieldName: 'metadata' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_sendfn_sms_transactions_user_id', fields: ['userId'] },
          { name: 'idx_sendfn_sms_transactions_status', fields: ['status'] }
        ]
      },
      {
        modelName: 'push_notifications',
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          title: { type: 'string', required: true, fieldName: 'title' },
          body: { type: 'string', required: true, fieldName: 'body' },
          data: { type: 'json', required: false, fieldName: 'data' },
          deviceTokens: { type: 'json', required: true, fieldName: 'device_tokens' },
          platform: { type: 'string', required: true, fieldName: 'platform' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          status: { type: 'string', required: true, fieldName: 'status' },
          sentCount: { type: 'number', required: true, fieldName: 'sent_count', defaultValue: 0 },
          failedCount: { type: 'number', required: true, fieldName: 'failed_count', defaultValue: 0 },
          sentAt: { type: 'date', required: false, fieldName: 'sent_at' },
          metadata: { type: 'json', required: true, fieldName: 'metadata' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_sendfn_push_notifications_user_id', fields: ['userId'] },
          { name: 'idx_sendfn_push_notifications_status', fields: ['status'] }
        ]
      },
      {
        modelName: 'device_tokens',
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          token: { type: 'string', required: true, fieldName: 'token' },
          platform: { type: 'string', required: true, fieldName: 'platform' },
          appVersion: { type: 'string', required: false, fieldName: 'app_version' },
          deviceInfo: { type: 'json', required: false, fieldName: 'device_info' },
          isActive: { type: 'boolean', required: true, fieldName: 'is_active', defaultValue: true },
          lastUsedAt: { type: 'date', required: true, fieldName: 'last_used_at' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_sendfn_device_tokens_user_id', fields: ['userId'] },
          { name: 'idx_sendfn_device_tokens_token', fields: ['token'], unique: true }
        ]
      },
      {
        modelName: 'suppression_list',
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          email: { type: 'string', required: true, fieldName: 'email' },
          reason: { type: 'string', required: true, fieldName: 'reason' },
          source: { type: 'string', required: true, fieldName: 'source' },
          bounceType: { type: 'string', required: false, fieldName: 'bounce_type' },
          metadata: { type: 'json', required: true, fieldName: 'metadata' },
          suppressedAt: { type: 'date', required: true, fieldName: 'suppressed_at' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' }
        },
        indexes: [
          { name: 'idx_sendfn_suppression_list_email', fields: ['email'], unique: true }
        ]
      },
      {
        modelName: 'communication_events',
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          referenceId: { type: 'string', required: true, fieldName: 'reference_id' },
          referenceType: { type: 'string', required: true, fieldName: 'reference_type' },
          eventType: { type: 'string', required: true, fieldName: 'event_type' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          providerEventId: { type: 'string', required: false, fieldName: 'provider_event_id' },
          recipientEmail: { type: 'string', required: false, fieldName: 'recipient_email' },
          recipientPhone: { type: 'string', required: false, fieldName: 'recipient_phone' },
          deviceToken: { type: 'string', required: false, fieldName: 'device_token' },
          metadata: { type: 'json', required: true, fieldName: 'metadata' },
          eventTimestamp: { type: 'date', required: true, fieldName: 'event_timestamp' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' }
        },
        indexes: [
          { name: 'idx_sendfn_communication_events_reference', fields: ['referenceId', 'referenceType'] },
          { name: 'idx_sendfn_communication_events_provider_event_id', fields: ['providerEventId'] }
        ]
      }
    ]
  };
}
