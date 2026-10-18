import { FlowAdapter } from "./base.js";
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
import { MemoryConsumerGroups, copyMessage } from "../stream/memory-groups.js";
import { snapshotJob } from "../queue/job.js";
import { EventEmitter } from "eventemitter3";

export class MemoryAdapter implements FlowAdapter {
  private queues = new Map<string, Map<string, Job>>();
  private streams: Map<string, Message[]> = new Map();
  private streamEmitters: Map<string, EventEmitter> = new Map();
  private sequence = new Map<string, number>();
  private groups = new MemoryConsumerGroups(
    (stream) => this.streams.get(stream) ?? [],
  );
  private workflowStates: Map<string, WorkflowExecution> = new Map();
  private queue(queue: string): Map<string, Job> {
    if (!this.queues.has(queue)) this.queues.set(queue, new Map());
    return this.queues.get(queue)!;
  }
  async enqueue(queue: string, job: Job): Promise<string> {
    const value = snapshotJob(job);
    value.state = (value.opts.delay ?? 0) > 0 ? "delayed" : "waiting";
    value.delay = value.opts.delay ?? 0;
    value.timestamp = Date.now();
    this.queue(queue).set(value.id, value);
    return value.id;
  }
  async dequeue(queue: string, name?: string): Promise<Job | null> {
    const jobs = [...this.queue(queue).values()].filter(
      (job) =>
        (!name || job.name === name) &&
        (job.state === "waiting" ||
          (job.state === "delayed" && job.timestamp + job.delay <= Date.now())),
    );
    jobs.sort(
      (a, b) =>
        (b.opts.priority ?? 0) - (a.opts.priority ?? 0) ||
        (a.opts.lifo || b.opts.lifo
          ? b.timestamp - a.timestamp
          : a.timestamp - b.timestamp),
    );
    const ready = jobs.find((job) =>
      (job.opts.waitFor ?? []).every(
        (id) => this.queue(queue).get(id)?.state === "completed",
      ),
    );
    if (!ready) return null;
    ready.state = "active";
    ready.processedOn = Date.now();
    return snapshotJob(ready);
  }
  async saveJob(queue: string, job: Job): Promise<void> {
    if (!this.queue(queue).has(job.id)) throw new Error("Job not found");
    this.queue(queue).set(job.id, snapshotJob(job));
  }
  async removeJob(queue: string, id: string): Promise<void> {
    this.queue(queue).delete(id);
  }
  async ack(queue: string, id: string): Promise<void> {
    const job = this.queue(queue).get(id);
    if (job && job.state !== "failed") {
      job.state = "completed";
      job.finishedOn ??= Date.now();
    }
  }
  async nack(queue: string, id: string, requeue = true): Promise<void> {
    const job = this.queue(queue).get(id);
    if (job) {
      job.state = requeue ? "waiting" : "failed";
      if (!requeue) job.finishedOn ??= Date.now();
    }
  }
  async getJob(queue: string, id: string): Promise<Job | null> {
    const job = this.queue(queue).get(id);
    return job ? snapshotJob(job) : null;
  }
  async getJobs(queue: string, status: string): Promise<Job[]> {
    return [...this.queue(queue).values()]
      .filter((job) => job.state === status)
      .map(snapshotJob);
  }
  async getAllJobs(queue: string): Promise<Job[]> {
    return [...this.queue(queue).values()].map(snapshotJob);
  }
  async cleanJobs(
    queue: string,
    grace: number,
    status: string,
  ): Promise<number> {
    if (!Number.isFinite(grace) || grace < 0)
      throw new Error("Grace must be nonnegative");
    const jobs = this.queue(queue);
    let count = 0;
    for (const [id, job] of jobs)
      if (
        job.state === status &&
        Date.now() - (job.finishedOn ?? job.timestamp) >= grace
      ) {
        jobs.delete(id);
        count++;
      }
    return count;
  }

