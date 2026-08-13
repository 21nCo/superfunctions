import {
  AdminError,
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminOperationContext,
} from "@superfunctions/admin";
import type { AlertConfig, QueryOptions, WatchFn } from "@watchfn/core";

export interface WatchFnAdminScope {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  namespace?: string;
  region?: string;
}
export interface ListWatchEventsInput {
  metric?: string;
  where?: Record<string, unknown>;
  orderBy?: { field: string; direction: "asc" | "desc" };
  limit?: number;
}
export interface WatchEventListResult { items: Record<string, unknown>[] }
export interface CaptureMessageInput { message: string; context?: Record<string, unknown> }
export interface CaptureExceptionInput { name: string; message: string; stack?: string; context?: Record<string, unknown> }
export interface CaptureResult { captured: true }
export interface ListAlertsInput { status?: string }
export interface AlertListResult { items: Array<AlertConfig & { id: string }> }
export type CreateAlertInput = AlertConfig;
export interface CreateAlertResult { item: AlertConfig & { id: string } }

const eventSchema = { type: "object", additionalProperties: true } as const;
const alertSchema = {
  type: "object", properties: {
    id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, enabled: { type: "boolean" },
    severity: { type: "string", enum: ["info", "warning", "error", "critical"] }, tags: { type: "array", items: { type: "string" } },
    condition: { type: "object", additionalProperties: true }, channels: { type: "array", items: { type: "object", additionalProperties: true } },
  }, required: ["id", "name", "condition", "channels"], additionalProperties: true,
} as const;

const operations = [
  {
    id: "watchfn.events.list", title: "Query events", description: "Query events from the configured WatchFn storage adapter.",
    inputSchema: { type: "object", properties: { metric: { type: "string" }, where: { type: "object", additionalProperties: true }, orderBy: { type: "object", properties: { field: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, required: ["field", "direction"], additionalProperties: false }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: eventSchema } }, required: ["items"], additionalProperties: false },
    route: { method: "GET", path: "/resources/events" }, permission: "watchfn.events.read",
    safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: true },
    redaction: { outputFields: ["token", "password", "authorization", "cookie", "context"] }, target: { resource: "events", collection: true },
  },
  {
    id: "watchfn.events.capture-message", title: "Capture message", description: "Capture an operator-attributed message through WatchFn.",
    inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 16_384 }, context: { type: "object", additionalProperties: true } }, required: ["message"], additionalProperties: false },
    outputSchema: { type: "object", properties: { captured: { type: "boolean", const: true } }, required: ["captured"], additionalProperties: false },
    route: { method: "POST", path: "/resources/events/actions/capture-message" }, permission: "watchfn.events.capture",
    safety: { classification: "write", idempotent: false, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: false },
    redaction: { inputFields: ["context"], outputFields: [] }, target: { resource: "events", collection: true },
  },
  {
    id: "watchfn.errors.capture", title: "Capture exception", description: "Capture an operator-attributed exception through WatchFn.",
    inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1, maxLength: 16_384 }, stack: { type: "string", maxLength: 65_536 }, context: { type: "object", additionalProperties: true } }, required: ["name", "message"], additionalProperties: false },
    outputSchema: { type: "object", properties: { captured: { type: "boolean", const: true } }, required: ["captured"], additionalProperties: false },
    route: { method: "POST", path: "/resources/errors/actions/capture" }, permission: "watchfn.errors.capture",
    safety: { classification: "write", idempotent: false, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: false },
    redaction: { inputFields: ["stack", "context"], outputFields: [] }, target: { resource: "errors", collection: true },
  },
  {
    id: "watchfn.alerts.list", title: "List alerts", description: "List alerts registered with the WatchFn alert manager.",
    inputSchema: { type: "object", properties: { status: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: alertSchema } }, required: ["items"], additionalProperties: false },
    route: { method: "GET", path: "/resources/alerts" }, permission: "watchfn.alerts.read",
    safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, mcp: { readOnlyHint: true }, target: { resource: "alerts", collection: true },
  },
  {
    id: "watchfn.alerts.create", title: "Create alert", description: "Register a typed alert with the WatchFn alert manager.",
    inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1 }, description: { type: "string" }, enabled: { type: "boolean" }, condition: { type: "object", additionalProperties: true }, channels: { type: "array", items: { type: "object", additionalProperties: true } }, severity: { type: "string", enum: ["info", "warning", "error", "critical"] }, tags: { type: "array", items: { type: "string" } } }, required: ["name", "condition", "channels"], additionalProperties: false },
    outputSchema: { type: "object", properties: { item: alertSchema }, required: ["item"], additionalProperties: false },
    route: { method: "POST", path: "/resources/alerts" }, permission: "watchfn.alerts.create",
    safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "alerts", collection: true },
  },
] as const;

