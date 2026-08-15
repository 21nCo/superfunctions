import {
  defineAdminCapability,
  type AdminObjectSchema,
  type AdminOperationDefinition,
} from "@superfunctions/admin";
import type {
  CiFnDownloadArtifactInput,
  CiFnDownloadArtifactOutput,
  CiFnGetJobInput,
  CiFnGetJobOutput,
  CiFnGetRunInput,
  CiFnGetRunOutput,
  CiFnListArtifactsInput,
  CiFnListArtifactsOutput,
  CiFnListJobsInput,
  CiFnListJobsOutput,
  CiFnListLogsInput,
  CiFnListLogsOutput,
  CiFnListRunsInput,
  CiFnListRunsOutput,
  CiFnRetryRunOutput,
  CiFnRunMutationOutput,
  CiFnRunTargetInput,
  CiFnTriggerRunInput,
  CiFnTriggerRunOutput,
} from "./types.js";

function operation<TInput, TOutput>(
  definition: AdminOperationDefinition<TInput, TOutput>,
): AdminOperationDefinition<TInput, TOutput> {
  return definition;
}

const statusSchema = {
  type: "string",
  enum: ["queued", "running", "success", "failure", "cancelled"],
} as const;

const pipelineRefSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    repo: { type: "string", minLength: 1, maxLength: 1000 },
    ref: { type: "string", minLength: 1, maxLength: 1000 },
    configPath: { type: "string", minLength: 1, maxLength: 1000 },
  },
  required: ["repo", "ref"],
  additionalProperties: false,
};

const pipelineRefOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    repo: { type: "string", maxLength: 1000 },
    ref: { type: "string", maxLength: 1000 },
    configPath: { type: "string", maxLength: 1000 },
  },
  required: ["repo", "ref"],
  additionalProperties: false,
};

const stepSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    stepKey: { type: "string" },
    status: { type: "string" },
    startedAt: { type: "string" },
    completedAt: { type: "string" },
  },
  required: ["id", "stepKey", "status"],
  additionalProperties: false,
};

const jobSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    jobKey: { type: "string" },
    status: { type: "string" },
    steps: { type: "array", items: stepSchema },
    startedAt: { type: "string" },
    completedAt: { type: "string" },
  },
  required: ["id", "runId", "jobKey", "status", "steps"],
  additionalProperties: false,
};

const runSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    runId: { type: "string" },
    pipelineRef: pipelineRefOutputSchema,
    trigger: {
      type: "object",
      properties: {
        type: { type: "string" },
        payload: { type: "object", additionalProperties: true },
      },
      required: ["type"],
      additionalProperties: false,
    },
    status: statusSchema,
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    jobs: { type: "array", items: jobSchema },
  },
  required: ["runId", "pipelineRef", "trigger", "status", "createdAt", "updatedAt", "jobs"],
  additionalProperties: false,
};

const runFilterSchema: AdminObjectSchema = {
  type: "object",
  properties: { status: statusSchema },
  additionalProperties: false,
};

const listRunsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    cursor: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    filter: runFilterSchema,
  },
  additionalProperties: false,
};

const listRunsOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: runSchema },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["items", "nextCursor"],
  additionalProperties: false,
};

const idInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
};

const getRunOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: runSchema },
  required: ["item"],
  additionalProperties: false,
};

const runFilterRequiredSchema: AdminObjectSchema = {
  type: "object",
  properties: { runId: { type: "string", minLength: 1 } },
  required: ["runId"],
  additionalProperties: false,
};

const listJobsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { filter: runFilterRequiredSchema },
  required: ["filter"],
  additionalProperties: false,
};

const listJobsOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: jobSchema },
    nextCursor: { type: "null" },
  },
  required: ["items", "nextCursor"],
  additionalProperties: false,
};

const getJobOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: jobSchema },
  required: ["item"],
  additionalProperties: false,
};

const logFilterSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    runId: { type: "string", minLength: 1 },
    jobKey: { type: "string", minLength: 1 },
  },
  required: ["runId", "jobKey"],
  additionalProperties: false,
};

const listLogsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    filter: logFilterSchema,
    cursor: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 5000, default: 1000 },
    tail: { type: "integer", minimum: 1, maximum: 5000 },
  },
  required: ["filter"],
  additionalProperties: false,
};

const logLineSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    jobKey: { type: "string" },
    line: { type: "string" },
    timestamp: { type: "string" },
    stepKey: { type: "string" },
  },
  required: ["id", "runId", "jobKey", "line", "timestamp", "stepKey"],
  additionalProperties: false,
};

const listLogsOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: logLineSchema },
    nextCursor: { type: ["string", "null"] },
    capabilities: {
      type: "object",
      properties: { follow: { type: "boolean" }, download: { type: "boolean" } },
      required: ["follow", "download"],
      additionalProperties: false,
    },
    followIntervalMs: { type: "integer" },
  },
  required: ["items", "nextCursor", "capabilities", "followIntervalMs"],
  additionalProperties: false,
};

const artifactSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    name: { type: "string" },
    fileId: { type: "string" },
    url: { type: "string" },
    signedExternal: { type: "boolean" },
  },
  required: ["id", "runId", "name", "fileId"],
  additionalProperties: false,
};

const listArtifactsOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: artifactSchema },
    nextCursor: { type: "null" },
  },
  required: ["items", "nextCursor"],
  additionalProperties: false,
};

const triggerRunInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    trigger: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["push", "pull_request", "schedule", "workflow_dispatch"],
          default: "workflow_dispatch",
        },
        payload: { type: "object", additionalProperties: true },
      },
      required: ["type"],
      additionalProperties: false,
    },
    pipelineRef: pipelineRefSchema,
    pipelineSpec: { type: "object", additionalProperties: true },
  },
  anyOf: [{ required: ["pipelineRef"] }, { required: ["pipelineSpec"] }],
  additionalProperties: false,
};

const triggerRunOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    runId: { type: "string" },
    status: statusSchema,
    createdAt: { type: "string" },
    operationReference: { type: "string" },
  },
  required: ["accepted", "runId", "status", "createdAt", "operationReference"],
  additionalProperties: false,
};

const runTargetInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["id"],
  additionalProperties: false,
};

const runMutationOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    runId: { type: "string" },
    status: statusSchema,
    operationReference: { type: "string" },
  },
  required: ["accepted", "runId", "status", "operationReference"],
  additionalProperties: false,
};

const retryRunOutputSchema: AdminObjectSchema = {
  ...triggerRunOutputSchema,
  properties: {
    ...triggerRunOutputSchema.properties,
    retriedRunId: { type: "string" },
  },
  required: [...triggerRunOutputSchema.required!, "retriedRunId"],
};

const downloadArtifactInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
  },
  required: ["id", "runId"],
  additionalProperties: false,
};

const downloadArtifactOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    artifactId: { type: "string" },
    downloadUrl: { type: "string" },
    signedExternal: { type: "boolean" },
    operationReference: { type: "string" },
  },
  required: ["accepted", "artifactId", "downloadUrl", "signedExternal", "operationReference"],
  additionalProperties: false,
};

const readSafety = {
  classification: "read" as const,
  idempotent: true,
  requiresConfirmation: false,
  audit: "optional" as const,
};

