import {
  defineAdminCapability,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationDefinition,
  type AdminResourceDefinition,
} from "@superfunctions/admin";
import type {
  ProbeFnCaptureCheckpointInput,
  ProbeFnCaptureCheckpointOutput,
  ProbeFnCaptureDeltaBaselineInput,
  ProbeFnCaptureDeltaBaselineOutput,
  ProbeFnDiffEventDeltaInput,
  ProbeFnDiffEventDeltaOutput,
  ProbeFnExportReportInput,
  ProbeFnExportReportOutput,
  ProbeFnGetCheckpointPathsInput,
  ProbeFnGetCheckpointPathsOutput,
  ProbeFnGetRunPathsInput,
  ProbeFnGetRunPathsOutput,
  ProbeFnGetSessionInput,
  ProbeFnInitializeSessionInput,
  ProbeFnMarkSessionRunningInput,
  ProbeFnSessionOutput,
  ProbeFnSessionTargetInput,
} from "./types.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const nullableStringSchema: AdminJsonSchema = { type: ["string", "null"] };
const browserSchema = { type: "string", enum: ["chromium", "firefox", "webkit"] } as const;
const modeSchema = {
  type: "string",
  enum: ["debug", "design-review", "visual-regression", "mixed"],
} as const;
const statusSchema = {
  type: "string",
  enum: ["starting", "running", "completed", "failed"],
} as const;

const viewportSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  },
  required: ["width", "height"],
  additionalProperties: false,
};

const deterministicSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    viewport: viewportSchema,
    locale: stringSchema,
    timezone: stringSchema,
    colorScheme: { type: "string", enum: ["light", "dark"] },
    reducedMotion: { type: "string", enum: ["reduce", "no-preference"] },
    animationPolicy: { type: "string", enum: ["freeze", "allow"] },
    networkIdleMs: { type: "integer", minimum: 1 },
  },
  required: [
    "enabled",
    "viewport",
    "locale",
    "timezone",
    "colorScheme",
    "reducedMotion",
    "animationPolicy",
    "networkIdleMs",
  ],
  additionalProperties: false,
};

const sessionArtifactsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    manifestPath: stringSchema,
    tracePath: nullableStringSchema,
    storageStatePath: stringSchema,
    reportJsonPath: stringSchema,
    reportMarkdownPath: stringSchema,
    consoleSinkPath: stringSchema,
    pageErrorSinkPath: stringSchema,
    networkSinkPath: stringSchema,
    devServerStdoutSinkPath: stringSchema,
    devServerStderrSinkPath: stringSchema,
  },
  required: ["manifestPath"],
  additionalProperties: false,
};

const sessionSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", const: "1.0" },
    sessionId: stringSchema,
    runId: stringSchema,
    mode: modeSchema,
    browser: browserSchema,
    artifactRoot: stringSchema,
    startedAt: stringSchema,
    endedAt: stringSchema,
    status: statusSchema,
    deterministic: deterministicSchema,
    resolvedUrl: stringSchema,
    artifacts: sessionArtifactsSchema,
  },
  required: [
    "schemaVersion",
    "sessionId",
    "runId",
    "mode",
    "browser",
    "artifactRoot",
    "startedAt",
    "status",
    "deterministic",
    "artifacts",
  ],
  additionalProperties: false,
};

const sessionOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: sessionSchema },
  required: ["item"],
  additionalProperties: false,
};

const eventCountSchema = { type: "integer", minimum: 0 } as const;
const baselineSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    consoleErrors: eventCountSchema,
    pageErrors: eventCountSchema,
    networkFailures: eventCountSchema,
  },
  required: ["consoleErrors", "pageErrors", "networkFailures"],
  additionalProperties: false,
};
const deltaSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    newConsoleErrors: eventCountSchema,
    newPageErrors: eventCountSchema,
    newNetworkFailures: eventCountSchema,
  },
  required: ["newConsoleErrors", "newPageErrors", "newNetworkFailures"],
  additionalProperties: false,
};

const checkpointArtifactSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    checkpointId: stringSchema,
    manifestPath: stringSchema,
    artifacts: { type: "array", items: stringSchema },
    analyzerWarnings: { type: "array", items: { type: "string" } },
    newConsoleErrors: eventCountSchema,
    newPageErrors: eventCountSchema,
    newNetworkFailures: eventCountSchema,
  },
  required: [
    "checkpointId",
    "manifestPath",
    "artifacts",
    "analyzerWarnings",
    "newConsoleErrors",
    "newPageErrors",
    "newNetworkFailures",
  ],
  additionalProperties: false,
};

const runPathsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    runRoot: stringSchema,
    checkpointRoot: stringSchema,
    diffRoot: stringSchema,
    devServerRoot: stringSchema,
    eventRoot: stringSchema,
    sessionManifestPath: stringSchema,
    tracePath: stringSchema,
    reportJsonPath: stringSchema,
    reportMarkdownPath: stringSchema,
  },
  required: [
    "runRoot",
    "checkpointRoot",
    "diffRoot",
    "devServerRoot",
    "eventRoot",
    "sessionManifestPath",
    "tracePath",
    "reportJsonPath",
    "reportMarkdownPath",
  ],
  additionalProperties: false,
};

const checkpointPathsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    root: stringSchema,
    manifestPath: stringSchema,
    screenshotPath: stringSchema,
    domPath: stringSchema,
    axPath: stringSchema,
    layoutPath: stringSchema,
    stylesPath: stringSchema,
  },
  required: ["root", "manifestPath", "screenshotPath", "domPath", "axPath", "layoutPath", "stylesPath"],
  additionalProperties: false,
};

export const probeFnAdminResources = [
  {
    id: "sessions",
    label: "Sessions",
    description: "Read and transition locally persisted ProbeFn sessions.",
    icon: "probefn:sessions",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "sessionId",
    displayFields: ["sessionId", "runId", "status", "startedAt", "endedAt"],
    searchableFields: ["sessionId", "runId"],
    filterableFields: ["status", "browser", "mode"],
    sortableFields: ["startedAt", "endedAt"],
    sensitiveFields: ["resolvedUrl", "storageStatePath", "authorization", "cookie", "token", "password"],
  },
  {
    id: "checkpoints",
    label: "Checkpoints",
    description: "Capture a checkpoint from a configured live ProbeFn source.",
    icon: "probefn:checkpoints",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "checkpointId",
    displayFields: ["checkpointId", "manifestPath"],
    sensitiveFields: ["resolvedUrl", "url", "authorization", "cookie", "token", "password"],
  },
  {
    id: "event-deltas",
    label: "Event deltas",
    description: "Count scoped ProbeFn console, page-error, and network-failure evidence.",
    icon: "probefn:event-deltas",
    risk: "standard",
    minimumScope: "environment",
    idField: "sessionId",
    displayFields: ["sessionId", "consoleErrors", "pageErrors", "networkFailures"],
    sensitiveFields: [],
  },
  {
    id: "reports",
    label: "Reports",
    description: "Export a redacted report through ProbeFn's report service.",
    icon: "probefn:reports",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "reportPath",
    displayFields: ["reportPath", "format", "redactedValueCount"],
    sensitiveFields: ["authorization", "cookie", "token", "password", "storageStatePath"],
  },
  {
    id: "storage",
    label: "Storage paths",
    description: "Project repository-relative artifact paths from the configured ProbeFn store.",
    icon: "probefn:storage",
    risk: "standard",
    minimumScope: "environment",
    idField: "runRoot",
    displayFields: ["runRoot", "checkpointRoot", "reportJsonPath"],
    sensitiveFields: [],
  },
] as const satisfies readonly AdminResourceDefinition[];

export const probeFnAdminActions = [
  { id: "initialize", resource: "sessions" },
  { id: "mark-running", resource: "sessions" },
  { id: "mark-completed", resource: "sessions" },
  { id: "mark-failed", resource: "sessions" },
  { id: "capture", resource: "checkpoints" },
  { id: "capture-baseline", resource: "event-deltas" },
  { id: "diff", resource: "event-deltas" },
  { id: "export", resource: "reports" },
  { id: "get-run-paths", resource: "storage" },
  { id: "get-checkpoint-paths", resource: "storage" },
] as const;

