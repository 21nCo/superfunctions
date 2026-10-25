import { randomUUID } from "node:crypto";
import { mutateWorkflow, validateWorkflowMutation, type WorkflowMutation } from '../storage/workflow-control.js';
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
import { partitionFor, validatePartitions } from "../stream/partition.js";
import { EventEmitter } from "eventemitter3";

export class MemoryAdapter implements FlowAdapter {
  private queues = new Map<string, Map<string, Job>>();
  private streams: Map<string, Message[]> = new Map();
  private streamEmitters: Map<string, EventEmitter> = new Map();
  private partitionPolicies = new Map<string, number | null>();
  private sequence = new Map<string, number>();
  private groups = new MemoryConsumerGroups(
    (stream) => this.streams.get(stream) ?? [],
    (stream) => this.partitionPolicies.get(stream) ?? undefined,
  );
  protected workflowStates: Map<string, WorkflowExecution> = new Map();
  private queue(queue: string): Map<string, Job> {
    if (!this.queues.has(queue)) this.queues.set(queue, new Map());
    return this.queues.get(queue)!;
  }
  async createJob(queue: string, job: Job): Promise<Job> {
    const jobs = this.queue(queue);
    const existing = jobs.get(job.id) ?? (job.deduplicationId === undefined ? undefined :
      [...jobs.values()].find(value => value.deduplicationId === job.deduplicationId && !["completed", "failed"].includes(value.state)));
    if (existing) return snapshotJob(existing);
    // enqueue has no suspension before insertion, preserving the atomic boundary.
    await this.enqueue(queue, job);
    return snapshotJob(jobs.get(job.id)!);
  }
  async enqueue(queue: string, job: Job): Promise<string> {
    this.assertLease(this.queue(queue).get(job.id), job.lease?.token);
    if (job.deduplicationId !== undefined && [...this.queue(queue).values()].some(other => other.id !== job.id && other.deduplicationId === job.deduplicationId && !["completed", "failed"].includes(other.state)))
      throw new Error("Active job already owns deduplication key");
    const value = snapshotJob(job);
    // Keep the internal object shape compact; public snapshots omit undefined leases.
    value.lease = undefined;
    value.state = (value.opts.delay ?? 0) > 0 ? "delayed" : "waiting";
    value.delay = value.opts.delay ?? 0;
    value.timestamp = Date.now();
    // Requeue is a new insertion; ordinary saveJob keeps the existing position.
    this.queue(queue).delete(value.id);
    this.queue(queue).set(value.id, value);
    return value.id;
  }
  async dequeue(queue: string, name?: string, leaseDuration = 30_000): Promise<Job | null> {
    const jobs = this.queue(queue);
    const now = Date.now();
    let ready: Job | undefined;
    // Map iteration is insertion ordered even when clocks tie or move backwards.
    // Priority wins, then LIFO entries precede FIFO (as in the Redis adapter).
    // Among equal classes, keep the first FIFO or replace with the last LIFO.
    for (const job of jobs.values()) {
      if ((name && job.name !== name) ||
          !(job.state === "waiting" || (job.state === "delayed" && job.timestamp + job.delay <= now)) ||
          !(job.opts.waitFor ?? []).every(id => jobs.get(id)?.state === "completed")) continue;
      const priority = job.opts.priority ?? 0;
      const selectedPriority = ready?.opts.priority ?? 0;
      if (!ready || priority > selectedPriority ||
          (priority === selectedPriority && job.opts.lifo)) ready = job;
    }
    if (!ready) return null;
    ready.lease = { token: randomUUID(), expiresAt: Date.now() + leaseDuration };
    ready.state = "active";
    ready.processedOn = Date.now();
    return snapshotJob(ready);
  }
  async saveJob(queue: string, job: Job): Promise<void> {
    const jobs = this.queue(queue);
    const current = jobs.get(job.id);
    this.assertLease(current, job.lease?.token);
    if (!current) throw new Error("Job not found");
    const value = snapshotJob(job);
    // Reuse the private immutable ID already shared with the Map key.
    value.id = current.id;
    if (["completed", "failed"].includes(value.state)) value.lease = undefined;
    else if (value.lease) value.lease = structuredClone(current.lease);
    jobs.set(value.id, value);
  }
  private assertLease(current: Job | undefined, token?: string) {
    if (current?.lease && (current.lease.token !== token || current.lease.expiresAt <= Date.now()))
      throw new Error("Job lease lost");
    if (!current?.lease && token) throw new Error("Job lease lost");
  }
  async renewJobLease(queue: string, id: string, token: string, duration: number): Promise<boolean> {
    const job = this.queue(queue).get(id);
    if (job?.state !== "active" || job.lease?.token !== token || job.lease.expiresAt <= Date.now()) return false;
    job.lease.expiresAt = Date.now() + duration;
    return true;
  }
  async recoverStalledJobs(queue: string, maxStalledCount: number): Promise<Job[]> {
    const recovered: Job[] = [];
    for (const job of this.queue(queue).values()) {
      if (job.state !== "active" || !job.lease || job.lease.expiresAt > Date.now()) continue;
      job.lease = undefined;
      job.stalledCount = (job.stalledCount ?? 0) + 1;
      job.state = job.stalledCount > maxStalledCount ? "failed" : "waiting";
      if (job.state === "failed") { job.failedReason = "Job exceeded maximum stalled count"; job.finishedOn = Date.now(); }
      recovered.push(snapshotJob(job));
    }
    return recovered;
  }
  async removeJob(queue: string, id: string): Promise<void> {
    this.queue(queue).delete(id);
  }
  async ack(queue: string, id: string, token?: string): Promise<void> {
    const job = this.queue(queue).get(id);
    this.assertLease(job, token);
    if (job && job.state !== "failed") {
      job.state = "completed";
      job.lease = undefined;
      job.finishedOn ??= Date.now();
    }
  }
  async nack(queue: string, id: string, requeue = true, token?: string): Promise<void> {
    const job = this.queue(queue).get(id);
    this.assertLease(job, token);
    if (job) {
      job.lease = undefined;
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

  async configureStream(stream: string, partitions?: number): Promise<number | undefined> {
    const current = this.partitionPolicies.get(stream);
    if (partitions === undefined) return current ?? undefined;
    validatePartitions(partitions);
    if (this.partitionPolicies.has(stream) && current !== partitions)
      throw new Error("Stream partition policy is immutable; migration required");
    if (!this.partitionPolicies.has(stream) && (this.sequence.has(stream) || this.groups.count(stream)))
      throw new Error("Legacy stream partition migration required before configuration");
    this.partitionPolicies.set(stream, partitions);
    return partitions;
  }
  async publish(stream: string, message: Message): Promise<string> {
    const partitions = this.partitionPolicies.get(stream);
    if (partitions == null && message.partition !== undefined)
      throw new Error("Explicit partition requires configured stream partitioning");
    const partition = partitions == null ? undefined : partitionFor(partitions, message.id, message.key, message.partition);
    if (!this.partitionPolicies.has(stream)) this.partitionPolicies.set(stream, null);
    if (!this.streams.has(stream)) this.streams.set(stream, []);
    if (!this.streamEmitters.has(stream))
      this.streamEmitters.set(stream, new EventEmitter());
    const offset = (this.sequence.get(stream) ?? -1) + 1;
    this.sequence.set(stream, offset);
    const stored = copyMessage(message);
    stored.offset = offset;
    stored.partition = partition;
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
    if (!this.partitionPolicies.has(stream)) this.partitionPolicies.set(stream, null);
    return this.groups.subscribe(stream, group, consumer, handler, options);
  }
  async createConsumerGroup(stream: string, group: string): Promise<void> {
    if (!this.partitionPolicies.has(stream)) this.partitionPolicies.set(stream, null);
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
    this.groups.trim(stream);
    return original.length - retained.length;
  }

  async mutateWorkflowState(id: string, change: WorkflowMutation): Promise<WorkflowExecution | null> {
    validateWorkflowMutation(change, id);
    const next = mutateWorkflow(this.workflowStates.get(id) ?? null, change, Date.now());
    if (next) this.workflowStates.set(id, next);
    return structuredClone(next);
  }
  async saveWorkflowState(
    workflowId: string,
    state: WorkflowExecution,
  ): Promise<void> {
    if (this.workflowStates.get(workflowId)?.revision !== undefined) throw new Error('Workflow requires a revision-checked mutation');
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
      partitions: this.partitionPolicies.get(streamName) ?? undefined,
      length,
      groups: this.groups.count(streamName),
      lag: this.groups.lag(streamName),
    };
  }

  async cleanup(): Promise<void> {
    this.groups.close();
    this.sequence.clear();
    this.partitionPolicies.clear();
    this.queues.clear();
    this.streams.clear();
    this.workflowStates.clear();
    this.streamEmitters.clear();
  }
}
