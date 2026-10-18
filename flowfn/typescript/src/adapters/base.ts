import { Job, QueueStats } from "../queue/types.js";
import {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
  ConsumerOptions,
  SubscribeOptions,
  TrimStrategy,
} from "../stream/types.js";
import { WorkflowExecution } from "../workflow/types.js";

export interface FlowAdapter {
  // Queue operations
  enqueue(queue: string, job: Job): Promise<string>;
  dequeue(queue: string, name?: string): Promise<Job | null>;
  ack(queue: string, jobId: string): Promise<void>;
  nack(queue: string, jobId: string, requeue?: boolean): Promise<void>;

  saveJob?(queue: string, job: Job): Promise<void>;
  removeJob?(queue: string, jobId: string): Promise<void>;

  // Stream operations
  publish(stream: string, message: Message): Promise<string>;
  subscribe(
    stream: string,
    handler: MessageHandler<any>,
    options?: SubscribeOptions,
  ): Promise<Subscription>;
  consume(
    stream: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>,
    options?: ConsumerOptions,
  ): Promise<Subscription>;
  createConsumerGroup(stream: string, group: string): Promise<void>;

  getMessages?(
    stream: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<Message[]>;
  trimStream?(stream: string, strategy: TrimStrategy): Promise<number>;

  // Workflow operations
  saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution,
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
