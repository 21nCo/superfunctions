import {
  defineAdminCapability,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationDefinition,
  type AdminResourceDefinition,
} from "@superfunctions/admin";
import type {
  FlowFnAcceptedOutput,
  FlowFnCleanDeadLettersInput,
  FlowFnCleanDeadLettersOutput,
  FlowFnDeadLetterListOutput,
  FlowFnDeadLetterOutput,
  FlowFnDeleteDeadLetterInput,
  FlowFnDeleteDeadLetterOutput,
  FlowFnEnqueueJobInput,
  FlowFnEventListOutput,
  FlowFnGetDeadLetterInput,
  FlowFnGetJobInput,
  FlowFnGetQueueInput,
  FlowFnGetWorkerInput,
  FlowFnJobListOutput,
  FlowFnJobOutput,
  FlowFnListDeadLettersInput,
  FlowFnListEventsInput,
  FlowFnListJobsInput,
  FlowFnListQueuesInput,
  FlowFnListWorkersInput,
  FlowFnQueueActionInput,
  FlowFnQueueListOutput,
  FlowFnQueueOutput,
  FlowFnRedriveDeadLetterInput,
  FlowFnRedriveDeadLetterOutput,
  FlowFnWorkerActionInput,
  FlowFnWorkerListOutput,
  FlowFnWorkerOutput,
} from "./types.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const integerSchema = { type: "integer", minimum: 0 } as const;
const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: 200,
  default: 50,
} as const;
const offsetSchema = { type: "integer", minimum: 0, default: 0 } as const;
const jsonSchema: AdminJsonSchema = {};

const queueStatsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    waiting: integerSchema,
    active: integerSchema,
    completed: integerSchema,
    failed: integerSchema,
    delayed: integerSchema,
    paused: integerSchema,
  },
  required: ["waiting", "active", "completed", "failed", "delayed", "paused"],
  additionalProperties: false,
};

const queueSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema, name: stringSchema, stats: queueStatsSchema },
  required: ["id", "name", "stats"],
  additionalProperties: false,
};

const jobOptionsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    priority: { type: "number" },
    delay: integerSchema,
    attempts: { type: "integer", minimum: 1 },
    lifo: { type: "boolean" },
    timeout: integerSchema,
    removeOnComplete: { type: ["boolean", "integer"] },
    removeOnFail: { type: ["boolean", "integer"] },
    stackTraceLimit: integerSchema,
    jobId: stringSchema,
    preventDuplicates: { type: "boolean" },
    deduplicationKey: stringSchema,
    waitFor: { type: "array", items: stringSchema, uniqueItems: true },
    backoff: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["fixed", "exponential", "custom"] },
        delay: integerSchema,
        maxDelay: integerSchema,
      },
      required: ["type", "delay"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const jobSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    queue: stringSchema,
    name: stringSchema,
    data: jsonSchema,
    opts: jobOptionsSchema,
    state: {
      type: "string",
      enum: ["waiting", "active", "completed", "failed", "delayed", "paused"],
    },
    progress: { type: "number", minimum: 0 },
    returnvalue: jsonSchema,
    timestamp: integerSchema,
    processedOn: integerSchema,
    finishedOn: integerSchema,
    delay: integerSchema,
    logs: { type: "array", items: { type: "string" } },
    discarded: { type: "boolean" },
    attemptsMade: integerSchema,
    failedReason: { type: "string" },
    stacktrace: { type: "array", items: { type: "string" } },
  },
  required: [
    "id",
    "queue",
    "name",
    "data",
    "opts",
    "state",
    "progress",
    "timestamp",
    "delay",
    "attemptsMade",
  ],
  additionalProperties: false,
};

const workerSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    queues: { type: "array", items: stringSchema, uniqueItems: true },
  },
  required: ["id", "queues"],
  additionalProperties: false,
};

const deadLetterSchema: AdminObjectSchema = {
  ...jobSchema,
  properties: {
    ...jobSchema.properties,
    originalQueue: stringSchema,
    dlqReason: stringSchema,
    dlqTimestamp: integerSchema,
    errors: { type: "array", items: { type: "string" } },
  },
  required: [
    ...(jobSchema.required ?? []),
    "originalQueue",
    "dlqReason",
    "dlqTimestamp",
    "errors",
  ],
};

const eventSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    type: stringSchema,
    aggregateId: stringSchema,
    aggregateType: stringSchema,
    data: jsonSchema,
    metadata: { type: "object", additionalProperties: true },
    timestamp: integerSchema,
    version: { type: "integer", minimum: 1 },
  },
  required: [
    "id",
    "type",
    "aggregateId",
    "aggregateType",
    "data",
    "timestamp",
    "version",
  ],
  additionalProperties: false,
};

function listSchema(item: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: {
      items: { type: "array", items: item },
      nextCursor: { type: "null" },
    },
    required: ["items", "nextCursor"],
    additionalProperties: false,
  };
}

function itemSchema(item: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: { item },
    required: ["item"],
    additionalProperties: false,
  };
}

const pageInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { limit: limitSchema, offset: offsetSchema },
  additionalProperties: false,
};
const idInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema },
  required: ["id"],
  additionalProperties: false,
};
const acceptedOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { accepted: { type: "boolean", const: true } },
  required: ["accepted"],
  additionalProperties: false,
};

export const flowFnAdminResources = [
  {
    id: "queues",
    label: "Queues",
    description: "Queues registered on the environment-owned FlowFn instance.",
    icon: "flowfn:queues",
    risk: "standard",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "name", "stats"],
    searchableFields: ["id", "name"],
    filterableFields: [],
    sortableFields: ["name"],
    sensitiveFields: [],
  },
  {
    id: "jobs",
    label: "Jobs",
    description: "Jobs in the bound FlowFn job store.",
    icon: "flowfn:jobs",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "queue", "name", "state", "timestamp"],
    searchableFields: ["id", "queue", "name"],
    filterableFields: ["queue", "state"],
    sortableFields: ["timestamp"],
    sensitiveFields: [
      "data",
      "returnvalue",
      "failedReason",
      "stacktrace",
      "logs",
    ],
  },
  {
    id: "workers",
    label: "Workers",
    description:
      "Concrete Worker instances explicitly mounted for this environment.",
    icon: "flowfn:workers",
    risk: "standard",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "queues"],
    searchableFields: ["id", "queues"],
    filterableFields: ["queues"],
    sortableFields: ["id"],
    sensitiveFields: [],
  },
  {
    id: "dead-letters",
    label: "Dead Letters",
    description: "Failed jobs in the bound FlowFn DLQ manager.",
    icon: "flowfn:dead-letters",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "originalQueue", "dlqReason", "dlqTimestamp"],
    searchableFields: ["id", "originalQueue", "dlqReason"],
    filterableFields: ["originalQueue"],
    sortableFields: ["dlqTimestamp"],
    sensitiveFields: [
      "data",
      "returnvalue",
      "failedReason",
      "stacktrace",
      "logs",
      "errors",
    ],
  },
  {
    id: "events",
    label: "Events",
    description: "Domain events in the bound FlowFn event log.",
    icon: "flowfn:events",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "id",
    displayFields: [
      "id",
      "type",
      "aggregateId",
      "aggregateType",
      "timestamp",
      "version",
    ],
    searchableFields: ["id", "type", "aggregateId", "aggregateType"],
    filterableFields: [
      "type",
      "aggregateId",
      "aggregateType",
      "timestamp",
      "version",
    ],
    sortableFields: ["timestamp", "version"],
    sensitiveFields: ["data", "metadata"],
  },
] as const satisfies readonly AdminResourceDefinition[];

const listQueues = {
  id: "flowfn.queues.list",
  title: "List queues",
  description: "List queues known to the mounted FlowFn instance.",
  inputSchema: pageInputSchema,
  outputSchema: listSchema(queueSchema),
  route: { method: "GET", path: "/resources/queues" },
  permission: "flowfn.queues.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "optional",
  },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "queues", collection: true },
} as const satisfies AdminOperationDefinition<
  FlowFnListQueuesInput,
  FlowFnQueueListOutput
>;
const getQueue = {
  id: "flowfn.queues.get",
  title: "Get queue",
  description: "Get queue statistics through FlowFn's public Queue API.",
  inputSchema: idInputSchema,
  outputSchema: itemSchema(queueSchema),
  route: { method: "GET", path: "/resources/queues/:id" },
  permission: "flowfn.queues.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "optional",
  },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "queues", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnGetQueueInput,
  FlowFnQueueOutput
