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
export interface SecFnAdminResourceDefinition {
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
export interface SecFnAdminActionDefinition {
  id: string;
  resource: string;
  title: string;
  description: string;
  classification: "write" | "destructive";
  requiresConfirmation: boolean;
  idempotent: true;
  target: "resource" | "collection";
}
export const secFnAdminResources = [
  {
    id: "secrets",
    label: "Secrets",
    description: "Inspect and operate secrets in SecFn.",
    icon: "secfn:secrets",
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
    id: "secret-versions",
    label: "Secret Versions",
    description: "Inspect and operate secret versions in SecFn.",
    icon: "secfn:secret-versions",
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
    id: "rotation",
    label: "Rotation",
    description: "Inspect and operate rotation in SecFn.",
    icon: "secfn:rotation",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "policies",
    label: "Policies",
    description: "Inspect and operate policies in SecFn.",
    icon: "secfn:policies",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "identities-rbac",
    label: "Identities Rbac",
    description: "Inspect and operate identities rbac in SecFn.",
    icon: "secfn:identities-rbac",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "scanners",
    label: "Scanners",
    description: "Inspect and operate scanners in SecFn.",
    icon: "secfn:scanners",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "findings",
    label: "Findings",
    description: "Inspect and operate findings in SecFn.",
    icon: "secfn:findings",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "rate-limits",
    label: "Rate Limits",
    description: "Inspect and operate rate limits in SecFn.",
    icon: "secfn:rate-limits",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "incidents",
    label: "Incidents",
    description: "Inspect and operate incidents in SecFn.",
    icon: "secfn:incidents",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "events",
    label: "Events",
    description: "Inspect and operate events in SecFn.",
    icon: "secfn:events",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "integrations",
    label: "Integrations",
    description: "Inspect and operate integrations in SecFn.",
    icon: "secfn:integrations",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "audit",
    label: "Audit",
    description: "Inspect and operate audit in SecFn.",
    icon: "secfn:audit",
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
] as const satisfies readonly SecFnAdminResourceDefinition[];
export const secFnAdminActions = [
  {
    id: "create-secret",
    resource: "secrets",
    title: "Create Secret",
    description: "Create Secret for secrets.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "rotate-secret",
    resource: "rotation",
    title: "Rotate Secret",
    description: "Rotate Secret for rotation.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "revoke-secret",
    resource: "secrets",
    title: "Revoke Secret",
    description: "Revoke Secret for secrets.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "change-policy",
    resource: "policies",
    title: "Change Policy",
    description: "Change Policy for policies.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "scan",
    resource: "scanners",
    title: "Scan",
    description: "Scan for scanners.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "suppress-finding",
    resource: "findings",
    title: "Suppress Finding",
    description: "Suppress Finding for findings.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "remediate-finding",
    resource: "findings",
    title: "Remediate Finding",
    description: "Remediate Finding for findings.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-incident",
    resource: "incidents",
    title: "Manage Incident",
    description: "Manage Incident for incidents.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-rate-limit",
    resource: "rate-limits",
    title: "Manage Rate Limit",
    description: "Manage Rate Limit for rate limits.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
] as const satisfies readonly SecFnAdminActionDefinition[];

export interface SecFnAdminResourcePolicy {
  defaultScope: "active";
  permission: string;
  redaction: "none" | "sensitive-fields";
}

export interface SecFnAdminOperationPolicy {
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
    domain: "secfn";
    requestIdPath: "context.requestId";
    correlationIdPath: "context.correlationId";
  };
}

export const secFnAdminResourcePolicies = Object.freeze(
  Object.fromEntries(
    secFnAdminResources.map((resource) => [
      resource.id,
      {
        defaultScope: "active",
        permission: "secfn." + resource.id + ".read",
        redaction:
          resource.sensitiveFields.length > 0 ? "sensitive-fields" : "none",
      } satisfies SecFnAdminResourcePolicy,
    ]),
  ),
) as Readonly<Record<string, SecFnAdminResourcePolicy>>;

export const secFnAdminOperationPolicies = Object.freeze(
  Object.fromEntries(
    secFnAdminActions.map((action) => [
      "secfn." + action.resource + "." + action.id,
      {
        permission: "secfn." + action.resource + "." + action.id,
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
          action: "secfn." + action.id,
          targetResource: action.resource,
          ...(action.target === "resource"
            ? { targetIdPath: "$.id" as const }
            : { collection: true as const }),
        },
        observation: {
          domain: "secfn",
          requestIdPath: "context.requestId",
          correlationIdPath: "context.correlationId",
        },
      } satisfies SecFnAdminOperationPolicy,
    ]),
  ),
) as Readonly<Record<string, SecFnAdminOperationPolicy>>;

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
export const secFnAdminSchemas = {
  entity: entitySchema,
  listInput: listInputSchema,
  listOutput: listOutputSchema,
  getInput: getInputSchema,
  getOutput: getOutputSchema,
  actionInput: actionInputSchema,
  actionOutput: actionOutputSchema,
} as const satisfies Record<string, AdminJsonSchema>;
function resourceOperations(
  resource: SecFnAdminResourceDefinition,
): AdminOperationDefinition[] {
  const baseId = "secfn." + resource.id,
    basePath = "/resources/" + resource.id;
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
      permission: "secfn." + resource.id + ".read",
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
      permission: "secfn." + resource.id + ".read",
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
  action: SecFnAdminActionDefinition,
): AdminOperationDefinition {
  const sensitiveFields =
    secFnAdminResources.find((resource) => resource.id === action.resource)
      ?.sensitiveFields ?? [];
  return {
    id: "secfn." + action.resource + "." + action.id,
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
    permission: "secfn." + action.resource + "." + action.id,
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
  ...secFnAdminResources.flatMap(resourceOperations),
  ...secFnAdminActions.map(actionOperation),
];
type FunctionAdminActionOperationId<TModule extends string, TAction> =
  TAction extends { resource: infer TResource extends string; id: infer TActionId extends string }
    ? `${TModule}.${TResource}.${TActionId}`
    : never;
export type SecFnAdminOperationId =
  | `secfn.${(typeof secFnAdminResources)[number]["id"]}.list`
  | `secfn.${(typeof secFnAdminResources)[number]["id"]}.get`
  | FunctionAdminActionOperationId<"secfn", (typeof secFnAdminActions)[number]>;
export const secFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "secfn",
  displayName: "SecFn",
  version: "1.0.0",
  description:
    "Commercial-grade, function-owned operator capabilities for SecFn.",
  category: "security",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: secFnAdminResources,
  navigation: [
    {
      id: "secfn",
      label: "SecFn",
      path: "/modules/secfn",
      icon: "secfn",
      description: "Operate SecFn in the active scope.",
      order: 100,
    },
  ],
  operations: operations as readonly (AdminOperationDefinition & { readonly id: SecFnAdminOperationId })[],
});
export function createSecFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(secFnAdminCapability, adminClient);
}
export interface SecFnAdminServiceRequest {
  operationId: SecFnAdminOperationId;
  input: unknown;
  context: AdminOperationContext;
}
export interface SecFnAdminService {
  execute(
    request: SecFnAdminServiceRequest,
  ):
    | Promise<AdminOperationResult<Record<string, unknown>>>
    | AdminOperationResult<Record<string, unknown>>;
}
export function createSecFnAdminAdapter(
  service: SecFnAdminService,
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
  for (const operation of secFnAdminCapability.operations)
    handlers[operation.id] = (request) =>
      service.execute({
        operationId: operation.id,
        input: request.input,
        context: request.context,
      });
  return createKernelAdminCapabilityAdapter(secFnAdminCapability, handlers);
}
export const adminCapability = secFnAdminCapability;
export const createAdminAdapter = createSecFnAdminAdapter;
