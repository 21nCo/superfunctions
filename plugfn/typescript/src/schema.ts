import type { TableSchema } from '@superfunctions/db';
import { DEFAULT_PLUGFN_STORAGE_MODELS, resolvePlugFnStorageModels, type PlugFnStorageModelMapping } from './storage/adapters/database.js';

export const PLUGFN_SCHEMA_VERSION = 1;

export interface PlugFnSchemaOptions {
  namespace?: string;
  models?: Partial<PlugFnStorageModelMapping>;
}

export function getSchema(options: PlugFnSchemaOptions = {}): { version: number; schemas: TableSchema[] } {
  const models = resolvePlugFnStorageModels(options.models);

  return {
    version: PLUGFN_SCHEMA_VERSION,
    schemas: [
      {
        modelName: models.connections,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          name: { type: 'string', required: false, fieldName: 'name' },
          status: { type: 'string', required: true, fieldName: 'status' },
          credentials: { type: 'json', required: true, fieldName: 'credentials' },
          scopes: { type: 'json', required: false, fieldName: 'scopes' },
          metadata: { type: 'json', required: false, fieldName: 'metadata' },
          expiresAt: { type: 'date', required: false, fieldName: 'expires_at' },
          connectedAt: { type: 'date', required: true, fieldName: 'connected_at' },
          lastUsedAt: { type: 'date', required: false, fieldName: 'last_used_at' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_plugfn_connections_user_provider', fields: ['userId', 'provider'] },
          { name: 'idx_plugfn_connections_status', fields: ['status'] }
        ]
      },
      {
        modelName: models.oauthStates,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          stateHash: { type: 'string', required: true, fieldName: 'state_hash' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          redirectUri: { type: 'string', required: false, fieldName: 'redirect_uri' },
          codeVerifierHash: { type: 'string', required: false, fieldName: 'code_verifier_hash' },
          metadata: { type: 'json', required: false, fieldName: 'metadata' },
          expiresAt: { type: 'date', required: true, fieldName: 'expires_at' },
          consumedAt: { type: 'date', required: false, fieldName: 'consumed_at' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' }
        },
        indexes: [
          { name: 'idx_plugfn_oauth_states_state_hash', fields: ['stateHash'], unique: true },
          { name: 'idx_plugfn_oauth_states_provider_user', fields: ['provider', 'userId'] },
          { name: 'idx_plugfn_oauth_states_expires_at', fields: ['expiresAt'] }
        ]
      },
      {
        modelName: models.oauthTokens,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          connectionId: { type: 'string', required: true, fieldName: 'connection_id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          tokenHash: { type: 'string', required: true, fieldName: 'token_hash' },
          encryptedPayload: { type: 'string', required: true, fieldName: 'encrypted_payload' },
          keyRef: { type: 'string', required: true, fieldName: 'key_ref' },
          expiresAt: { type: 'date', required: false, fieldName: 'expires_at' },
          metadata: { type: 'json', required: false, fieldName: 'metadata' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_plugfn_oauth_tokens_connection_id', fields: ['connectionId'] },
          { name: 'idx_plugfn_oauth_tokens_token_hash', fields: ['tokenHash'], unique: true },
          { name: 'idx_plugfn_oauth_tokens_user_provider', fields: ['userId', 'provider'] }
        ]
      },
      {
        modelName: models.workflows,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: true, fieldName: 'user_id' },
          name: { type: 'string', required: true, fieldName: 'name' },
          description: { type: 'string', required: false, fieldName: 'description' },
          definition: { type: 'json', required: true, fieldName: 'definition' },
          status: { type: 'string', required: true, fieldName: 'status' },
          metadata: { type: 'json', required: false, fieldName: 'metadata' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_plugfn_workflows_user_id', fields: ['userId'] },
          { name: 'idx_plugfn_workflows_status', fields: ['status'] }
        ]
      },
      {
        modelName: models.workflowExecutions,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          workflowId: { type: 'string', required: true, fieldName: 'workflow_id' },
          status: { type: 'string', required: true, fieldName: 'status' },
          input: { type: 'json', required: false, fieldName: 'input' },
          output: { type: 'json', required: false, fieldName: 'output' },
          error: { type: 'string', required: false, fieldName: 'error' },
          durationMs: { type: 'number', required: false, fieldName: 'duration_ms' },
          startedAt: { type: 'date', required: true, fieldName: 'started_at' },
          completedAt: { type: 'date', required: false, fieldName: 'completed_at' }
        },
        indexes: [
          { name: 'idx_plugfn_workflow_executions_workflow_id', fields: ['workflowId'] },
          { name: 'idx_plugfn_workflow_executions_status', fields: ['status'] }
        ]
      },
      {
        modelName: models.webhooks ?? DEFAULT_PLUGFN_STORAGE_MODELS.webhooks,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          provider: { type: 'string', required: true, fieldName: 'provider' },
          connectionId: { type: 'string', required: false, fieldName: 'connection_id' },
          events: { type: 'json', required: true, fieldName: 'events' },
          webhookUrl: { type: 'string', required: true, fieldName: 'webhook_url' },
          secret: { type: 'string', required: true, fieldName: 'secret' },
          status: { type: 'string', required: true, fieldName: 'status' },
          metadata: { type: 'json', required: false, fieldName: 'metadata' },
          createdAt: { type: 'date', required: true, fieldName: 'created_at' },
          updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
        },
        indexes: [
          { name: 'idx_plugfn_webhooks_provider', fields: ['provider'] },
          { name: 'idx_plugfn_webhooks_connection_id', fields: ['connectionId'] }
        ]
      },
      {
        modelName: models.actionLogs ?? DEFAULT_PLUGFN_STORAGE_MODELS.actionLogs,
        fields: {
          id: { type: 'string', required: true, fieldName: 'id' },
          userId: { type: 'string', required: false, fieldName: 'user_id' },
          provider: { type: 'string', required: false, fieldName: 'provider' },
          action: { type: 'string', required: false, fieldName: 'action' },
          connectionId: { type: 'string', required: false, fieldName: 'connection_id' },
          status: { type: 'string', required: false, fieldName: 'status' },
          input: { type: 'json', required: false, fieldName: 'input' },
          output: { type: 'json', required: false, fieldName: 'output' },
          error: { type: 'string', required: false, fieldName: 'error' },
          executedAt: { type: 'date', required: true, fieldName: 'executed_at' },
          metadata: { type: 'json', required: false, fieldName: 'metadata' }
        },
        indexes: [
          { name: 'idx_plugfn_action_logs_provider_action', fields: ['provider', 'action'] },
          { name: 'idx_plugfn_action_logs_connection_id', fields: ['connectionId'] }
        ]
      }
    ]
  };
}