>;
function queueAction(id: "pause" | "resume", title: string) {
  const resumesProcessing = id === "resume";
  return {
    id: `flowfn.queues.${id}`,
    title,
    description: `${title} through FlowFn's public Queue API.`,
    inputSchema: idInputSchema,
    outputSchema: acceptedOutputSchema,
    route: { method: "POST", path: `/resources/queues/actions/${id}` },
    permission: `flowfn.queues.${id}`,
    minimumScope: "environment",
    safety: {
      classification: "write",
      idempotent: true,
      requiresConfirmation: resumesProcessing,
      ...(resumesProcessing
        ? {
            confirmation: {
              risk: "high",
              method: "recent-auth",
              reason:
                "Resuming a queue can restart externally visible job effects.",
              maxAgeSeconds: 300,
            } as const,
          }
        : {}),
      audit: "required",
    },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    target: { resource: "queues", idInput: "id" },
  } as const satisfies AdminOperationDefinition<
    FlowFnQueueActionInput,
    FlowFnAcceptedOutput
  >;
}

const listJobsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    queue: stringSchema,
    status: {
      type: "string",
      enum: ["waiting", "active", "completed", "failed", "delayed", "paused"],
    },
    limit: limitSchema,
    offset: offsetSchema,
  },
  required: ["queue"],
  additionalProperties: false,
};
const getJobInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { queue: stringSchema, id: stringSchema },
  required: ["queue", "id"],
  additionalProperties: false,
};
const enqueueJobInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    queue: stringSchema,
    name: stringSchema,
    data: jsonSchema,
    options: jobOptionsSchema,
  },
  required: ["queue", "name", "data"],
  additionalProperties: false,
};
const jobRedaction = {
  inputFields: ["data"],
  outputFields: ["data", "returnvalue", "failedReason", "stacktrace", "logs"],
} as const;
const listJobs = {
  id: "flowfn.jobs.list",
  title: "List jobs",
  description: "List jobs through the mounted FlowFn JobStorage.",
  inputSchema: listJobsInputSchema,
  outputSchema: listSchema(jobSchema),
  route: { method: "GET", path: "/resources/jobs" },
  permission: "flowfn.jobs.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "required",
  },
  redaction: jobRedaction,
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "jobs", collection: true },
} as const satisfies AdminOperationDefinition<
  FlowFnListJobsInput,
  FlowFnJobListOutput
>;
const getJob = {
  id: "flowfn.jobs.get",
  title: "Get job",
  description: "Get one job through the mounted FlowFn JobStorage.",
  inputSchema: getJobInputSchema,
  outputSchema: itemSchema(jobSchema),
  route: { method: "GET", path: "/resources/jobs/:id" },
  permission: "flowfn.jobs.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "required",
  },
  redaction: jobRedaction,
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "jobs", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnGetJobInput,
  FlowFnJobOutput
>;
const enqueueJob = {
  id: "flowfn.jobs.enqueue",
  title: "Enqueue job",
  description:
    "Enqueue and persist a job through the mounted FlowFn Queue and JobStorage.",
  inputSchema: enqueueJobInputSchema,
  outputSchema: itemSchema(jobSchema),
  route: { method: "POST", path: "/resources/jobs/actions/enqueue" },
  permission: "flowfn.jobs.enqueue",
  minimumScope: "environment",
  safety: {
    classification: "write",
    idempotent: true,
    requiresConfirmation: true,
    confirmation: {
      risk: "high",
      method: "explicit",
      reason:
        "Enqueueing schedules a job whose worker may perform external side effects.",
      maxAgeSeconds: 300,
    },
    audit: "required",
  },
  redaction: jobRedaction,
  mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  target: { resource: "jobs", collection: true },
} as const satisfies AdminOperationDefinition<
  FlowFnEnqueueJobInput,
  FlowFnJobOutput
>;

const listWorkers = {
  id: "flowfn.workers.list",
  title: "List workers",
  description: "List concrete Worker instances mounted in this environment.",
  inputSchema: pageInputSchema,
  outputSchema: listSchema(workerSchema),
  route: { method: "GET", path: "/resources/workers" },
  permission: "flowfn.workers.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "optional",
  },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "workers", collection: true },
} as const satisfies AdminOperationDefinition<
  FlowFnListWorkersInput,
  FlowFnWorkerListOutput
>;
const getWorker = {
  id: "flowfn.workers.get",
  title: "Get worker",
  description: "Get one explicitly mounted Worker instance.",
  inputSchema: idInputSchema,
  outputSchema: itemSchema(workerSchema),
  route: { method: "GET", path: "/resources/workers/:id" },
  permission: "flowfn.workers.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "optional",
  },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "workers", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnGetWorkerInput,
  FlowFnWorkerOutput