function operation<TInput, TOutput>(
  definition: AdminOperationDefinition<TInput, TOutput>,
): AdminOperationDefinition<TInput, TOutput> {
  return definition;
}

const readSafety = {
  classification: "read",
  idempotent: true,
  requiresConfirmation: false,
  audit: "required",
} as const;
const writeSafety = {
  classification: "write",
  idempotent: true,
  requiresConfirmation: false,
  audit: "required",
} as const;
const sensitiveCaptureSafety = {
  classification: "write",
  idempotent: false,
  requiresConfirmation: true,
  confirmation: {
    risk: "high",
    method: "recent-auth",
    reason: "Checkpoint capture may persist screenshots, DOM, accessibility, layout, and style evidence.",
    maxAgeSeconds: 300,
  },
  audit: "required",
} as const;
const sensitiveExportSafety = {
  classification: "write",
  idempotent: true,
  requiresConfirmation: true,
  confirmation: {
    risk: "high",
    method: "recent-auth",
    reason: "Report export materializes a redacted copy of scoped runtime evidence.",
    maxAgeSeconds: 300,
  },
  audit: "required",
} as const;
const mcpRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const mcpWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const sensitiveOutputFields = ["resolvedUrl", "storageStatePath", "authorization", "cookie", "token", "password"] as const;

const getSessionInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema },
  required: ["id"],
  additionalProperties: false,
};
const initializeInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    sessionId: stringSchema,
    runId: stringSchema,
    mode: modeSchema,
    browser: browserSchema,
    deterministic: deterministicSchema,
    startedAt: stringSchema,
    resolvedUrl: stringSchema,
  },
  required: ["sessionId", "runId", "mode", "browser", "deterministic", "startedAt"],
  additionalProperties: false,
};
const markRunningInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema, resolvedUrl: stringSchema },
  required: ["id"],
  additionalProperties: false,
};
const sessionTargetInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema },
  required: ["id"],
  additionalProperties: false,
};
const captureBaselineInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { sessionId: stringSchema },
  required: ["sessionId"],
  additionalProperties: false,
};
const captureBaselineOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { sessionId: stringSchema, baseline: baselineSchema },
  required: ["sessionId", "baseline"],
  additionalProperties: false,
};
const diffInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { before: baselineSchema, after: baselineSchema },
  required: ["before", "after"],
  additionalProperties: false,
};
const diffOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { delta: deltaSchema },
  required: ["delta"],
  additionalProperties: false,
};
const captureCheckpointInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    sessionId: stringSchema,
    name: stringSchema,
    before: baselineSchema,
    includeStyles: { type: "boolean" },
    includeTrace: { type: "boolean" },
    unstable: { type: "boolean" },
  },
  required: ["sessionId", "name", "before"],
  additionalProperties: false,
};
const captureCheckpointOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { accepted: { type: "boolean", const: true }, item: checkpointArtifactSchema },
  required: ["accepted", "item"],
  additionalProperties: false,
};
const exportReportInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    sessionId: stringSchema,
    format: { type: "string", enum: ["json", "markdown"] },
  },
  required: ["sessionId", "format"],
  additionalProperties: false,
};
const exportReportOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean", const: true },
    sessionId: stringSchema,
    format: { type: "string", enum: ["json", "markdown"] },
    reportPath: stringSchema,
    tracePath: nullableStringSchema,
    redactedValueCount: eventCountSchema,
    warnings: { type: "array", items: { type: "string" } },
    includes: { type: "array", items: stringSchema },
  },
  required: ["accepted", "sessionId", "format", "reportPath", "tracePath", "redactedValueCount", "warnings", "includes"],
  additionalProperties: false,
};
const getRunPathsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { runId: stringSchema },
  required: ["runId"],
  additionalProperties: false,
};
const getRunPathsOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: runPathsSchema },
  required: ["item"],
  additionalProperties: false,
};
const getCheckpointPathsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { runId: stringSchema, name: stringSchema },
  required: ["runId", "name"],
  additionalProperties: false,
};
const getCheckpointPathsOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: checkpointPathsSchema },
  required: ["item"],
  additionalProperties: false,
};

