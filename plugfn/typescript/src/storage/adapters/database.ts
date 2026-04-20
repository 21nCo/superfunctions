import type { Adapter as DbAdapter, WhereClause } from '@superfunctions/db';
import type { Connection } from '../../types/connection.js';
import type { Workflow, WorkflowExecution } from '../../types/workflow.js';
import type { WebhookRecord } from '../webhook-storage.js';

export interface PlugFnStorageModelMapping {
  connections: string;
  oauthStates: string;
  oauthTokens: string;
  workflows: string;
  workflowExecutions: string;
  webhooks: string;
  actionLogs: string;
}

export const DEFAULT_PLUGFN_STORAGE_MODELS: PlugFnStorageModelMapping = {
  connections: 'connections',
  oauthStates: 'oauth_states',
  oauthTokens: 'oauth_tokens',
  workflows: 'workflows',
  workflowExecutions: 'workflow_executions',
  webhooks: 'webhooks',
  actionLogs: 'action_logs',
};

export type PlugFnRequiredModelName =
  | 'connections'
  | 'oauth_states'
  | 'oauth_tokens'
  | 'workflows'
  | 'workflow_executions';

export const PLUGFN_REQUIRED_MODEL_NAMES: PlugFnRequiredModelName[] = [
  'connections',
  'oauth_states',
  'oauth_tokens',
  'workflows',
  'workflow_executions',
];

export interface PlugFnDatabaseStorageAdapter {
  readonly database: DbAdapter;
  readonly models: PlugFnStorageModelMapping;
  createConnection(connection: Connection): Promise<Connection>;
  getConnection(id: string): Promise<Connection | null>;
  listConnections(userId: string, provider?: string): Promise<Connection[]>;
  updateConnection(id: string, updates: Partial<Connection>): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;
  createWebhook(webhook: WebhookRecord): Promise<WebhookRecord>;
  getWebhook(id: string): Promise<WebhookRecord | null>;
  listWebhooks(provider?: string): Promise<WebhookRecord[]>;
  updateWebhook(id: string, updates: Partial<WebhookRecord>): Promise<WebhookRecord>;
  deleteWebhook(id: string): Promise<void>;
  createWorkflow(workflow: Workflow): Promise<Workflow>;
  getWorkflow(id: string): Promise<Workflow | null>;
  listWorkflows(userId?: string, status?: string): Promise<Workflow[]>;
  updateWorkflow(id: string, updates: Partial<Workflow>): Promise<Workflow>;
  deleteWorkflow(id: string): Promise<void>;
  createWorkflowExecution(execution: WorkflowExecution): Promise<WorkflowExecution>;
  updateWorkflowExecution(id: string, updates: Partial<WorkflowExecution>): Promise<WorkflowExecution>;
  listWorkflowExecutions(workflowId: string, limit?: number): Promise<WorkflowExecution[]>;
  createActionLog(log: Record<string, unknown>): Promise<Record<string, unknown>>;
  listActionLogs(filters: Record<string, unknown>, limit?: number): Promise<Record<string, unknown>[]>;
}

export interface PlugFnDatabaseAdapterOptions {
  database: DbAdapter;
  models?: Partial<PlugFnStorageModelMapping>;
}

export function createPlugFnDatabaseAdapter(
  options: PlugFnDatabaseAdapterOptions
): PlugFnDatabaseStorageAdapter {
  return new DbBackedPlugFnDatabaseAdapter(options.database, resolvePlugFnStorageModels(options.models));
}

export function ensurePlugFnDatabaseAdapter(
  value: DbAdapter | PlugFnDatabaseStorageAdapter,
  models?: Partial<PlugFnStorageModelMapping>
): PlugFnDatabaseStorageAdapter {
  if (isPlugFnDatabaseStorageAdapter(value)) {
    return value;
  }

  return createPlugFnDatabaseAdapter({
    database: value,
    models,
  });
}

function isPlugFnDatabaseStorageAdapter(
  value: DbAdapter | PlugFnDatabaseStorageAdapter
): value is PlugFnDatabaseStorageAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'database' in value &&
    'models' in value &&
    typeof (value as PlugFnDatabaseStorageAdapter).getConnection === 'function'
  );
}

export function resolvePlugFnStorageModels(
  models?: Partial<PlugFnStorageModelMapping>
): PlugFnStorageModelMapping {
  return {
    connections: models?.connections ?? DEFAULT_PLUGFN_STORAGE_MODELS.connections,
    oauthStates: models?.oauthStates ?? DEFAULT_PLUGFN_STORAGE_MODELS.oauthStates,
    oauthTokens: models?.oauthTokens ?? DEFAULT_PLUGFN_STORAGE_MODELS.oauthTokens,
    workflows: models?.workflows ?? DEFAULT_PLUGFN_STORAGE_MODELS.workflows,
    workflowExecutions: models?.workflowExecutions ?? DEFAULT_PLUGFN_STORAGE_MODELS.workflowExecutions,
    webhooks: models?.webhooks ?? DEFAULT_PLUGFN_STORAGE_MODELS.webhooks,
    actionLogs: models?.actionLogs ?? DEFAULT_PLUGFN_STORAGE_MODELS.actionLogs,
  };
}

