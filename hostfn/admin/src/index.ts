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

export interface HostFnAdminResourceDefinition {
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
export interface HostFnAdminActionDefinition {
  id: string;
  resource: string;
  title: string;
  description: string;
  classification: "write" | "destructive";
  requiresConfirmation: boolean;
  idempotent: true;
  target: "resource" | "collection";
}
export const hostFnAdminResources = [
  {
    id: "projects",
    label: "Projects",
    description: "Inspect and operate projects in HostFn.",
    icon: "hostfn:projects",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "apps-services",
    label: "Apps Services",
    description: "Inspect and operate apps services in HostFn.",
    icon: "hostfn:apps-services",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "deployments",
    label: "Deployments",
    description: "Inspect and operate deployments in HostFn.",
    icon: "hostfn:deployments",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "builds",
    label: "Builds",
    description: "Inspect and operate builds in HostFn.",
    icon: "hostfn:builds",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "previews",
    label: "Previews",
    description: "Inspect and operate previews in HostFn.",
    icon: "hostfn:previews",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "domains",
    label: "Domains",
    description: "Inspect and operate domains in HostFn.",
    icon: "hostfn:domains",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "certificates",
    label: "Certificates",
    description: "Inspect and operate certificates in HostFn.",
    icon: "hostfn:certificates",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "targets",
    label: "Targets",
    description: "Inspect and operate targets in HostFn.",
    icon: "hostfn:targets",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "environments",
    label: "Environments",
    description: "Inspect and operate environments in HostFn.",
    icon: "hostfn:environments",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Inspect and operate secrets in HostFn.",
    icon: "hostfn:secrets",
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
    id: "traffic",
    label: "Traffic",
    description: "Inspect and operate traffic in HostFn.",
    icon: "hostfn:traffic",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "logs",
    label: "Logs",
    description: "Inspect and operate logs in HostFn.",
    icon: "hostfn:logs",
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
    id: "usage",
    label: "Usage",
    description: "Inspect and operate usage in HostFn.",
    icon: "hostfn:usage",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
] as const satisfies readonly HostFnAdminResourceDefinition[];
export const hostFnAdminActions = [
  {
    id: "deploy",
    resource: "deployments",
    title: "Deploy",
    description: "Deploy for deployments.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "cancel-deployment",
    resource: "deployments",
    title: "Cancel Deployment",
    description: "Cancel Deployment for deployments.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "retry-deployment",
    resource: "deployments",
    title: "Retry Deployment",
    description: "Retry Deployment for deployments.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "rollback-deployment",
    resource: "deployments",
    title: "Rollback Deployment",
    description: "Rollback Deployment for deployments.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "promote-deployment",
    resource: "deployments",
    title: "Promote Deployment",
    description: "Promote Deployment for deployments.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "attach-domain",
    resource: "domains",
    title: "Attach Domain",
    description: "Attach Domain for domains.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "renew-certificate",
    resource: "certificates",
    title: "Renew Certificate",
    description: "Renew Certificate for certificates.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "rotate-secret",
    resource: "secrets",
    title: "Rotate Secret",
    description: "Rotate Secret for secrets.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "scale-target",
    resource: "targets",
    title: "Scale Target",
    description: "Scale Target for targets.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
] as const satisfies readonly HostFnAdminActionDefinition[];

export interface HostFnAdminResourcePolicy {
  defaultScope: "active";
  permission: string;
  redaction: "none" | "sensitive-fields";
}

export interface HostFnAdminOperationPolicy {
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
    domain: "hostfn";
    requestIdPath: "context.requestId";
    correlationIdPath: "context.correlationId";
  };
}

export const hostFnAdminResourcePolicies = Object.freeze(
  Object.fromEntries(
    hostFnAdminResources.map((resource) => [
      resource.id,
      {
        defaultScope: "active",
        permission: "hostfn." + resource.id + ".read",
        redaction:
          resource.sensitiveFields.length > 0 ? "sensitive-fields" : "none",
      } satisfies HostFnAdminResourcePolicy,
    ]),
  ),
) as Readonly<Record<string, HostFnAdminResourcePolicy>>;

export const hostFnAdminOperationPolicies = Object.freeze(
  Object.fromEntries(
    hostFnAdminActions.map((action) => [
      "hostfn." + action.resource + "." + action.id,
      {
        permission: "hostfn." + action.resource + "." + action.id,
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
          action: "hostfn." + action.id,
          targetResource: action.resource,
          ...(action.target === "resource"
            ? { targetIdPath: "$.id" as const }
            : { collection: true as const }),
        },
        observation: {
          domain: "hostfn",
          requestIdPath: "context.requestId",
          correlationIdPath: "context.correlationId",
        },
      } satisfies HostFnAdminOperationPolicy,
    ]),
  ),
) as Readonly<Record<string, HostFnAdminOperationPolicy>>;

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
export const hostFnAdminSchemas = {
  entity: entitySchema,
  listInput: listInputSchema,
  listOutput: listOutputSchema,
  getInput: getInputSchema,
  getOutput: getOutputSchema,
  actionInput: actionInputSchema,
  actionOutput: actionOutputSchema,
} as const satisfies Record<string, AdminJsonSchema>;
function resourceOperations(
  resource: HostFnAdminResourceDefinition,
): AdminOperationDefinition[] {
  const baseId = "hostfn." + resource.id;
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
      permission: "hostfn." + resource.id + ".read",
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
      permission: "hostfn." + resource.id + ".read",
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
  action: HostFnAdminActionDefinition,
): AdminOperationDefinition {
  const sensitiveFields =
    hostFnAdminResources.find((resource) => resource.id === action.resource)
      ?.sensitiveFields ?? [];
  return {
    id: "hostfn." + action.resource + "." + action.id,
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
    permission: "hostfn." + action.resource + "." + action.id,
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
  ...hostFnAdminResources.flatMap(resourceOperations),
  ...hostFnAdminActions.map(actionOperation),
];
type FunctionAdminActionOperationId<TModule extends string, TAction> =
  TAction extends { resource: infer TResource extends string; id: infer TActionId extends string }
    ? `${TModule}.${TResource}.${TActionId}`
    : never;
export type HostFnAdminOperationId =
  | `hostfn.${(typeof hostFnAdminResources)[number]["id"]}.list`
  | `hostfn.${(typeof hostFnAdminResources)[number]["id"]}.get`
  | FunctionAdminActionOperationId<"hostfn", (typeof hostFnAdminActions)[number]>;
export const hostFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "hostfn",
  displayName: "HostFn",
  version: "1.0.0",
  description:
    "Commercial-grade, function-owned operator capabilities for HostFn.",
  category: "infrastructure",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: hostFnAdminResources,
  navigation: [
    {
      id: "hostfn",
      label: "HostFn",
      path: "/modules/hostfn",
      icon: "hostfn",
      description: "Operate HostFn in the active scope.",
      order: 100,
    },
  ],
  operations: operations as readonly (AdminOperationDefinition & { readonly id: HostFnAdminOperationId })[],
});
export function createHostFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(hostFnAdminCapability, adminClient);
}
export interface HostFnAdminServiceRequest {
  operationId: HostFnAdminOperationId;
  input: unknown;
  context: AdminOperationContext;
}
export interface HostFnAdminService {
  execute(
    request: HostFnAdminServiceRequest,
  ):
    | Promise<AdminOperationResult<Record<string, unknown>>>
    | AdminOperationResult<Record<string, unknown>>;
}
export function createHostFnAdminAdapter(
  service: HostFnAdminService,
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
  for (const operation of hostFnAdminCapability.operations)
    handlers[operation.id] = (request) =>
      service.execute({
        operationId: operation.id,
        input: request.input,
        context: request.context,
      });
  return createKernelAdminCapabilityAdapter(hostFnAdminCapability, handlers);
}
export const adminCapability = hostFnAdminCapability;
export const createAdminAdapter = createHostFnAdminAdapter;