  async publish(stream: string, message: Message): Promise<string> {
    if (!this.streams.has(stream)) this.streams.set(stream, []);
    if (!this.streamEmitters.has(stream))
      this.streamEmitters.set(stream, new EventEmitter());
    const offset = (this.sequence.get(stream) ?? -1) + 1;
    this.sequence.set(stream, offset);
    const stored = copyMessage(message);
    stored.offset = offset;
    stored.id = `${String(Date.now()).padStart(16, "0")}-${String(offset).padStart(16, "0")}`;
    this.streams.get(stream)!.push(stored);
    this.streamEmitters.get(stream)!.emit("message", stored);
    this.groups.notify(stream);
    return stored.id;
  }
  async subscribe(
    stream: string,
    handler: MessageHandler<any>,
    options: SubscribeOptions = {},
  ): Promise<Subscription> {
    if (!this.streamEmitters.has(stream))
      this.streamEmitters.set(stream, new EventEmitter());
    let active = true,
      chain = Promise.resolve();
    const wrapper = (message: Message) => {
      chain = chain
        .then(async () => {
          if (active) await handler(copyMessage(message));
        })
        .catch(() => undefined);
    };
    const emitter = this.streamEmitters.get(stream)!;
    emitter.on("message", wrapper);
    if (options.fromBeginning)
      for (const message of this.streams.get(stream) ?? []) wrapper(message);
    return {
      unsubscribe: async () => {
        active = false;
        emitter.off("message", wrapper);
      },
    };
  }
  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: MessageHandler<any>,
    options: ConsumerOptions = { groupId: group },
  ): Promise<Subscription> {
    return this.groups.subscribe(stream, group, consumer, handler, options);
  }
  async createConsumerGroup(stream: string, group: string): Promise<void> {
    this.groups.create(stream, group);
  }
  async getMessages(
    stream: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<Message[]> {
    if (count !== undefined && (!Number.isInteger(count) || count < 0))
      throw new Error("count must be nonnegative");
    const result = (this.streams.get(stream) ?? []).filter(
      (message) =>
        (start === "-" || message.id >= start) &&
        (end === "+" || message.id <= end),
    );
    return result.slice(0, count ?? result.length).map(copyMessage);
  }
  async trimStream(stream: string, strategy: TrimStrategy): Promise<number> {
    for (const value of [strategy.maxLength, strategy.maxAgeSeconds])
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error("Retention must be nonnegative");
    if (
      strategy.maxLength !== undefined &&
      !Number.isInteger(strategy.maxLength)
    )
      throw new Error("maxLength must be an integer");
    const original = this.streams.get(stream) ?? [];
    let retained = original.filter(
      (message) =>
        strategy.maxAgeSeconds === undefined ||
        Date.now() - message.timestamp < strategy.maxAgeSeconds * 1000,
    );
    if (strategy.maxLength !== undefined)
      retained =
        strategy.maxLength === 0 ? [] : retained.slice(-strategy.maxLength);
    this.streams.set(stream, retained);
    return original.length - retained.length;
  }

  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution,
  ): Promise<void> {
    this.workflowStates.set(workflowId, structuredClone(state));
  }

  async loadWorkflowState(
    workflowId: string,
  ): Promise<WorkflowExecution | null> {
    return structuredClone(this.workflowStates.get(workflowId) ?? null);
  }

  async getQueueStats(queue: string): Promise<QueueStats> {
    const stats: QueueStats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
    for (const job of this.queue(queue).values()) stats[job.state]++;
    return stats;
  }

  async getStreamInfo(streamName: string): Promise<StreamInfo> {
    const length = this.streams.get(streamName)?.length || 0;
    return {
      name: streamName,
      length,
      groups: this.groups.count(streamName),
      lag: this.groups.lag(streamName),
    };
  }

  async cleanup(): Promise<void> {
    this.groups.close();
    this.sequence.clear();
    this.queues.clear();
    this.streams.clear();
    this.workflowStates.clear();
    this.streamEmitters.clear();
  }
}