class DbBackedPlugFnDatabaseAdapter implements PlugFnDatabaseStorageAdapter {
  readonly database: DbAdapter;
  readonly models: PlugFnStorageModelMapping;

  constructor(database: DbAdapter, models: PlugFnStorageModelMapping) {
    this.database = database;
    this.models = models;
  }

  async createConnection(connection: Connection): Promise<Connection> {
    return this.database.create<Connection>({
      model: this.models.connections,
      data: cloneRecord(connection),
    });
  }

  async getConnection(id: string): Promise<Connection | null> {
    return this.database.findOne<Connection>({
      model: this.models.connections,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async listConnections(userId: string, provider?: string): Promise<Connection[]> {
    const where: WhereClause[] = [{ field: 'userId', operator: 'eq', value: userId }];
    if (provider) {
      where.push({ field: 'provider', operator: 'eq', value: provider });
    }

    return this.database.findMany<Connection>({
      model: this.models.connections,
      where,
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
  }

  async updateConnection(id: string, updates: Partial<Connection>): Promise<Connection> {
    return this.database.update<Connection>({
      model: this.models.connections,
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: cloneRecord(updates),
    });
  }

  async deleteConnection(id: string): Promise<void> {
    await this.database.delete({
      model: this.models.connections,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async createWebhook(webhook: WebhookRecord): Promise<WebhookRecord> {
    return this.database.create<WebhookRecord>({
      model: this.models.webhooks,
      data: cloneRecord(webhook),
    });
  }

  async getWebhook(id: string): Promise<WebhookRecord | null> {
    return this.database.findOne<WebhookRecord>({
      model: this.models.webhooks,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async listWebhooks(provider?: string): Promise<WebhookRecord[]> {
    const where: WhereClause[] = [];
    if (provider) {
      where.push({ field: 'provider', operator: 'eq', value: provider });
    }

    return this.database.findMany<WebhookRecord>({
      model: this.models.webhooks,
      where,
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
  }

  async updateWebhook(id: string, updates: Partial<WebhookRecord>): Promise<WebhookRecord> {
    return this.database.update<WebhookRecord>({
      model: this.models.webhooks,
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: cloneRecord(updates),
    });
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.database.delete({
      model: this.models.webhooks,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async createWorkflow(workflow: Workflow): Promise<Workflow> {
    return this.database.create<Workflow>({
      model: this.models.workflows,
      data: cloneRecord(workflow),
    });
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.database.findOne<Workflow>({
      model: this.models.workflows,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async listWorkflows(userId?: string, status?: string): Promise<Workflow[]> {
    const where: WhereClause[] = [];
    if (userId) {
      where.push({ field: 'userId', operator: 'eq', value: userId });
    }
    if (status) {
      where.push({ field: 'status', operator: 'eq', value: status });
    }

    return this.database.findMany<Workflow>({
      model: this.models.workflows,
      where,
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
  }

  async updateWorkflow(id: string, updates: Partial<Workflow>): Promise<Workflow> {
    return this.database.update<Workflow>({
      model: this.models.workflows,
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: cloneRecord(updates),
    });
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.database.delete({
      model: this.models.workflows,
      where: [{ field: 'id', operator: 'eq', value: id }],
    });
  }

  async createWorkflowExecution(execution: WorkflowExecution): Promise<WorkflowExecution> {
    return this.database.create<WorkflowExecution>({
      model: this.models.workflowExecutions,
      data: cloneRecord(execution),
    });
  }

  async updateWorkflowExecution(
    id: string,
    updates: Partial<WorkflowExecution>
  ): Promise<WorkflowExecution> {
    return this.database.update<WorkflowExecution>({
      model: this.models.workflowExecutions,
      where: [{ field: 'id', operator: 'eq', value: id }],
      data: cloneRecord(updates),
    });
  }

  async listWorkflowExecutions(workflowId: string, limit = 50): Promise<WorkflowExecution[]> {
    return this.database.findMany<WorkflowExecution>({
      model: this.models.workflowExecutions,
      where: [{ field: 'workflowId', operator: 'eq', value: workflowId }],
      orderBy: [{ field: 'startedAt', direction: 'desc' }],
      limit,
    });
  }

  async createActionLog(log: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.database.create<Record<string, unknown>>({
      model: this.models.actionLogs,
      data: cloneRecord(log),
    });
  }

  async listActionLogs(
    filters: Record<string, unknown>,
    limit = 100
  ): Promise<Record<string, unknown>[]> {
    const where: WhereClause[] = [];

    for (const [field, value] of Object.entries(filters)) {
      if (value === undefined) {
        continue;
      }
      where.push({ field, operator: 'eq', value });
    }

    return this.database.findMany<Record<string, unknown>>({
      model: this.models.actionLogs,
      where,
      orderBy: [{ field: 'executedAt', direction: 'desc' }],
      limit,
    });
  }
}

function cloneRecord<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
