import { FlowAdapter } from "./base.js";
import { Job, QueueStats } from "../queue/types.js";
import {
  Message,
  MessageHandler,
  Subscription,
  StreamInfo,
} from "../stream/types.js";
import { WorkflowExecution } from "../workflow/types.js";
import { EventEmitter } from "eventemitter3";

export class MemoryAdapter implements FlowAdapter {
  private queues: Map<string, Job[]> = new Map();
  private allJobs: Map<string, Job> = new Map();
  private streams: Map<string, Message[]> = new Map();
  private streamEmitters: Map<string, EventEmitter> = new Map();
  private workflowStates: Map<string, WorkflowExecution> = new Map();

  async enqueue(queueName: string, job: Job): Promise<string> {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }
    const queue = this.queues.get(queueName)!;
    queue.push(job);
    this.allJobs.set(job.id, job);
    return job.id;
  }

  async dequeue(queueName: string): Promise<Job | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) return null;
    return queue.shift() || null;
  }

  async ack(queue: string, jobId: string): Promise<void> {
    const job = this.allJobs.get(jobId);
    if (job) {
      job.state = "completed";
      job.finishedOn = Date.now();
    }
  }

  async nack(
    queueName: string,
    jobId: string,
    requeue: boolean = true
  ): Promise<void> {
    const job = this.allJobs.get(jobId);
    if (job && requeue) {
      job.state = "waiting";
      const queue = this.queues.get(queueName);
      if (queue) queue.push(job);
    }
  }

  async getJob(queueName: string, jobId: string): Promise<Job | null> {
    return this.allJobs.get(jobId) || null;
  }

  async getJobs(queue: string, status: string): Promise<Job[]> {
    return Array.from(this.allJobs.values()).filter(
      (job) => job.state === status
    );
  }

  async getAllJobs(queue: string): Promise<Job[]> {
    return Array.from(this.allJobs.values());
  }

  async cleanJobs(
    queue: string,
    grace: number,
    status: string
  ): Promise<number> {
    const now = Date.now();
    const jobsToClean: string[] = [];

    for (const [id, job] of this.allJobs.entries()) {
      if (job.state === status) {
        const timestamp = job.finishedOn || job.timestamp;
        if (now - timestamp > grace) {
          jobsToClean.push(id);
        }
      }
    }

    for (const id of jobsToClean) {
      this.allJobs.delete(id);
    }

    return jobsToClean.length;
  }

  async publish(streamName: string, message: Message): Promise<string> {
    if (!this.streams.has(streamName)) {
      this.streams.set(streamName, []);
      this.streamEmitters.set(streamName, new EventEmitter());
    }
    const stream = this.streams.get(streamName)!;
    stream.push(message);
    this.streamEmitters.get(streamName)!.emit("message", message);
    return message.id;
  }

  async subscribe(
    streamName: string,
    handler: MessageHandler<any>
  ): Promise<Subscription> {
    if (!this.streamEmitters.has(streamName)) {
      this.streamEmitters.set(streamName, new EventEmitter());
      this.streams.set(streamName, []);
    }
    const emitter = this.streamEmitters.get(streamName)!;
    const wrapper = (msg: Message) => {
      handler(msg).catch((err) => console.error("Stream handler error", err));
    };
    emitter.on("message", wrapper);

    return {
      unsubscribe: async () => {
        emitter.off("message", wrapper);
      },
    };
  }

  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>
  ): Promise<Subscription> {
    return this.subscribe(stream, handler);
  }

  async createConsumerGroup(stream: string, group: string): Promise<void> {
    // No-op for memory
  }

  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution
  ): Promise<void> {
    this.workflowStates.set(workflowId, state);
  }

  async loadWorkflowState(
    workflowId: string
  ): Promise<WorkflowExecution | null> {
    return this.workflowStates.get(workflowId) || null;
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const length = this.queues.get(queueName)?.length || 0;
    const allInQueue = Array.from(this.allJobs.values()).filter(
      (j) => j.state === "completed"
    ).length;
    return {
      waiting: length,
      active: 0,
      completed: allInQueue,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
  }

  async getStreamInfo(streamName: string): Promise<StreamInfo> {
    const length = this.streams.get(streamName)?.length || 0;
    return {
      name: streamName,
      length,
      groups: 0,
    };
  }

  async cleanup(): Promise<void> {
    this.queues.clear();
    this.allJobs.clear();
    this.streams.clear();
    this.workflowStates.clear();
    this.streamEmitters.clear();
  }
}
