import {
  AdminError,
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  decodeAdminCursor,
  defineAdminCapability,
  encodeAdminCursor,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminOperationContext,
} from "@superfunctions/admin";
import type { CatchFnService } from "@catchfn/server";
import type { BugReportEvent } from "catchfn";

export interface CatchFnAdminScope {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  namespace?: string;
  region?: string;
}

export interface ListBugReportsInput { limit?: number; cursor?: string }
export interface GetBugReportInput { id: string }
export type CreateBugReportInput = Pick<
  BugReportEvent,
  "id" | "timestamp" | "title" | "severity"
> & Partial<Omit<BugReportEvent, "id" | "timestamp" | "title" | "severity">>;
export interface BugReportListResult { items: BugReportEvent[]; nextCursor: string | null }
export interface BugReportResult { item: BugReportEvent }

const bugReportSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, timestamp: { type: "number" }, title: { type: "string" },
    description: { type: "string" }, severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    tags: { type: "array", items: { type: "string" } }, environment: { type: "string" }, release: { type: "string" },
  },
  required: ["id", "timestamp", "title", "severity"],
  additionalProperties: true,
} as const;

const operations = [
  {
    id: "catchfn.bug-reports.list", title: "List bug reports", description: "List persisted CatchFn bug reports.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, cursor: { type: "string", minLength: 1 } }, additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: bugReportSchema }, nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] } }, required: ["items", "nextCursor"], additionalProperties: false },
    route: { method: "GET", path: "/resources/bug-reports" }, permission: "catchfn.bug-reports.read",
    safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" },
    pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 200, cursorInput: "cursor", itemsOutput: "items", nextCursorOutput: "nextCursor" }, mcp: { readOnlyHint: true },
    target: { resource: "bug-reports", collection: true },
  },
  {
    id: "catchfn.bug-reports.get", title: "Get bug report", description: "Get one persisted CatchFn bug report.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { item: bugReportSchema }, required: ["item"], additionalProperties: false },
    route: { method: "GET", path: "/resources/bug-reports/:id" }, permission: "catchfn.bug-reports.read",
    safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, mcp: { readOnlyHint: true },
    target: { resource: "bug-reports", idInput: "id" },
  },
  {
    id: "catchfn.bug-reports.create", title: "Capture bug report", description: "Persist a typed CatchFn bug report.",
    inputSchema: { ...bugReportSchema, additionalProperties: true },
    outputSchema: { type: "object", properties: { item: bugReportSchema }, required: ["item"], additionalProperties: false },
    route: { method: "POST", path: "/resources/bug-reports" }, permission: "catchfn.bug-reports.create",
    safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true },
    redaction: { inputFields: ["user", "metadata", "attachments"], outputFields: ["user", "metadata", "attachments"] },
    target: { resource: "bug-reports", idInput: "id" },
  },
] as const;

export const catchFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0", id: "catchfn", displayName: "CatchFn", version: "1.1.0",
  description: "Function-owned administration for persisted CatchFn bug reports.", category: "observability",
  availability: "nested", owner: { moduleId: "watchfn", mountPath: "/modules/watchfn/errors" },
  scopeLevels: ["organization", "workspace", "project", "environment"], dependencies: ["watchfn"],
  resources: [{ id: "bug-reports", label: "Bug reports", description: "Captured product feedback and bug evidence.", icon: "catchfn:bugs", risk: "sensitive", idField: "id", displayFields: ["id", "title", "severity", "timestamp"], searchableFields: ["id", "title"], filterableFields: ["severity", "environment", "timestamp"], sortableFields: ["timestamp", "severity"], sensitiveFields: ["user", "metadata", "attachments"] }],
  navigation: [{ id: "catchfn", label: "Bug reports", path: "/modules/watchfn/errors", parentId: "watchfn", group: "WatchFn", order: 30 }],
  operations,
});

export interface CatchFnAdminService {
  listBugReports(input: ListBugReportsInput, context: AdminOperationContext): Promise<BugReportListResult>;
  getBugReport(input: GetBugReportInput, context: AdminOperationContext): Promise<BugReportResult>;
  createBugReport(input: CreateBugReportInput, context: AdminOperationContext): Promise<BugReportResult>;
}

function assertScope(expected: CatchFnAdminScope, actual: AdminOperationContext["scope"]): void {
  for (const key of ["organizationId", "workspaceId", "projectId", "environmentId", "namespace", "region"] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new AdminError("forbidden", `CatchFn is not bound to the active ${key}.`);
    }
  }
}

export function createCatchFnAdminService(service: CatchFnService, scope: CatchFnAdminScope): CatchFnAdminService {
  return {
    async listBugReports(input, context) {
      assertScope(scope, context.scope);
      const limit = input.limit ?? 50;
      const offset = input.cursor
        ? decodeAdminCursor<{ offset: number }>(input.cursor, context.scope).offset
        : 0;
      if (!Number.isInteger(offset) || offset < 0) throw new AdminError("invalid_argument", "The bug-report cursor is invalid.");
      const items = await service.listBugs(limit + 1, offset);
      return {
        items: items.slice(0, limit),
        nextCursor: items.length > limit
          ? encodeAdminCursor(context.scope, { offset: offset + limit })
          : null,
      };
    },
    async getBugReport(input, context) {
      assertScope(scope, context.scope);
      const item = await service.getBug(input.id);
      if (!item) throw new AdminError("not_found", "Bug report not found.", { details: { id: input.id } });
      return { item };
    },
    async createBugReport(input, context) {
      assertScope(scope, context.scope);
      const item = await service.createBug(input as BugReportEvent);
      return { item };
    },
  };
}

export function createCatchFnAdminAdapter(service: CatchFnAdminService) {
  return createKernelAdminCapabilityAdapter(catchFnAdminCapability, {
    "catchfn.bug-reports.list": ({ input, context }) => service.listBugReports(input as ListBugReportsInput, context),
    "catchfn.bug-reports.get": ({ input, context }) => service.getBugReport(input as GetBugReportInput, context),
    "catchfn.bug-reports.create": ({ input, context }) => service.createBugReport(input as CreateBugReportInput, context),
  });
}

export function createCatchFnAdminClient(adminClient: AdminClient) {
  const capability = createCapabilityAdminClient(catchFnAdminCapability, adminClient);
  return {
    manifest: capability.manifest,
    listBugReports: (input: ListBugReportsInput = {}, options?: AdminClientRequestOptions) => capability.invoke("catchfn.bug-reports.list", input, options),
    getBugReport: (input: GetBugReportInput, options?: AdminClientRequestOptions) => capability.invoke("catchfn.bug-reports.get", input, options),
    createBugReport: (input: CreateBugReportInput, options?: AdminClientRequestOptions) => capability.invoke("catchfn.bug-reports.create", input, options),
  };
}

export const adminCapability = catchFnAdminCapability;
export const createAdminAdapter = createCatchFnAdminAdapter;