>;
const runWorker = {
  id: "flowfn.workers.run",
  title: "Run worker",
  description: "Start an explicitly mounted FlowFn Worker.",
  inputSchema: idInputSchema,
  outputSchema: acceptedOutputSchema,
  route: { method: "POST", path: "/resources/workers/actions/run" },
  permission: "flowfn.workers.run",
  minimumScope: "environment",
  safety: {
    classification: "write",
    idempotent: true,
    requiresConfirmation: true,
    confirmation: {
      risk: "high",
      method: "recent-auth",
      reason:
        "Starting a worker can execute queued jobs with external effects.",
      maxAgeSeconds: 300,
    },
    audit: "required",
  },
  mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  target: { resource: "workers", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnWorkerActionInput,
  FlowFnAcceptedOutput
>;
const closeWorker = {
  id: "flowfn.workers.close",
  title: "Close worker",
  description:
    "Close a mounted Worker and its active queues after explicit confirmation.",
  inputSchema: idInputSchema,
  outputSchema: acceptedOutputSchema,
  route: { method: "POST", path: "/resources/workers/actions/close" },
  permission: "flowfn.workers.close",
  minimumScope: "environment",
  safety: {
    classification: "destructive",
    idempotent: true,
    requiresConfirmation: true,
    confirmation: {
      risk: "high",
      method: "explicit",
      reason: "Closing a worker stops processing on its active queues.",
    },
    audit: "required",
  },
  mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  target: { resource: "workers", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnWorkerActionInput,
  FlowFnAcceptedOutput
>;

const listDeadLettersInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { queue: stringSchema, limit: limitSchema, offset: offsetSchema },
  additionalProperties: false,
};
const reasonInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["id", "reason"],
  additionalProperties: false,
};
const cleanDlqInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    maxAgeMs: { type: "integer", minimum: 0 },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["maxAgeMs", "reason"],
  additionalProperties: false,
};
const dlqRedaction = {
  outputFields: [
    "data",
    "returnvalue",
    "failedReason",
    "stacktrace",
    "logs",
    "errors",
  ],
} as const;
const listDeadLetters = {
  id: "flowfn.dead-letters.list",
  title: "List dead letters",
  description: "List failed jobs through the mounted FlowFn DLQ manager.",
  inputSchema: listDeadLettersInputSchema,
  outputSchema: listSchema(deadLetterSchema),
  route: { method: "GET", path: "/resources/dead-letters" },
  permission: "flowfn.dead-letters.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "required",
  },
  redaction: dlqRedaction,
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "dead-letters", collection: true },
} as const satisfies AdminOperationDefinition<
  FlowFnListDeadLettersInput,
  FlowFnDeadLetterListOutput
>;
const getDeadLetter = {
  id: "flowfn.dead-letters.get",
  title: "Get dead letter",
  description: "Get one failed job through the mounted FlowFn DLQ manager.",
  inputSchema: idInputSchema,
  outputSchema: itemSchema(deadLetterSchema),
  route: { method: "GET", path: "/resources/dead-letters/:id" },
  permission: "flowfn.dead-letters.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "required",
  },
  redaction: dlqRedaction,
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "dead-letters", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnGetDeadLetterInput,
  FlowFnDeadLetterOutput