export const ciFnAdminOperations = [
  operation<CiFnListRunsInput, CiFnListRunsOutput>({
    id: "cifn.runs.list",
    title: "List runs",
    description: "List real CiFn control-plane runs in the active installation scope.",
    inputSchema: listRunsInputSchema,
    outputSchema: listRunsOutputSchema,
    route: { method: "GET", path: "/resources/runs" },
    permission: "cifn.runs.read",
    safety: readSafety,
    pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 100 },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "runs", collection: true },
  }),
  operation<CiFnGetRunInput, CiFnGetRunOutput>({
    id: "cifn.runs.get",
    title: "Get run",
    description: "Read one CiFn run with its materialized jobs and steps.",
    inputSchema: idInputSchema,
    outputSchema: getRunOutputSchema,
    route: { method: "GET", path: "/resources/runs/:id" },
    permission: "cifn.runs.read",
    safety: readSafety,
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "runs", idInput: "id" },
  }),
  operation<CiFnListJobsInput, CiFnListJobsOutput>({
    id: "cifn.jobs.list",
    title: "List jobs",
    description: "List materialized jobs for a real CiFn run.",
    inputSchema: listJobsInputSchema,
    outputSchema: listJobsOutputSchema,
    route: { method: "GET", path: "/resources/jobs" },
    permission: "cifn.jobs.read",
    safety: readSafety,
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "jobs", collection: true },
  }),
  operation<CiFnGetJobInput, CiFnGetJobOutput>({
    id: "cifn.jobs.get",
    title: "Get job",
    description: "Read one materialized CiFn job by its run and job key identity.",
    inputSchema: idInputSchema,
    outputSchema: getJobOutputSchema,
    route: { method: "GET", path: "/resources/jobs/:id" },
    permission: "cifn.jobs.read",
    safety: readSafety,
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "jobs", idInput: "id" },
  }),
  operation<CiFnListLogsInput, CiFnListLogsOutput>({
    id: "cifn.logs.list",
    title: "Read job logs",
    description: "Read secret-redacted log lines from the CiFn logging adapter.",
    inputSchema: listLogsInputSchema,
    outputSchema: listLogsOutputSchema,
    route: { method: "GET", path: "/resources/logs" },
    permission: "cifn.logs.read",
    safety: { ...readSafety, audit: "required" },
    pagination: { mode: "cursor", defaultLimit: 1000, maxLimit: 5000 },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    redaction: { outputFields: ["secret", "token", "credential", "password", "authorization"] },
    target: { resource: "logs", collection: true },
  }),
  operation<CiFnListArtifactsInput, CiFnListArtifactsOutput>({
    id: "cifn.artifacts.list",
    title: "List artifacts",
    description: "List artifact metadata retained for a real CiFn run.",
    inputSchema: listJobsInputSchema,
    outputSchema: listArtifactsOutputSchema,
    route: { method: "GET", path: "/resources/artifacts" },
    permission: "cifn.artifacts.read",
    safety: readSafety,
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "artifacts", collection: true },
  }),
  operation<CiFnTriggerRunInput, CiFnTriggerRunOutput>({
    id: "cifn.runs.trigger-run",
    title: "Trigger run",
    description: "Create and enqueue a CiFn run through the control-plane create-run contract.",
    inputSchema: triggerRunInputSchema,
    outputSchema: triggerRunOutputSchema,
    route: { method: "POST", path: "/resources/runs/actions/trigger-run" },
    permission: "cifn.runs.trigger-run",
    safety: { classification: "write", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "Triggering starts a pipeline execution with repository-defined external effects.", maxAgeSeconds: 300 }, audit: "required" },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    redaction: { inputFields: ["pipelineSpec"] },
    target: { resource: "runs", collection: true },
  }),
  operation<CiFnRunTargetInput, CiFnRetryRunOutput>({
    id: "cifn.runs.retry-run",
    title: "Retry run",
    description: "Replay a run from its resolved repository pipeline reference.",
    inputSchema: runTargetInputSchema,
    outputSchema: retryRunOutputSchema,
    route: { method: "POST", path: "/resources/runs/actions/retry-run" },
    permission: "cifn.runs.retry-run",
    safety: { classification: "write", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "Retrying starts another pipeline execution with repository-defined external effects.", maxAgeSeconds: 300 }, audit: "required" },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    target: { resource: "runs", idInput: "id" },
  }),
  operation<CiFnRunTargetInput, CiFnRunMutationOutput>({
    id: "cifn.runs.cancel-run",
    title: "Cancel run",
    description: "Cancel a queued or running CiFn run.",
    inputSchema: runTargetInputSchema,
    outputSchema: runMutationOutputSchema,
    route: { method: "POST", path: "/resources/runs/actions/cancel-run" },
    permission: "cifn.runs.cancel-run",
    safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "critical", method: "recent-auth", reason: "Cancelling interrupts an active or queued pipeline run.", maxAgeSeconds: 300 }, audit: "required" },
    mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    target: { resource: "runs", idInput: "id" },
  }),
  operation<CiFnDownloadArtifactInput, CiFnDownloadArtifactOutput>({
    id: "cifn.artifacts.download-artifact",
    title: "Download artifact",
    description: "Issue a short-lived FileFn download destination for one retained artifact.",
    inputSchema: downloadArtifactInputSchema,
    outputSchema: downloadArtifactOutputSchema,
    route: { method: "POST", path: "/resources/artifacts/actions/download-artifact" },
    permission: "cifn.artifacts.download-artifact",
    safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    target: { resource: "artifacts", idInput: "id" },
  }),
] as const;

