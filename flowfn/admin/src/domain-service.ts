import type { DLQJob, Job } from "@flowfn/core";
import { AdminError, type AdminOperationContext } from "@superfunctions/admin";
import type {
  FlowFnAdminDeadLetter,
  FlowFnAdminEvent,
  FlowFnAdminJob,
  FlowFnAdminService,
  FlowFnAdminWorker,
  FlowFnDomainAdminServiceOptions,
} from "./types.js";

function toJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(toJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== "function")
      .map(([key, item]) => [key, toJson(item)]),
  );
}

function page<T>(items: T[], limit = 50, offset = 0): { items: T[]; nextCursor: null } {
  return { items: items.slice(offset, offset + limit), nextCursor: null };
}

function adminJob(queue: string, job: Job): FlowFnAdminJob {
  return { ...(toJson(job) as Omit<FlowFnAdminJob, "queue">), queue };
}

function adminDeadLetter(job: DLQJob): FlowFnAdminDeadLetter {
  return { ...(toJson(job) as Omit<FlowFnAdminDeadLetter, "queue">), queue: job.originalQueue };
}

function requireIdempotency(context: AdminOperationContext): string {
  if (!context.idempotencyKey) {
    throw new AdminError("precondition_failed", "FlowFn mutations require an idempotency key.");
  }
  return context.idempotencyKey;
}

/**
 * Composes the public FlowFn contracts supplied by one deployed environment.
 * The binding does not reach into an adapter, Worker, DLQ, JobStorage, or
 * EventLog implementation, so those domain components retain their invariants.
 */
export function createFlowFnDomainAdminService(options: FlowFnDomainAdminServiceOptions): FlowFnAdminService {
  const required = ["workspaceId", "projectId", "environmentId", "namespace"] as const;
  for (const key of required) {
    if (!options[key].trim()) throw new AdminError("invalid_argument", `FlowFn admin binding requires ${key}.`);
  }
  const workers = new Map<string, NonNullable<FlowFnDomainAdminServiceOptions["workers"]>[number]>();
  for (const worker of options.workers ?? []) {
    if (!worker.id.trim()) throw new AdminError("invalid_argument", "FlowFn worker bindings require a non-empty id.");
    if (workers.has(worker.id)) throw new AdminError("conflict", `Duplicate FlowFn worker binding: ${worker.id}.`);
    workers.set(worker.id, worker);
  }

  const assertScope = (context: AdminOperationContext): void => {
    const scope = context.scope;
    if (
      scope.workspaceId !== options.workspaceId ||
      scope.projectId !== options.projectId ||
      scope.environmentId !== options.environmentId ||
      scope.namespace !== options.namespace
    ) {
      throw new AdminError("forbidden", "The active scope cannot access this FlowFn environment.");
    }
  };

  const queue = async (id: string) => {
    const names = await options.flow.listQueues();
    if (!names.includes(id)) throw new AdminError("not_found", "The FlowFn queue was not found in the active environment.");
    return options.flow.queue(id);
  };
  const worker = (id: string) => {
    const value = workers.get(id);
    if (!value) throw new AdminError("not_found", "The FlowFn worker was not found in the active environment.");
    return value;
  };
  const deadLetter = async (id: string) => {
    const value = (await options.dlq.getAll()).find((candidate) => candidate.id === id);
    if (!value) throw new AdminError("not_found", "The FlowFn dead letter was not found in the active environment.");
    return value;
  };

  return {
    async listQueues(input, context) {
      assertScope(context);
      const items = await Promise.all((await options.flow.listQueues()).sort().map(async (name) => ({ id: name, name, stats: await options.flow.queue(name).getJobCounts() })));
      return page(items, input.limit, input.offset);
    },
    async getQueue(input, context) {
      assertScope(context);
      const value = await queue(input.id);
      return { item: { id: value.name, name: value.name, stats: await value.getJobCounts() } };
    },
    async pauseQueue(input, context) {
      assertScope(context);
      requireIdempotency(context);
      await (await queue(input.id)).pause();
      return { accepted: true };
    },
    async resumeQueue(input, context) {
      assertScope(context);
      requireIdempotency(context);
      await (await queue(input.id)).resume();
      return { accepted: true };
    },
    async listJobs(input, context) {
      assertScope(context);
      await queue(input.queue);
      const jobs = input.status ? await options.jobs.getByStatus(input.queue, input.status) : await options.jobs.getAll(input.queue);
      return page(jobs.map((job) => adminJob(input.queue, job)), input.limit, input.offset);
    },
    async getJob(input, context) {
      assertScope(context);
      await queue(input.queue);
      const value = await options.jobs.get(input.queue, input.id);
      if (!value) throw new AdminError("not_found", "The FlowFn job was not found in the active environment.");
      return { item: adminJob(input.queue, value) };
    },
    async enqueueJob(input, context) {
      assertScope(context);
      const idempotencyKey = requireIdempotency(context);
      const target = await queue(input.queue);
      const job = await target.add(input.name, input.data, { ...input.options, jobId: input.options?.jobId ?? idempotencyKey });
      await options.jobs.save(input.queue, job);
      return { item: adminJob(input.queue, job) };
    },
    async listWorkers(input, context) {
      assertScope(context);
      const items: FlowFnAdminWorker[] = [...workers.values()].map(({ id, queues }) => ({ id, queues: [...queues] })).sort((a, b) => a.id.localeCompare(b.id));
      return page(items, input.limit, input.offset);
    },
    async getWorker(input, context) {
      assertScope(context);
      const value = worker(input.id);
      return { item: { id: value.id, queues: [...value.queues] } };
    },
    async runWorker(input, context) {
      assertScope(context);
      requireIdempotency(context);
      await worker(input.id).worker.run();
      return { accepted: true };
    },
    async closeWorker(input, context) {
      assertScope(context);
      requireIdempotency(context);
      await worker(input.id).worker.close();
      return { accepted: true };
    },
    async listDeadLetters(input, context) {
      assertScope(context);
      const values = input.queue ? await options.dlq.getByQueue(input.queue) : await options.dlq.getAll();
      return page(values.map(adminDeadLetter), input.limit, input.offset);
    },
    async getDeadLetter(input, context) {
      assertScope(context);
      return { item: adminDeadLetter(await deadLetter(input.id)) };
    },
    async redriveDeadLetter(input, context) {
      assertScope(context);
      requireIdempotency(context);
      const current = await deadLetter(input.id);
      const retried = await options.dlq.retry(input.id);
      const target = options.flow.queue(current.originalQueue);
      const enqueued = await target.add(retried.name, retried.data, { ...retried.opts, jobId: retried.id });
      await options.jobs.save(current.originalQueue, enqueued);
      return { accepted: true, item: adminJob(current.originalQueue, enqueued) };
    },
    async deleteDeadLetter(input, context) {
      assertScope(context);
      requireIdempotency(context);
      await deadLetter(input.id);
      await options.dlq.delete(input.id);
      return { accepted: true, id: input.id };
    },
    async cleanDeadLetters(input, context) {
      assertScope(context);
      requireIdempotency(context);
      return { accepted: true, removed: await options.dlq.clean(input.maxAgeMs) };
    },
    async listEvents(input, context) {
      assertScope(context);
      const events = await options.events.getEvents(input);
      return { items: toJson(events) as FlowFnAdminEvent[], nextCursor: null };
    },
  };
}