>;
const redriveDeadLetter = {
  id: "flowfn.dead-letters.redrive",
  title: "Redrive dead letter",
  description:
    "Remove one DLQ job and re-enqueue it on its original FlowFn queue.",
  inputSchema: idInputSchema,
  outputSchema: {
    type: "object",
    properties: { accepted: { type: "boolean", const: true }, item: jobSchema },
    required: ["accepted", "item"],
    additionalProperties: false,
  },
  route: { method: "POST", path: "/resources/dead-letters/actions/redrive" },
  permission: "flowfn.dead-letters.redrive",
  minimumScope: "environment",
  safety: {
    classification: "write",
    idempotent: true,
    requiresConfirmation: true,
    confirmation: {
      risk: "high",
      method: "recent-auth",
      reason: "Redriving a failed job can repeat external effects.",
      maxAgeSeconds: 300,
    },
    audit: "required",
  },
  redaction: dlqRedaction,
  mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  target: { resource: "dead-letters", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnRedriveDeadLetterInput,
  FlowFnRedriveDeadLetterOutput
>;
const deleteDeadLetter = {
  id: "flowfn.dead-letters.delete",
  title: "Delete dead letter",
  description: "Permanently delete one failed job from the FlowFn DLQ.",
  inputSchema: reasonInputSchema,
  outputSchema: {
    type: "object",
    properties: {
      accepted: { type: "boolean", const: true },
      id: stringSchema,
    },
    required: ["accepted", "id"],
    additionalProperties: false,
  },
  route: { method: "POST", path: "/resources/dead-letters/actions/delete" },
  permission: "flowfn.dead-letters.delete",
  minimumScope: "environment",
  safety: {
    classification: "destructive",
    idempotent: true,
    requiresConfirmation: true,
    confirmation: {
      risk: "critical",
      method: "mfa",
      reason: "Deleting a dead letter permanently removes failed-job evidence.",
      maxAgeSeconds: 300,
    },
    audit: "required",
  },
  mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  target: { resource: "dead-letters", idInput: "id" },
} as const satisfies AdminOperationDefinition<
  FlowFnDeleteDeadLetterInput,
  FlowFnDeleteDeadLetterOutput
>;
const cleanDeadLetters = {
  id: "flowfn.dead-letters.clean",
  title: "Clean dead letters",
  description: "Permanently remove DLQ jobs older than a confirmed age.",
  inputSchema: cleanDlqInputSchema,
  outputSchema: {
    type: "object",
    properties: {
      accepted: { type: "boolean", const: true },
      removed: integerSchema,
    },
    required: ["accepted", "removed"],
    additionalProperties: false,
  },
  route: { method: "POST", path: "/resources/dead-letters/actions/clean" },
  permission: "flowfn.dead-letters.clean",
  minimumScope: "environment",
  safety: {
    classification: "destructive",
    idempotent: true,
    requiresConfirmation: true,
    confirmation: {
      risk: "critical",
      method: "mfa",
      reason: "DLQ cleanup permanently removes multiple failed-job records.",
      maxAgeSeconds: 300,
    },
    audit: "required",
  },
  mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  target: { resource: "dead-letters", idInput: "maxAgeMs" },
} as const satisfies AdminOperationDefinition<
  FlowFnCleanDeadLettersInput,
  FlowFnCleanDeadLettersOutput
>;

const listEventsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    aggregateId: stringSchema,
    aggregateType: stringSchema,
    types: { type: "array", items: stringSchema, uniqueItems: true },
    fromVersion: { type: "integer", minimum: 1 },
    toVersion: { type: "integer", minimum: 1 },
    fromTimestamp: integerSchema,
    toTimestamp: integerSchema,
    limit: limitSchema,
    offset: offsetSchema,
  },
  additionalProperties: false,
};
const listEvents = {
  id: "flowfn.events.list",
  title: "List events",
  description:
    "Query the mounted FlowFn EventLog without bypassing its filter semantics.",
  inputSchema: listEventsInputSchema,
  outputSchema: listSchema(eventSchema),
  route: { method: "GET", path: "/resources/events" },
  permission: "flowfn.events.read",
  minimumScope: "environment",
  safety: {
    classification: "read",
    idempotent: true,
    requiresConfirmation: false,
    audit: "required",
  },
  redaction: { outputFields: ["data", "metadata"] },
  mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  target: { resource: "events", collection: true },
} as const satisfies AdminOperationDefinition<
  FlowFnListEventsInput,
  FlowFnEventListOutput
>;

export const flowFnAdminOperations = [
  listQueues,
  getQueue,
  queueAction("pause", "Pause queue"),
  queueAction("resume", "Resume queue"),
  listJobs,
  getJob,
  enqueueJob,
  listWorkers,
  getWorker,
  runWorker,
  closeWorker,
  listDeadLetters,
  getDeadLetter,
  redriveDeadLetter,
  deleteDeadLetter,
  cleanDeadLetters,
  listEvents,
] as const;

export type FlowFnAdminOperationId =
  (typeof flowFnAdminOperations)[number]["id"];

export const flowFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "flowfn",
  displayName: "FlowFn",
  version: "1.0.0",
  description:
    "Environment-scoped operations backed by FlowFn's public queue, worker, job-storage, DLQ, and event-log APIs.",
  category: "orchestration",
  availability: "required-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: flowFnAdminResources,
  navigation: [
    {
      id: "flowfn",
      label: "FlowFn",
      path: "/modules/flowfn",
      icon: "flowfn",
      description: "Operate one environment-owned FlowFn deployment.",
      order: 100,
    },
  ],
  operations: flowFnAdminOperations,
});

export const flowFnAdminSchemas = {
  queue: queueSchema,
  job: jobSchema,
  worker: workerSchema,
  deadLetter: deadLetterSchema,
  event: eventSchema,
} as const;