export type CiFnAdminOperation = (typeof ciFnAdminOperations)[number];
export type CiFnAdminOperationId = CiFnAdminOperation["id"];

export const ciFnAdminResources = [
  {
    id: "runs",
    label: "Runs",
    description: "Control-plane pipeline executions with materialized jobs and steps.",
    icon: "cifn:runs",
    risk: "standard",
    idField: "runId",
    displayFields: ["runId", "status", "createdAt", "updatedAt"],
    searchableFields: ["runId", "status"],
    filterableFields: ["status"],
    sortableFields: ["createdAt", "updatedAt"],
    sensitiveFields: [],
  },
  {
    id: "jobs",
    label: "Jobs",
    description: "Jobs materialized by a CiFn pipeline run.",
    icon: "cifn:jobs",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "jobKey", "status", "startedAt", "completedAt"],
    searchableFields: ["id", "jobKey", "status"],
    filterableFields: ["runId", "status"],
    sortableFields: ["startedAt", "completedAt"],
    sensitiveFields: [],
  },
  {
    id: "logs",
    label: "Logs",
    description: "Secret-redacted job output from the configured CiFn logging adapter.",
    icon: "cifn:logs",
    risk: "sensitive",
    idField: "id",
    displayFields: ["timestamp", "stepKey", "line"],
    searchableFields: ["line", "stepKey"],
    filterableFields: ["runId", "jobKey"],
    sortableFields: ["timestamp"],
    sensitiveFields: ["secret", "token", "credential", "password", "authorization"],
  },
  {
    id: "artifacts",
    label: "Artifacts",
    description: "FileFn-backed build artifacts retained by a CiFn run.",
    icon: "cifn:artifacts",
    risk: "standard",
    idField: "id",
    displayFields: ["name", "fileId", "runId"],
    searchableFields: ["name", "fileId"],
    filterableFields: ["runId"],
    sortableFields: ["name"],
    sensitiveFields: [],
  },
] as const;

export const ciFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "cifn",
  displayName: "CiFn",
  version: "1.1.0",
  description: "Function-owned operations backed by the CiFn control-plane API.",
  category: "delivery",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [
    { moduleId: "flowfn", required: false, reason: "Production queue adapter" },
    { moduleId: "filefn", required: false, reason: "Production artifact adapter" },
    { moduleId: "watchfn", required: false, reason: "Production log adapter" },
  ],
  resources: ciFnAdminResources,
  navigation: [{
    id: "cifn",
    label: "CiFn",
    path: "/modules/cifn",
    icon: "cifn",
    description: "Operate CiFn in the active scope.",
    order: 100,
  }],
  operations: ciFnAdminOperations,
});

export const ciFnAdminSchemas = {
  run: runSchema,
  job: jobSchema,
  logLine: logLineSchema,
  artifact: artifactSchema,
  listRunsInput: listRunsInputSchema,
  triggerRunInput: triggerRunInputSchema,
} as const;
