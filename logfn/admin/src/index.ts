import {
  AdminError,
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminOperationContext,
} from "@superfunctions/admin";
import type { Logger, LogLevel } from "@logfn/core";

export interface LogFnAdminScope {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  namespace?: string;
  region?: string;
}

export interface EmitLogInput {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  tags?: string[];
}
export interface EmitLogResult { emitted: true; level: LogLevel }
export interface FlushLogsResult { flushed: true }

const operations = [
  {
    id: "logfn.events.emit", title: "Emit log event", description: "Emit one structured event through the configured LogFn pipeline and sinks.",
    inputSchema: {
      type: "object", properties: {
        level: { type: "string", enum: ["trace", "debug", "info", "warn", "error", "fatal"] },
        message: { type: "string", minLength: 1, maxLength: 16_384 },
        context: { type: "object", additionalProperties: true },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
      }, required: ["level", "message"], additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { emitted: { type: "boolean", const: true }, level: { type: "string" } }, required: ["emitted", "level"], additionalProperties: false },
    route: { method: "POST", path: "/resources/events/actions/emit" }, permission: "logfn.events.emit",
    safety: { classification: "write", idempotent: false, requiresConfirmation: false, audit: "required" },
    mcp: { readOnlyHint: false, idempotentHint: false }, redaction: { inputFields: ["context"], outputFields: [] },
    target: { resource: "events", collection: true },
  },
  {
    id: "logfn.sinks.flush", title: "Flush log sinks", description: "Flush all configured LogFn sinks.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { flushed: { type: "boolean", const: true } }, required: ["flushed"], additionalProperties: false },
    route: { method: "POST", path: "/resources/sinks/actions/flush" }, permission: "logfn.sinks.flush",
    safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" },
    mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "sinks", collection: true },
  },
] as const;

export const logFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0", id: "logfn", displayName: "LogFn", version: "1.1.0",
  description: "Function-owned operations for the configured LogFn logger and sinks.", category: "observability",
  availability: "nested", owner: { moduleId: "watchfn", mountPath: "/modules/watchfn/logs" }, scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: ["watchfn"],
  resources: [
    { id: "events", label: "Log events", description: "Structured events emitted through LogFn.", icon: "logfn:events", risk: "sensitive", idField: "requestId", displayFields: ["level", "message"], sensitiveFields: ["context"] },
    { id: "sinks", label: "Log sinks", description: "Configured LogFn output sinks.", icon: "logfn:sinks", risk: "standard", idField: "name", displayFields: ["name"] },
  ],
  navigation: [{ id: "logfn", label: "Logs", path: "/modules/watchfn/logs", parentId: "watchfn", group: "WatchFn", order: 20 }],
  operations,
});

export interface LogFnAdminService {
  emit(input: EmitLogInput, context: AdminOperationContext): Promise<EmitLogResult> | EmitLogResult;
  flush(context: AdminOperationContext): Promise<FlushLogsResult>;
}

function assertScope(expected: LogFnAdminScope, actual: AdminOperationContext["scope"]): void {
  for (const key of ["organizationId", "workspaceId", "projectId", "environmentId", "namespace", "region"] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) throw new AdminError("forbidden", `LogFn is not bound to the active ${key}.`);
  }
}

export function createLogFnAdminService(logger: Logger, scope: LogFnAdminScope): LogFnAdminService {
  return {
    emit(input, context) {
      assertScope(scope, context.scope);
      const eventContext = {
        ...input.context,
        adminActorId: context.actor.id,
        adminRequestId: context.requestId,
        adminCorrelationId: context.correlationId,
        organizationId: context.scope.organizationId,
        workspaceId: context.scope.workspaceId,
        projectId: context.scope.projectId,
        environmentId: context.scope.environmentId,
      };
      logger[input.level](input.message, eventContext, input.tags);
      return { emitted: true, level: input.level };
    },
    async flush(context) {
      assertScope(scope, context.scope);
      await logger.flush();
      return { flushed: true };
    },
  };
}

export function createLogFnAdminAdapter(service: LogFnAdminService) {
  return createKernelAdminCapabilityAdapter(logFnAdminCapability, {
    "logfn.events.emit": ({ input, context }) => service.emit(input as EmitLogInput, context),
    "logfn.sinks.flush": ({ context }) => service.flush(context),
  });
}

export function createLogFnAdminClient(adminClient: AdminClient) {
  const capability = createCapabilityAdminClient(logFnAdminCapability, adminClient);
  return Object.assign(capability, {
    emit: (input: EmitLogInput, options?: AdminClientRequestOptions) => capability.invoke("logfn.events.emit", input, options),
    flush: (options?: AdminClientRequestOptions) => capability.invoke("logfn.sinks.flush", {}, options),
  });
}

export const adminCapability = logFnAdminCapability;
export const createAdminAdapter = createLogFnAdminAdapter;
