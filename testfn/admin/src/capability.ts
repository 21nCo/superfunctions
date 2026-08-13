import {
  defineAdminCapability,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationDefinition,
  type AdminResourceDefinition,
} from "@superfunctions/admin";

const emptyInputSchema: AdminObjectSchema = {
  type: "object",
  additionalProperties: false,
};

const idInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["id"],
  additionalProperties: false,
};

const summarySchema: AdminObjectSchema = {
  type: "object",
  properties: {
    total: { type: "integer", minimum: 0 },
    passed: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    skipped: { type: "integer", minimum: 0 },
    duration: { type: "number", minimum: 0 },
    coverage: { type: "object", additionalProperties: { type: "number" } },
  },
  required: ["total", "passed", "failed", "skipped", "duration"],
  additionalProperties: false,
};

const resultSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["passed", "failed", "skipped", "timeout"] },
    duration: { type: "number", minimum: 0 },
    hasError: { type: "boolean" },
    artifactTypes: { type: "array", items: { type: "string" } },
  },
  required: ["id", "status", "duration", "hasError", "artifactTypes"],
  additionalProperties: false,
};

const environmentSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    platform: { type: "string" },
    nodeVersion: { type: "string" },
    browser: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        headless: { type: "boolean" },
      },
      required: ["name", "version", "headless"],
      additionalProperties: false,
    },
    ci: { type: "boolean" },
  },
  required: ["platform"],
  additionalProperties: false,
};

const runSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    timestamp: { type: "number" },
    summary: summarySchema,
    results: { type: "array", items: resultSchema },
    environment: environmentSchema,
    branch: { type: "string" },
    commit: { type: "string" },
  },
  required: ["id", "timestamp", "summary", "results"],
  additionalProperties: false,
};

const item = (schema: AdminJsonSchema): AdminObjectSchema => ({
  type: "object",
  properties: { item: schema },
  required: ["item"],
  additionalProperties: false,
});

const list = (schema: AdminJsonSchema): AdminObjectSchema => ({
  type: "object",
  properties: {
    items: { type: "array", items: schema },
    nextCursor: { type: "null" },
  },
  required: ["items", "nextCursor"],
  additionalProperties: false,
});

const listRunsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  additionalProperties: false,
};

const artifactSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["screenshot", "video", "trace", "log"] },
    available: { type: "boolean", const: true },
  },
  required: ["id", "type", "available"],
  additionalProperties: false,
};

const metricsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    successRate: { type: "number", minimum: 0, maximum: 1 },
    avgDuration: { type: "number", minimum: 0 },
    p50Duration: { type: "number", minimum: 0 },
    p95Duration: { type: "number", minimum: 0 },
    p99Duration: { type: "number", minimum: 0 },
    failuresByType: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
  },
  required: ["id", "successRate", "avgDuration", "p50Duration", "p95Duration", "p99Duration", "failuresByType"],
  additionalProperties: false,
};

const flakinessInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 500 },
    windowSize: { type: "integer", minimum: 1, maximum: 100, default: 10 },
  },
  required: ["id"],
  additionalProperties: false,
};

const flakinessSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    testId: { type: "string" },
    flakyScore: { type: "number", minimum: 0, maximum: 1 },
    passRate: { type: "number", minimum: 0, maximum: 1 },
    recentResults: { type: "array", items: { type: "boolean" } },
    recommendation: { type: "string", enum: ["investigate", "quarantine", "stable"] },
  },
  required: ["id", "testId", "flakyScore", "passRate", "recentResults", "recommendation"],
  additionalProperties: false,
};

const trendsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 500 },
    days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
  },
  required: ["id"],
  additionalProperties: false,
};

const trendsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    testId: { type: "string" },
    dataPoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "number" },
          value: { type: "number" },
          status: { type: "string" },
        },
        required: ["timestamp", "value", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["id", "testId", "dataPoints"],
  additionalProperties: false,
};

const regressionsInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    baselineRunId: { type: "string", minLength: 1 },
    currentRunId: { type: "string", minLength: 1 },
  },
  required: ["baselineRunId", "currentRunId"],
  additionalProperties: false,
};

const regressionSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    testId: { type: "string" },
    metric: { type: "string", enum: ["duration", "memory", "coverage"] },
    baseline: { type: "number" },
    current: { type: "number" },
    change: { type: "number" },
    significant: { type: "boolean" },
  },
  required: ["testId", "metric", "baseline", "current", "change", "significant"],
  additionalProperties: false,
};

const visualDiffSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    available: { type: "boolean" },
    sizeBytes: { type: "integer", minimum: 0 },
  },
  required: ["id", "available", "sizeBytes"],
  additionalProperties: false,
};

const screenshotInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9._-]+$" },
    screenshotBase64: { type: "string", minLength: 1, maxLength: 28000000 },
  },
  required: ["id", "screenshotBase64"],
  additionalProperties: false,
};

const updateBaselineInputSchema: AdminObjectSchema = {
  ...screenshotInputSchema,
  properties: {
    ...screenshotInputSchema.properties,
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["id", "screenshotBase64", "reason"],
};

const comparisonSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    passed: { type: "boolean" },
    similarity: { type: "number", minimum: 0, maximum: 1 },
    pixelDiffCount: { type: "integer", minimum: 0 },
    diffPercentage: { type: "number", minimum: 0, maximum: 100 },
    regions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number", minimum: 0 },
          height: { type: "number", minimum: 0 },
          severity: { type: "string", enum: ["minor", "major"] },
        },
        required: ["x", "y", "width", "height", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["id", "passed", "similarity", "pixelDiffCount", "diffPercentage"],
  additionalProperties: false,
};

const cleanupInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", const: "expired" },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["id", "reason"],
  additionalProperties: false,
};

const acceptedSchema: AdminObjectSchema = {
  type: "object",
  properties: { accepted: { type: "boolean", const: true } },
  required: ["accepted"],
  additionalProperties: false,
};

export const testFnAdminResources = [
  { id: "runs", label: "Runs", description: "Persisted TestFn runs in the active project scope.", icon: "testfn:runs", risk: "standard", minimumScope: "project", idField: "id", displayFields: ["id", "timestamp", "summary"], searchableFields: ["id", "branch", "commit"], filterableFields: ["timestamp", "branch"], sortableFields: ["timestamp"], sensitiveFields: [] },
  { id: "artifacts", label: "Artifacts", description: "Redacted metadata for persisted TestFn artifacts.", icon: "testfn:artifacts", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "type", "available"], searchableFields: ["id", "type"], filterableFields: ["type"], sortableFields: [], sensitiveFields: ["buffer", "path"] },
  { id: "analytics", label: "Analytics", description: "Metrics, flakiness, trends, and regression analysis computed by TestFn.", icon: "testfn:analytics", risk: "standard", minimumScope: "project", idField: "id", displayFields: ["id"], searchableFields: ["id"], filterableFields: [], sortableFields: [], sensitiveFields: [] },
  { id: "visual-diffs", label: "Visual Diffs", description: "Visual comparison and diff availability from the configured TestFn visual store.", icon: "testfn:visual-diffs", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "available", "sizeBytes"], searchableFields: ["id"], filterableFields: ["available"], sortableFields: [], sensitiveFields: ["buffer", "diffImage", "screenshotBase64"] },
  { id: "visual-baselines", label: "Visual Baselines", description: "Scope-owned TestFn visual baselines.", icon: "testfn:visual-baselines", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id"], searchableFields: ["id"], filterableFields: [], sortableFields: [], sensitiveFields: ["buffer", "path", "screenshotBase64"] },
] as const satisfies readonly AdminResourceDefinition[];

