import type { Workflow, WorkflowExecution, WorkflowStatus } from '../types/workflow.js';
import type { Adapter } from '../types/config.js';

/**
 * Workflow storage interface
 */
export interface WorkflowStorage {
  create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<Workflow>;
  get(id: string): Promise<Workflow | null>;
  list(userId?: string, status?: WorkflowStatus): Promise<Workflow[]>;
  update(id: string, updates: Partial<Workflow>): Promise<Workflow>;
  delete(id: string): Promise<void>;
  
  // Executions
  createExecution(execution: Omit<WorkflowExecution, 'id' | 'startedAt'>): Promise<WorkflowExecution>;
  updateExecution(id: string, updates: Partial<WorkflowExecution>): Promise<void>;
  listExecutions(workflowId: string, limit?: number): Promise<WorkflowExecution[]>;
}

/**
 * Workflow storage implementation using adapter
 */
export class AdapterWorkflowStorage implements WorkflowStorage {
  constructor(private adapter: Adapter) {}

  async create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<Workflow> {
    const id = this.generateId();
    const now = new Date();
    
    const fullWorkflow: Workflow = {
      ...workflow,
      id,
      createdAt: now,
      updatedAt: now,
    };
    
    await this.adapter.createWorkflow(fullWorkflow);
    return fullWorkflow;
  }

  async get(id: string): Promise<Workflow | null> {
    return this.adapter.getWorkflow(id);
  }

  async list(userId?: string, status?: WorkflowStatus): Promise<Workflow[]> {
    return this.adapter.listWorkflows(userId, status);
  }

  async update(id: string, updates: Partial<Workflow>): Promise<Workflow> {
    await this.adapter.updateWorkflow(id, {
      ...updates,
      updatedAt: new Date(),
    });
    
    const updated = await this.adapter.getWorkflow(id);
    if (!updated) {
      throw new Error(`Workflow ${id} not found after update`);
    }
    
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.adapter.deleteWorkflow(id);
  }

  async createExecution(execution: Omit<WorkflowExecution, 'id' | 'startedAt'>): Promise<WorkflowExecution> {
    const id = this.generateExecutionId();
    const startedAt = new Date();
    
    const fullExecution: WorkflowExecution = {
      ...execution,
      id,
      startedAt,
    };
    
    await this.adapter.createWorkflowExecution(fullExecution);
    return fullExecution;
  }

  async updateExecution(id: string, updates: Partial<WorkflowExecution>): Promise<void> {
    await this.adapter.updateWorkflowExecution(id, updates);
  }

  async listExecutions(workflowId: string, limit?: number): Promise<WorkflowExecution[]> {
    return this.adapter.listWorkflowExecutions(workflowId, limit);
  }

  private generateId(): string {
    return `wf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateExecutionId(): string {
    return `wfx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

