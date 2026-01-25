import type { Adapter } from '../../types/config.js';
import type { Connection } from '../../types/connection.js';
import type { Workflow, WorkflowExecution } from '../../types/workflow.js';
import type { WebhookRecord } from '../webhook-storage.js';

/**
 * In-memory storage adapter for testing and development
 */
export class MemoryAdapter implements Adapter {
  private connections = new Map<string, Connection>();
  private webhooks = new Map<string, WebhookRecord>();
  private workflows = new Map<string, Workflow>();
  private workflowExecutions = new Map<string, WorkflowExecution>();
  private actionLogs = new Map<string, any>();

  // Connections
  async createConnection(connection: Connection): Promise<void> {
    this.connections.set(connection.id, connection);
  }

  async getConnection(id: string): Promise<Connection | null> {
    return this.connections.get(id) || null;
  }

  async listConnections(userId: string, provider?: string): Promise<Connection[]> {
    const connections = Array.from(this.connections.values()).filter(
      (c) => c.userId === userId && (!provider || c.provider === provider)
    );
    return connections;
  }

  async updateConnection(id: string, updates: Partial<Connection>): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) {
      throw new Error(`Connection ${id} not found`);
    }
    this.connections.set(id, { ...connection, ...updates } as Connection);
  }

  async deleteConnection(id: string): Promise<void> {
    this.connections.delete(id);
  }

  // Webhooks
  async createWebhook(webhook: WebhookRecord): Promise<void> {
    this.webhooks.set(webhook.id, webhook);
  }

  async getWebhook(id: string): Promise<WebhookRecord | null> {
    return this.webhooks.get(id) || null;
  }

  async listWebhooks(provider?: string): Promise<WebhookRecord[]> {
    const webhooks = Array.from(this.webhooks.values());
    return provider ? webhooks.filter((w) => w.provider === provider) : webhooks;
  }

  async updateWebhook(id: string, updates: Partial<WebhookRecord>): Promise<void> {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      throw new Error(`Webhook ${id} not found`);
    }
    this.webhooks.set(id, { ...webhook, ...updates } as WebhookRecord);
  }

  async deleteWebhook(id: string): Promise<void> {
    this.webhooks.delete(id);
  }

  // Workflows
  async createWorkflow(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.workflows.get(id) || null;
  }

  async listWorkflows(userId?: string, status?: string): Promise<Workflow[]> {
    let workflows = Array.from(this.workflows.values());
    
    if (userId) {
      workflows = workflows.filter((w) => w.userId === userId);
    }
    
    if (status) {
      workflows = workflows.filter((w) => w.status === status);
    }
    
    return workflows;
  }

  async updateWorkflow(id: string, updates: Partial<Workflow>): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }
    this.workflows.set(id, { ...workflow, ...updates } as Workflow);
  }

  async deleteWorkflow(id: string): Promise<void> {
    this.workflows.delete(id);
  }

  // Workflow executions
  async createWorkflowExecution(execution: WorkflowExecution): Promise<void> {
    this.workflowExecutions.set(execution.id, execution);
  }

  async updateWorkflowExecution(id: string, updates: Partial<WorkflowExecution>): Promise<void> {
    const execution = this.workflowExecutions.get(id);
    if (!execution) {
      throw new Error(`Workflow execution ${id} not found`);
    }
    this.workflowExecutions.set(id, { ...execution, ...updates } as WorkflowExecution);
  }

  async listWorkflowExecutions(workflowId: string, limit = 50): Promise<WorkflowExecution[]> {
    const executions = Array.from(this.workflowExecutions.values())
      .filter((e) => e.workflowId === workflowId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
    
    return executions;
  }

  // Action logs
  async createActionLog(log: any): Promise<void> {
    this.actionLogs.set(log.id, log);
  }

  async listActionLogs(filters: any, limit = 100): Promise<any[]> {
    let logs = Array.from(this.actionLogs.values());
    
    if (filters.userId) {
      logs = logs.filter((l) => l.userId === filters.userId);
    }
    
    if (filters.provider) {
      logs = logs.filter((l) => l.provider === filters.provider);
    }
    
    if (filters.status) {
      logs = logs.filter((l) => l.status === filters.status);
    }
    
    return logs.slice(0, limit);
  }

  // Utility methods
  clear(): void {
    this.connections.clear();
    this.webhooks.clear();
    this.workflows.clear();
    this.workflowExecutions.clear();
    this.actionLogs.clear();
  }
}