export const probeFnAdminSchemas = {
  session: sessionSchema,
  baseline: baselineSchema,
  delta: deltaSchema,
  checkpoint: checkpointArtifactSchema,
  runPaths: runPathsSchema,
  checkpointPaths: checkpointPathsSchema,
} as const satisfies Record<string, AdminJsonSchema>;

const operations = [
  operation<ProbeFnGetSessionInput, ProbeFnSessionOutput>({
    id: "probefn.sessions.get",
    title: "Get session",
    description: "Read one session from the exact configured environment store.",
    inputSchema: getSessionInputSchema,
    outputSchema: sessionOutputSchema,
    route: { method: "GET", path: "/resources/sessions/:id" },
    permission: "probefn.sessions.read",
    minimumScope: "environment",
    safety: readSafety,
    mcp: mcpRead,
    redaction: { outputFields: sensitiveOutputFields },
    target: { resource: "sessions", idInput: "id" },
  }),
  operation<ProbeFnInitializeSessionInput, ProbeFnSessionOutput>({
    id: "probefn.sessions.initialize",
    title: "Initialize session",
    description: "Create a local run manifest and session state in the configured environment store.",
    inputSchema: initializeInputSchema,
    outputSchema: sessionOutputSchema,
    route: { method: "POST", path: "/resources/sessions/actions/initialize" },
    permission: "probefn.sessions.initialize",
    minimumScope: "environment",
    safety: writeSafety,
    mcp: mcpWrite,
    redaction: { inputFields: ["resolvedUrl"], outputFields: sensitiveOutputFields },
    target: { resource: "sessions", collection: true },
  }),
  operation<ProbeFnMarkSessionRunningInput, ProbeFnSessionOutput>({
    id: "probefn.sessions.mark-running",
    title: "Mark session running",
    description: "Transition a scoped ProbeFn session to running.",
    inputSchema: markRunningInputSchema,
    outputSchema: sessionOutputSchema,
    route: { method: "POST", path: "/resources/sessions/actions/mark-running" },
    permission: "probefn.sessions.write",
    minimumScope: "environment",
    safety: writeSafety,
    mcp: mcpWrite,
    redaction: { inputFields: ["resolvedUrl"], outputFields: sensitiveOutputFields },
    target: { resource: "sessions", idInput: "id" },
  }),
  operation<ProbeFnSessionTargetInput, ProbeFnSessionOutput>({
    id: "probefn.sessions.mark-completed",
    title: "Mark session completed",
    description: "Transition a scoped ProbeFn session to completed.",
    inputSchema: sessionTargetInputSchema,
    outputSchema: sessionOutputSchema,
    route: { method: "POST", path: "/resources/sessions/actions/mark-completed" },
    permission: "probefn.sessions.write",
    minimumScope: "environment",
    safety: writeSafety,
    mcp: mcpWrite,
    redaction: { outputFields: sensitiveOutputFields },
    target: { resource: "sessions", idInput: "id" },
  }),
  operation<ProbeFnSessionTargetInput, ProbeFnSessionOutput>({
    id: "probefn.sessions.mark-failed",
    title: "Mark session failed",
    description: "Transition a scoped ProbeFn session to failed.",
    inputSchema: sessionTargetInputSchema,
    outputSchema: sessionOutputSchema,
    route: { method: "POST", path: "/resources/sessions/actions/mark-failed" },
    permission: "probefn.sessions.write",
    minimumScope: "environment",
    safety: writeSafety,
    mcp: mcpWrite,
    redaction: { outputFields: sensitiveOutputFields },
    target: { resource: "sessions", idInput: "id" },
  }),
  operation<ProbeFnCaptureDeltaBaselineInput, ProbeFnCaptureDeltaBaselineOutput>({
    id: "probefn.event-deltas.capture-baseline",
    title: "Capture event baseline",
    description: "Count the current scoped console, page-error, and network-failure evidence.",
    inputSchema: captureBaselineInputSchema,
    outputSchema: captureBaselineOutputSchema,
    route: { method: "POST", path: "/resources/event-deltas/actions/capture-baseline" },
    permission: "probefn.event-deltas.read",
    minimumScope: "environment",
    safety: readSafety,
    mcp: mcpRead,
    target: { resource: "event-deltas", idInput: "sessionId" },
  }),
  operation<ProbeFnDiffEventDeltaInput, ProbeFnDiffEventDeltaOutput>({
    id: "probefn.event-deltas.diff",
    title: "Diff event baselines",
    description: "Compute non-negative ProbeFn event deltas from two exact counter snapshots.",
    inputSchema: diffInputSchema,
    outputSchema: diffOutputSchema,
    route: { method: "POST", path: "/resources/event-deltas/actions/diff" },
    permission: "probefn.event-deltas.read",
    minimumScope: "environment",
    safety: readSafety,
    mcp: mcpRead,
    target: { resource: "event-deltas", collection: true },
  }),
  operation<ProbeFnCaptureCheckpointInput, ProbeFnCaptureCheckpointOutput>({
    id: "probefn.checkpoints.capture",
    title: "Capture checkpoint",
    description: "Persist an audited checkpoint from the environment's configured live capture source.",
    inputSchema: captureCheckpointInputSchema,
    outputSchema: captureCheckpointOutputSchema,
    route: { method: "POST", path: "/resources/checkpoints/actions/capture" },
    permission: "probefn.checkpoints.capture",
    minimumScope: "environment",
    safety: sensitiveCaptureSafety,
    mcp: { ...mcpWrite, idempotentHint: false },
    redaction: { outputFields: ["url", ...sensitiveOutputFields] },
    target: { resource: "checkpoints", collection: true },
  }),
  operation<ProbeFnExportReportInput, ProbeFnExportReportOutput>({
    id: "probefn.reports.export",
    title: "Export report",
    description: "Generate a redacted JSON or Markdown report for one scoped session.",
    inputSchema: exportReportInputSchema,
    outputSchema: exportReportOutputSchema,
    route: { method: "POST", path: "/resources/reports/actions/export" },
    permission: "probefn.reports.export",
    minimumScope: "environment",
    safety: sensitiveExportSafety,
    mcp: mcpWrite,
    redaction: { outputFields: sensitiveOutputFields },
    target: { resource: "reports", idInput: "sessionId" },
  }),
  operation<ProbeFnGetRunPathsInput, ProbeFnGetRunPathsOutput>({
    id: "probefn.storage.get-run-paths",
    title: "Get run paths",
    description: "Project safe repository-relative paths through the configured ArtifactStore.",
    inputSchema: getRunPathsInputSchema,
    outputSchema: getRunPathsOutputSchema,
    route: { method: "GET", path: "/resources/storage/run-paths" },
    permission: "probefn.storage.read",
    minimumScope: "environment",
    safety: readSafety,
    mcp: mcpRead,
    target: { resource: "storage", idInput: "runId" },
  }),
  operation<ProbeFnGetCheckpointPathsInput, ProbeFnGetCheckpointPathsOutput>({
    id: "probefn.storage.get-checkpoint-paths",
    title: "Get checkpoint paths",
    description: "Project safe checkpoint artifact paths through the configured ArtifactStore.",
    inputSchema: getCheckpointPathsInputSchema,
    outputSchema: getCheckpointPathsOutputSchema,
    route: { method: "GET", path: "/resources/storage/checkpoint-paths" },
    permission: "probefn.storage.read",
    minimumScope: "environment",
    safety: readSafety,
    mcp: mcpRead,
    target: { resource: "storage", idInput: "runId" },
  }),
] as const;

export type ProbeFnAdminOperationId = (typeof operations)[number]["id"];

export const probeFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "probefn",
  displayName: "ProbeFn",
  version: "1.0.0",
  description: "Environment-bound administration for ProbeFn sessions and local evidence artifacts.",
  category: "quality",
  availability: "optional-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: probeFnAdminResources,
  navigation: [
    {
      id: "probefn",
      label: "ProbeFn",
      path: "/modules/probefn",
      icon: "probefn",
      description: "Operate a configured ProbeFn environment.",
      order: 100,
    },
  ],
  operations,
});
