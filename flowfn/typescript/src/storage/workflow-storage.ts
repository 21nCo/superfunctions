/**
 * Workflow state storage abstraction
 */

import { WorkflowExecution, ExecutionStatus } from "../workflow/types.js";

export interface WorkflowStorage {
  /**
   * Save workflow execution state
   */
  save(workflowId: string, execution: WorkflowExecution): Promise<void>;

  /**
   * Get workflow execution by ID
   */
  get(executionId: string): Promise<WorkflowExecution | null>;

  /**
   * List executions for a workflow
   */
  list(workflowId: string, options?: ListOptions): Promise<WorkflowExecution[]>;

  /**
   * Update execution status
   */
  updateStatus(executionId: string, status: string): Promise<void>;

  /**
   * Update execution state
   */
  updateState(executionId: string, state: Record<string, any>): Promise<void>;

  /**
   * Delete an execution
   */
  delete(executionId: string): Promise<void>;

  /**
   * Clean old executions
   */
  clean(workflowId: string, grace: number): Promise<number>;
}

export interface ListOptions {
  status?: string;
  limit?: number;
  offset?: number;
  sortBy?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
}

/**
 * In-memory workflow storage implementation
 */
export class MemoryWorkflowStorage implements WorkflowStorage {
  private executions: Map<string, WorkflowExecution> = new Map();
  private workflowIndex: Map<string, Set<string>> = new Map(); // workflowId -> executionIds

  async save(workflowId: string, execution: WorkflowExecution): Promise<void> {
    this.executions.set(execution.id, { ...execution });

    // Index by workflow ID
    if (!this.workflowIndex.has(workflowId)) {
      this.workflowIndex.set(workflowId, new Set());
    }
    this.workflowIndex.get(workflowId)!.add(execution.id);
  }

  async get(executionId: string): Promise<WorkflowExecution | null> {
    return this.executions.get(executionId) || null;
  }

  async list(
    workflowId: string,
    options: ListOptions = {}
  ): Promise<WorkflowExecution[]> {
    const executionIds = this.workflowIndex.get(workflowId) || new Set();
    let executions: WorkflowExecution[] = [];

    for (const id of executionIds) {
      const execution = this.executions.get(id);
      if (execution) {
        // Filter by status if specified
        if (!options.status || execution.status === options.status) {
          executions.push(execution);
        }
      }
    }

    // Sort
    const sortBy = options.sortBy || "createdAt";
    const sortOrder = options.sortOrder || "desc";

    executions.sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || executions.length;

    return executions.slice(offset, offset + limit);
  }

  async updateStatus(
    executionId: string,
    status: ExecutionStatus
  ): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.status = status as ExecutionStatus;
      execution.updatedAt = Date.now();

      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        execution.completedAt = Date.now();
      }
    }
  }

  async updateState(
    executionId: string,
    state: Record<string, any>
  ): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.state = { ...execution.state, ...state };
      execution.updatedAt = Date.now();
    }
  }

  async delete(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution) {
      // Remove from workflow index
      const workflowId = execution.workflowId;
      const executionIds = this.workflowIndex.get(workflowId);
      if (executionIds) {
        executionIds.delete(executionId);
        if (executionIds.size === 0) {
          this.workflowIndex.delete(workflowId);
        }
      }

      this.executions.delete(executionId);
    }
  }

  async clean(workflowId: string, grace: number): Promise<number> {
    const now = Date.now();
    const executionIds = this.workflowIndex.get(workflowId) || new Set();
    const toDelete: string[] = [];

    for (const id of executionIds) {
      const execution = this.executions.get(id);
      if (execution && execution.completedAt) {
        if (now - execution.completedAt > grace) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      await this.delete(id);
    }

    return toDelete.length;
  }

  /**
   * Clear all executions
   */
  clear(): void {
    this.executions.clear();
    this.workflowIndex.clear();
  }
}
