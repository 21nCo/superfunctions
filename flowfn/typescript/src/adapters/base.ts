import { Job, QueueStats } from "../queue/types.js";
import {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
} from "../stream/types.js";
import { WorkflowExecution } from "../workflow/types.js";

export interface FlowAdapter {
  // Queue operations
  enqueue(queue: string, job: Job): Promise<string>;
  dequeue(queue: string): Promise<Job | null>;
  ack(queue: string, jobId: string): Promise<void>;
  nack(queue: string, jobId: string, requeue?: boolean): Promise<void>;

  // Stream operations
  publish(stream: string, message: Message): Promise<string>;
  subscribe(
    stream: string,
    handler: MessageHandler<any>
  ): Promise<Subscription>;
  consume(
    stream: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>
  ): Promise<Subscription>;
  createConsumerGroup(stream: string, group: string): Promise<void>;

  // Workflow operations
  saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution
  ): Promise<void>;
  loadWorkflowState(workflowId: string): Promise<WorkflowExecution | null>;

  // Management
  getJob(queue: string, jobId: string): Promise<Job | null>;
  getJobs(queue: string, status: string): Promise<Job[]>;
  getAllJobs(queue: string): Promise<Job[]>;
  cleanJobs(queue: string, grace: number, status: string): Promise<number>;
  getQueueStats(queue: string): Promise<QueueStats>;
  getStreamInfo(stream: string): Promise<StreamInfo>;
  cleanup(): Promise<void>;
}
