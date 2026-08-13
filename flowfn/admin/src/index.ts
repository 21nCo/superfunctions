import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminCapabilityAdapter,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationDefinition,
  type AdminOperationResult,
} from "@superfunctions/admin";

export interface FlowFnAdminResourceDefinition {
  id: string;
  label: string;
  description: string;
  icon: string;
  risk: "standard" | "sensitive";
  idField: string;
  displayFields: readonly string[];
  searchableFields: readonly string[];
  filterableFields: readonly string[];
  sortableFields: readonly string[];
  sensitiveFields: readonly string[];
}
export interface FlowFnAdminActionDefinition {
  id: string;
  resource: string;
  title: string;
  description: string;
  classification: "write" | "destructive";
  requiresConfirmation: boolean;
  idempotent: true;
  target: "resource" | "collection";
}
export const flowFnAdminResources = [
  {
    id: "workflows",
    label: "Workflows",
    description: "Inspect and operate workflows in FlowFn.",
    icon: "flowfn:workflows",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "queues",
    label: "Queues",
    description: "Inspect and operate queues in FlowFn.",
    icon: "flowfn:queues",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "streams",
    label: "Streams",
    description: "Inspect and operate streams in FlowFn.",
    icon: "flowfn:streams",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "messages",
    label: "Messages",
    description: "Inspect and operate messages in FlowFn.",
    icon: "flowfn:messages",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [
      "secret",
      "token",
      "credential",
      "value",
      "password",
      "passwd",
      "apiKey",
      "privateKey",
      "authorization",
      "cookie",
      "otp",
      "otpCode",
      "recoveryCode",
      "recoveryCodes",
      "verificationCode",
      "sessionToken",
    ],
  },
  {
    id: "executions",
    label: "Executions",
    description: "Inspect and operate executions in FlowFn.",
    icon: "flowfn:executions",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "jobs",
    label: "Jobs",
    description: "Inspect and operate jobs in FlowFn.",
    icon: "flowfn:jobs",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "workers",
    label: "Workers",
    description: "Inspect and operate workers in FlowFn.",
    icon: "flowfn:workers",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "consumers",
    label: "Consumers",
    description: "Inspect and operate consumers in FlowFn.",
    icon: "flowfn:consumers",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "schedules",
    label: "Schedules",
    description: "Inspect and operate schedules in FlowFn.",
    icon: "flowfn:schedules",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "retries",
    label: "Retries",
    description: "Inspect and operate retries in FlowFn.",
    icon: "flowfn:retries",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "dead-letters",
    label: "Dead Letters",
    description: "Inspect and operate dead letters in FlowFn.",
    icon: "flowfn:dead-letters",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "metrics",
    label: "Metrics",
    description: "Inspect and operate metrics in FlowFn.",
    icon: "flowfn:metrics",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
] as const satisfies readonly FlowFnAdminResourceDefinition[];
export const flowFnAdminActions = [
  {
    id: "start-workflow",
    resource: "executions",
    title: "Start Workflow",
    description: "Start Workflow for executions.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "signal-workflow",
    resource: "executions",
    title: "Signal Workflow",
    description: "Signal Workflow for executions.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "cancel-workflow",
    resource: "executions",
    title: "Cancel Workflow",
    description: "Cancel Workflow for executions.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "terminate-workflow",
    resource: "executions",
    title: "Terminate Workflow",
    description: "Terminate Workflow for executions.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "retry-execution",
    resource: "retries",
    title: "Retry Execution",
    description: "Retry Execution for retries.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "replay-execution",
    resource: "executions",
    title: "Replay Execution",
    description: "Replay Execution for executions.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "pause-queue",
    resource: "queues",
    title: "Pause Queue",
    description: "Pause Queue for queues.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "redrive-dead-letter",
    resource: "dead-letters",
    title: "Redrive Dead Letter",
    description: "Redrive Dead Letter for dead letters.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-schedule",
    resource: "schedules",
    title: "Manage Schedule",
    description: "Manage Schedule for schedules.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
] as const satisfies readonly FlowFnAdminActionDefinition[];

export interface FlowFnAdminResourcePolicy {
  defaultScope: "active";
  permission: string;
  redaction: "none" | "sensitive-fields";
}

export interface FlowFnAdminOperationPolicy {
  permission: string;
  scope: {
    levels: readonly ["organization", "workspace", "project", "environment"];
    forwardsNamespace: true;
    forwardsRegion: true;
  };
  safety: {
    classification: "write" | "destructive";
    requiresConfirmation: boolean;
  };
  idempotency: {
    mode: "required";
    keyStrategy: "context.idempotencyKey";
  };
  audit: {
    mode: "required";
    action: string;
    targetResource: string;
    targetIdPath?: "$.id";
    collection?: true;
  };
  observation: {
    domain: "flowfn";
    requestIdPath: "context.requestId";
    correlationIdPath: "context.correlationId";
  };
}

export const flowFnAdminResourcePolicies = Object.freeze(
  Object.fromEntries(
    flowFnAdminResources.map((resource) => [
      resource.id,
      {
        defaultScope: "active",
        permission: "flowfn." + resource.id + ".read",
        redaction:
          resource.sensitiveFields.length > 0 ? "sensitive-fields" : "none",
      } satisfies FlowFnAdminResourcePolicy,
    ]),
  ),
) as Readonly<Record<string, FlowFnAdminResourcePolicy>>;

export const flowFnAdminOperationPolicies = Object.freeze(
  Object.fromEntries(
    flowFnAdminActions.map((action) => [
      "flowfn." + action.resource + "." + action.id,
      {
        permission: "flowfn." + action.resource + "." + action.id,
        scope: {
          levels: ["organization", "workspace", "project", "environment"],
          forwardsNamespace: true,
          forwardsRegion: true,
        },
        safety: {
          classification: action.classification,
          requiresConfirmation: action.requiresConfirmation,
        },
        idempotency: {
          mode: "required",
          keyStrategy: "context.idempotencyKey",
        },
        audit: {
          mode: "required",
          action: "flowfn." + action.id,
          targetResource: action.resource,
          ...(action.target === "resource"
            ? { targetIdPath: "$.id" as const }
            : { collection: true as const }),
        },
        observation: {
          domain: "flowfn",
          requestIdPath: "context.requestId",
          correlationIdPath: "context.correlationId",
        },
      } satisfies FlowFnAdminOperationPolicy,
    ]),
  ),
) as Readonly<Record<string, FlowFnAdminOperationPolicy>>;

const entitySchema: AdminObjectSchema = {
  type: "object",
  description:
    "A domain-owned administration resource. Sensitive fields are redacted by the domain service.",
  additionalProperties: true,
};
const listInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    cursor: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    search: { type: "string", maxLength: 500 },
    filter: { type: "object", additionalProperties: true },
    sort: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      maxItems: 10,
    },
  },
  additionalProperties: false,
};
const listOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: entitySchema },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["items"],
  additionalProperties: false,
};
const getInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
};
const getOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: entitySchema },
  required: ["item"],
  additionalProperties: false,
};
const actionInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    payload: { type: "object", additionalProperties: true },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  additionalProperties: false,
};
const actionOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    item: entitySchema,
    accepted: { type: "boolean" },
    operationReference: { type: "string" },
  },
  required: ["accepted"],
  additionalProperties: true,
};
export const flowFnAdminSchemas = {
  entity: entitySchema,
  listInput: listInputSchema,
  listOutput: listOutputSchema,
  getInput: getInputSchema,
  getOutput: getOutputSchema,
  actionInput: actionInputSchema,
  actionOutput: actionOutputSchema,
} as const satisfies Record<string, AdminJsonSchema>;
function resourceOperations(
  resource: FlowFnAdminResourceDefinition,
): AdminOperationDefinition[] {
  const baseId = "flowfn." + resource.id;
  const basePath = "/resources/" + resource.id;
  return [
    {
      id: baseId + ".list",
      title: "List " + resource.label,
      description:
        "List permitted " +
        resource.label.toLowerCase() +
        " in the active administration scope.",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      route: { method: "GET", path: basePath },
      permission: "flowfn." + resource.id + ".read",
      safety: {
        classification: "read",
        idempotent: true,
        requiresConfirmation: false,
        audit: resource.risk === "sensitive" ? "required" : "optional",
      },
      pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 200 },
      mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      redaction: { outputFields: resource.sensitiveFields },
      target: { resource: resource.id, collection: true },
    },
    {
      id: baseId + ".get",
      title: "Get " + resource.label,
      description:
        "Get one permitted " + resource.label.toLowerCase() + " resource.",
      inputSchema: getInputSchema,
      outputSchema: getOutputSchema,
      route: { method: "GET", path: basePath + "/:id" },
      permission: "flowfn." + resource.id + ".read",
      safety: {
        classification: "read",
        idempotent: true,
        requiresConfirmation: false,
        audit: resource.risk === "sensitive" ? "required" : "optional",
      },
      mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      redaction: { outputFields: resource.sensitiveFields },
      target: { resource: resource.id, idInput: "id" },
    },
  ];
}
function actionOperation(
  action: FlowFnAdminActionDefinition,
): AdminOperationDefinition {
  const sensitiveFields =
    flowFnAdminResources.find((resource) => resource.id === action.resource)
      ?.sensitiveFields ?? [];
  return {
    id: "flowfn." + action.resource + "." + action.id,
    title: action.title,
    description: action.description,
    inputSchema:
      action.target === "resource"
        ? { ...actionInputSchema, required: ["id"] }
        : actionInputSchema,
    outputSchema: actionOutputSchema,
    route: {
      method: "POST",
      path: "/resources/" + action.resource + "/actions/" + action.id,
    },
    permission: "flowfn." + action.resource + "." + action.id,
    safety: {
      classification: action.classification,
      idempotent: action.idempotent,
      requiresConfirmation: action.requiresConfirmation,
      audit: "required",
    },
    mcp: {
      readOnlyHint: false,
      destructiveHint: action.classification === "destructive",
      idempotentHint: action.idempotent,
    },
    redaction: { inputFields: sensitiveFields, outputFields: sensitiveFields },
    target:
      action.target === "resource"
        ? { resource: action.resource, idInput: "id" }
        : { resource: action.resource, collection: true },
  };
}
const operations: AdminOperationDefinition[] = [
  ...flowFnAdminResources.flatMap(resourceOperations),
  ...flowFnAdminActions.map(actionOperation),
];
type FunctionAdminActionOperationId<TModule extends string, TAction> =
  TAction extends { resource: infer TResource extends string; id: infer TActionId extends string }
    ? `${TModule}.${TResource}.${TActionId}`
    : never;