const readSafety = { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" } as const;
const readMcp = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export const testFnAdminOperations = [
  { id: "testfn.runs.list", title: "List runs", description: "List recent runs from the configured scope-owned TestStorage.", inputSchema: listRunsInputSchema, outputSchema: list(runSchema), route: { method: "GET", path: "/resources/runs" }, permission: "testfn.runs.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "runs", collection: true } },
  { id: "testfn.runs.get", title: "Get run", description: "Get one persisted run from the configured scope-owned TestStorage.", inputSchema: idInputSchema, outputSchema: item(runSchema), route: { method: "GET", path: "/resources/runs/:id" }, permission: "testfn.runs.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "runs", idInput: "id" } },
  { id: "testfn.runs.start", title: "Start run", description: "Execute the configured scope-owned TestRunner and persist its result.", inputSchema: emptyInputSchema, outputSchema: item(runSchema), route: { method: "POST", path: "/resources/runs/actions/start" }, permission: "testfn.runs.start", minimumScope: "project", safety: { classification: "write", idempotent: false, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, target: { resource: "runs", collection: true } },
  { id: "testfn.runs.cleanup", title: "Clean expired runs", description: "Apply the configured TestStorage retention policy to persisted run data.", inputSchema: cleanupInputSchema, outputSchema: acceptedSchema, route: { method: "POST", path: "/resources/runs/actions/cleanup" }, permission: "testfn.runs.cleanup", minimumScope: "project", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason: "Retention cleanup permanently removes expired test evidence.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "runs", idInput: "id" } },
  { id: "testfn.artifacts.get", title: "Get artifact metadata", description: "Get redacted metadata for one persisted artifact without returning bytes or storage paths.", inputSchema: idInputSchema, outputSchema: item(artifactSchema), route: { method: "GET", path: "/resources/artifacts/:id" }, permission: "testfn.artifacts.read", minimumScope: "project", safety: { ...readSafety, audit: "required" }, mcp: readMcp, redaction: { outputFields: ["buffer", "path"] }, target: { resource: "artifacts", idInput: "id" } },
  { id: "testfn.analytics.metrics", title: "Get run metrics", description: "Compute metrics for one run through TestFn AnalyticsEngine.", inputSchema: idInputSchema, outputSchema: item(metricsSchema), route: { method: "GET", path: "/resources/analytics/metrics/:id" }, permission: "testfn.analytics.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "analytics", idInput: "id" } },
  { id: "testfn.analytics.flakiness", title: "Analyze flakiness", description: "Analyze a test result history through TestFn AnalyticsEngine.", inputSchema: flakinessInputSchema, outputSchema: item(flakinessSchema), route: { method: "GET", path: "/resources/analytics/flakiness/:id" }, permission: "testfn.analytics.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "analytics", idInput: "id" } },
  { id: "testfn.analytics.trends", title: "Get test trends", description: "Compute duration and status trends through TestFn AnalyticsEngine.", inputSchema: trendsInputSchema, outputSchema: item(trendsSchema), route: { method: "GET", path: "/resources/analytics/trends/:id" }, permission: "testfn.analytics.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "analytics", idInput: "id" } },
  { id: "testfn.analytics.regressions", title: "Find regressions", description: "Compare two persisted runs through TestFn AnalyticsEngine.", inputSchema: regressionsInputSchema, outputSchema: { type: "object", properties: { items: { type: "array", items: regressionSchema } }, required: ["items"], additionalProperties: false }, route: { method: "GET", path: "/resources/analytics/regressions" }, permission: "testfn.analytics.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "analytics", collection: true } },
  { id: "testfn.visual-diffs.get", title: "Get visual diff metadata", description: "Inspect whether TestFn has a visual diff without returning the image bytes.", inputSchema: idInputSchema, outputSchema: item(visualDiffSchema), route: { method: "GET", path: "/resources/visual-diffs/:id" }, permission: "testfn.visual-diffs.read", minimumScope: "project", safety: { ...readSafety, audit: "required" }, mcp: readMcp, redaction: { outputFields: ["buffer", "diffImage", "path"] }, target: { resource: "visual-diffs", idInput: "id" } },
  { id: "testfn.visual-diffs.compare", title: "Compare screenshot", description: "Compare an uploaded screenshot against the configured TestFn baseline and persist any generated diff.", inputSchema: screenshotInputSchema, outputSchema: item(comparisonSchema), route: { method: "POST", path: "/resources/visual-diffs/actions/compare" }, permission: "testfn.visual-diffs.compare", minimumScope: "project", safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, redaction: { inputFields: ["screenshotBase64"], outputFields: ["diffImage", "buffer", "path"] }, target: { resource: "visual-diffs", idInput: "id" } },
  { id: "testfn.visual-baselines.update", title: "Update visual baseline", description: "Replace a scope-owned TestFn visual baseline with confirmed operator intent.", inputSchema: updateBaselineInputSchema, outputSchema: acceptedSchema, route: { method: "POST", path: "/resources/visual-baselines/actions/update" }, permission: "testfn.visual-baselines.update", minimumScope: "project", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "critical", method: "mfa", reason: "Replacing a visual baseline changes the evidence used to accept future test runs.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, redaction: { inputFields: ["screenshotBase64"] }, target: { resource: "visual-baselines", idInput: "id" } },
] as const satisfies readonly AdminOperationDefinition[];

export type TestFnAdminOperationId = (typeof testFnAdminOperations)[number]["id"];

export const testFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "testfn",
  displayName: "TestFn",
  version: "1.0.0",
  description: "Scope-isolated TestFn runs, evidence, analytics, and visual testing administration.",
  category: "quality",
  availability: "required-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: testFnAdminResources,
  navigation: [{ id: "testfn", label: "TestFn", path: "/modules/testfn", icon: "testfn", description: "Operate configured TestFn services in the active scope.", order: 100 }],
  operations: testFnAdminOperations,
});

export const testFnAdminSchemas = {
  listRunsInput: listRunsInputSchema,
  idInput: idInputSchema,
  run: runSchema,
  screenshotInput: screenshotInputSchema,
  updateBaselineInput: updateBaselineInputSchema,
} as const satisfies Record<string, AdminJsonSchema>;