export const watchFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0", id: "watchfn", displayName: "WatchFn", version: "1.1.0",
  description: "Function-owned administration for WatchFn event storage, exception capture, alerts, and its nested CatchFn/LogFn surfaces.",
  category: "observability", availability: "required-product", scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [{ moduleId: "catchfn", required: false, reason: "Folded bug reports." }, { moduleId: "logfn", required: false, reason: "Folded structured logs." }],
  resources: [
    { id: "events", label: "Events", description: "Events in the configured WatchFn storage.", icon: "watchfn:events", risk: "sensitive", idField: "id", displayFields: ["id", "type", "name", "timestamp"], searchableFields: ["id", "name"], filterableFields: ["type", "timestamp"], sortableFields: ["timestamp"], sensitiveFields: ["context", "properties"] },
    { id: "errors", label: "Errors", description: "Captured WatchFn exceptions.", icon: "watchfn:errors", risk: "sensitive", idField: "id", displayFields: ["id", "message", "timestamp"], sensitiveFields: ["stack", "context"] },
    { id: "alerts", label: "Alerts", description: "WatchFn alert definitions.", icon: "watchfn:alerts", risk: "standard", idField: "id", displayFields: ["id", "name", "severity", "enabled"] },
  ],
  navigation: [{ id: "watchfn", label: "WatchFn", path: "/modules/watchfn", icon: "watchfn", order: 20 }],
  operations,
});

export interface WatchFnAdminService {
  listEvents(input: ListWatchEventsInput, context: AdminOperationContext): Promise<WatchEventListResult>;
  captureMessage(input: CaptureMessageInput, context: AdminOperationContext): CaptureResult;
  captureException(input: CaptureExceptionInput, context: AdminOperationContext): CaptureResult;
  listAlerts(input: ListAlertsInput, context: AdminOperationContext): Promise<AlertListResult>;
  createAlert(input: CreateAlertInput, context: AdminOperationContext): Promise<CreateAlertResult>;
}

function assertScope(expected: WatchFnAdminScope, actual: AdminOperationContext["scope"]): void {
  for (const key of ["organizationId", "workspaceId", "projectId", "environmentId", "namespace", "region"] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) throw new AdminError("forbidden", `WatchFn is not bound to the active ${key}.`);
  }
}

function operatorContext(context: AdminOperationContext, supplied?: Record<string, unknown>): Record<string, unknown> {
  return { ...supplied, adminActorId: context.actor.id, adminRequestId: context.requestId, organizationId: context.scope.organizationId, workspaceId: context.scope.workspaceId, projectId: context.scope.projectId, environmentId: context.scope.environmentId };
}

export function createWatchFnAdminService(watch: WatchFn, scope: WatchFnAdminScope): WatchFnAdminService {
  const assertStarted = () => {
    if (!watch.started) {
      throw new AdminError("precondition_failed", "WatchFn must be started before capturing administration events.");
    }
  };
  return {
    async listEvents(input, context) {
      assertScope(scope, context.scope);
      const items = await watch.query({ ...input, limit: input.limit ?? 50 } as QueryOptions);
      return { items: items as Record<string, unknown>[] };
    },
    captureMessage(input, context) {
      assertScope(scope, context.scope);
      assertStarted();
      watch.captureMessage(input.message, operatorContext(context, input.context));
      return { captured: true };
    },
    captureException(input, context) {
      assertScope(scope, context.scope);
      assertStarted();
      const error = new Error(input.message); error.name = input.name; if (input.stack) error.stack = input.stack;
      watch.captureException(error, operatorContext(context, input.context));
      return { captured: true };
    },
    async listAlerts(input, context) {
      assertScope(scope, context.scope);
      return { items: await watch.alerts.list(input) };
    },
    async createAlert(input, context) {
      assertScope(scope, context.scope);
      return { item: await watch.alerts.create(input) as AlertConfig & { id: string } };
    },
  };
}

export function createWatchFnAdminAdapter(service: WatchFnAdminService) {
  return createKernelAdminCapabilityAdapter(watchFnAdminCapability, {
    "watchfn.events.list": ({ input, context }) => service.listEvents(input as ListWatchEventsInput, context),
    "watchfn.events.capture-message": ({ input, context }) => service.captureMessage(input as CaptureMessageInput, context),
    "watchfn.errors.capture": ({ input, context }) => service.captureException(input as CaptureExceptionInput, context),
    "watchfn.alerts.list": ({ input, context }) => service.listAlerts(input as ListAlertsInput, context),
    "watchfn.alerts.create": ({ input, context }) => service.createAlert(input as CreateAlertInput, context),
  });
}

export function createWatchFnAdminClient(adminClient: AdminClient) {
  const capability = createCapabilityAdminClient(watchFnAdminCapability, adminClient);
  return {
    manifest: capability.manifest,
    listEvents: (input: ListWatchEventsInput = {}, options?: AdminClientRequestOptions) => capability.invoke("watchfn.events.list", input, options),
    captureMessage: (input: CaptureMessageInput, options?: AdminClientRequestOptions) => capability.invoke("watchfn.events.capture-message", input, options),
    captureException: (input: CaptureExceptionInput, options?: AdminClientRequestOptions) => capability.invoke("watchfn.errors.capture", input, options),
    listAlerts: (input: ListAlertsInput = {}, options?: AdminClientRequestOptions) => capability.invoke("watchfn.alerts.list", input, options),
    createAlert: (input: CreateAlertInput, options?: AdminClientRequestOptions) => capability.invoke("watchfn.alerts.create", input, options),
  };
}

export const adminCapability = watchFnAdminCapability;
export const createAdminAdapter = createWatchFnAdminAdapter;