export type FlowFnAdminOperationId =
  | `flowfn.${(typeof flowFnAdminResources)[number]["id"]}.list`
  | `flowfn.${(typeof flowFnAdminResources)[number]["id"]}.get`
  | FunctionAdminActionOperationId<"flowfn", (typeof flowFnAdminActions)[number]>;
export const flowFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "flowfn",
  displayName: "FlowFn",
  version: "1.0.0",
  description:
    "Commercial-grade, function-owned operator capabilities for FlowFn.",
  category: "orchestration",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: flowFnAdminResources,
  navigation: [
    {
      id: "flowfn",
      label: "FlowFn",
      path: "/modules/flowfn",
      icon: "flowfn",
      description: "Operate FlowFn in the active scope.",
      order: 100,
    },
  ],
  operations: operations as readonly (AdminOperationDefinition & { readonly id: FlowFnAdminOperationId })[],
});
export function createFlowFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(flowFnAdminCapability, adminClient);
}
export interface FlowFnAdminServiceRequest {
  operationId: FlowFnAdminOperationId;
  input: unknown;
  context: AdminOperationContext;
}
export interface FlowFnAdminService {
  execute(
    request: FlowFnAdminServiceRequest,
  ):
    | Promise<AdminOperationResult<Record<string, unknown>>>
    | AdminOperationResult<Record<string, unknown>>;
}
export function createFlowFnAdminAdapter(
  service: FlowFnAdminService,
): AdminCapabilityAdapter {
  const handlers: Record<
    string,
    (request: {
      input: unknown;
      context: AdminOperationContext;
    }) =>
      | Promise<AdminOperationResult<Record<string, unknown>>>
      | AdminOperationResult<Record<string, unknown>>
  > = {};
  for (const operation of flowFnAdminCapability.operations)
    handlers[operation.id] = (request) =>
      service.execute({
        operationId: operation.id,
        input: request.input,
        context: request.context,
      });
  return createKernelAdminCapabilityAdapter(flowFnAdminCapability, handlers);
}
export const adminCapability = flowFnAdminCapability;
export const createAdminAdapter = createFlowFnAdminAdapter;
