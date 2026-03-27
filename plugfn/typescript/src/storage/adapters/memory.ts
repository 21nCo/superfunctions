import { memoryAdapter } from '@superfunctions/db/testing';
import type { Adapter as DbAdapter, HealthStatus, TableSchema, TransactionAdapter, ValidationResult } from '@superfunctions/db';
import type { Connection } from '../../types/connection.js';
import type { Workflow, WorkflowExecution } from '../../types/workflow.js';
import type { WebhookRecord } from '../webhook-storage.js';
import {
  createPlugFnDatabaseAdapter,
  DEFAULT_PLUGFN_STORAGE_MODELS,
  type PlugFnDatabaseStorageAdapter,
} from './database.js';

/**
 * In-memory storage adapter for testing and development
 */
export class MemoryAdapter implements DbAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: DbAdapter['capabilities'];
  readonly internal: DbAdapter['internal'];
  private readonly db: DbAdapter;
  private readonly storage: PlugFnDatabaseStorageAdapter;

  constructor() {
    this.db = memoryAdapter();
    this.id = this.db.id;
    this.name = this.db.name;
    this.version = this.db.version;
    this.capabilities = this.db.capabilities;
    this.internal = this.db.internal;
    this.storage = createPlugFnDatabaseAdapter({
      database: this.db,
      models: DEFAULT_PLUGFN_STORAGE_MODELS,
    });
  }

  async create<T = any>(params: Parameters<DbAdapter['create']>[0]): Promise<T> {
    return this.db.create<T>(params);
  }

  async findOne<T = any>(params: Parameters<DbAdapter['findOne']>[0]): Promise<T | null> {
    return this.db.findOne<T>(params);
  }

  async findMany<T = any>(params: Parameters<DbAdapter['findMany']>[0]): Promise<T[]> {
    return this.db.findMany<T>(params);
  }

  async update<T = any>(params: Parameters<DbAdapter['update']>[0]): Promise<T> {
    return this.db.update<T>(params);
  }

  async delete(params: Parameters<DbAdapter['delete']>[0]): Promise<void> {
    await this.db.delete(params);
  }

  async createMany<T = any>(params: Parameters<DbAdapter['createMany']>[0]): Promise<T[]> {
    return this.db.createMany<T>(params);
  }

  async updateMany(params: Parameters<DbAdapter['updateMany']>[0]): Promise<number> {
    return this.db.updateMany(params);
  }

  async deleteMany(params: Parameters<DbAdapter['deleteMany']>[0]): Promise<number> {
    return this.db.deleteMany(params);
  }

  async upsert<T = any>(params: Parameters<DbAdapter['upsert']>[0]): Promise<T> {
    return this.db.upsert<T>(params);
  }

  async count(params: Parameters<DbAdapter['count']>[0]): Promise<number> {
    return this.db.count(params);
  }

  async transaction<R>(callback: (trx: TransactionAdapter) => Promise<R>): Promise<R> {
    return this.db.transaction(callback);
  }

  async initialize(): Promise<void> {
    await this.db.initialize();
  }

  async isHealthy(): Promise<HealthStatus> {
    return this.db.isHealthy();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async getSchemaVersion(namespace: string): Promise<number> {
    return this.db.getSchemaVersion(namespace);
  }

  async setSchemaVersion(namespace: string, version: number): Promise<void> {
    await this.db.setSchemaVersion(namespace, version);
  }

  async validateSchema(schema: TableSchema): Promise<ValidationResult> {
    return this.db.validateSchema(schema);
  }

  // Connections
  async createConnection(connection: Connection): Promise<Connection> {
    return this.storage.createConnection(connection);
  }

  async getConnection(id: string): Promise<Connection | null> {
    return this.storage.getConnection(id);
  }

  async listConnections(userId: string, provider?: string): Promise<Connection[]> {
    return this.storage.listConnections(userId, provider);
  }

  async updateConnection(id: string, updates: Partial<Connection>): Promise<Connection> {
    return this.storage.updateConnection(id, updates);
  }

  async deleteConnection(id: string): Promise<void> {
    await this.storage.deleteConnection(id);
  }

  // Webhooks
  async createWebhook(webhook: WebhookRecord): Promise<WebhookRecord> {
    return this.storage.createWebhook(webhook);
  }

  async getWebhook(id: string): Promise<WebhookRecord | null> {
    return this.storage.getWebhook(id);
  }

  async listWebhooks(provider?: string): Promise<WebhookRecord[]> {
    return this.storage.listWebhooks(provider);
  }

  async updateWebhook(id: string, updates: Partial<WebhookRecord>): Promise<WebhookRecord> {
    return this.storage.updateWebhook(id, updates);
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.storage.deleteWebhook(id);
  }

  // Workflows
  async createWorkflow(workflow: Workflow): Promise<Workflow> {
    return this.storage.createWorkflow(workflow);
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.storage.getWorkflow(id);
  }

  async listWorkflows(userId?: string, status?: string): Promise<Workflow[]> {
    return this.storage.listWorkflows(userId, status);
  }

  async updateWorkflow(id: string, updates: Partial<Workflow>): Promise<Workflow> {
    return this.storage.updateWorkflow(id, updates);
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.storage.deleteWorkflow(id);
  }

  // Workflow executions
  async createWorkflowExecution(execution: WorkflowExecution): Promise<WorkflowExecution> {
    return this.storage.createWorkflowExecution(execution);
  }

  async updateWorkflowExecution(
    id: string,
    updates: Partial<WorkflowExecution>
  ): Promise<WorkflowExecution> {
    return this.storage.updateWorkflowExecution(id, updates);
  }

  async listWorkflowExecutions(workflowId: string, limit = 50): Promise<WorkflowExecution[]> {
    return this.storage.listWorkflowExecutions(workflowId, limit);
  }

  // Action logs
  async createActionLog(log: any): Promise<Record<string, unknown>> {
    return this.storage.createActionLog(log);
  }

  async listActionLogs(filters: any, limit = 100): Promise<any[]> {
    return this.storage.listActionLogs(filters, limit);
  }

  // Utility methods
  clear(): void {
    void Promise.all([
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.connections, where: [] }),
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.webhooks, where: [] }),
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.workflows, where: [] }),
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.workflowExecutions, where: [] }),
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.actionLogs, where: [] }),
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.oauthStates, where: [] }),
      this.deleteMany({ model: DEFAULT_PLUGFN_STORAGE_MODELS.oauthTokens, where: [] }),
    ]);
  }
}
