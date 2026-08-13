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
export interface SendFnAdminResourceDefinition {
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
export interface SendFnAdminActionDefinition {
  id: string;
  resource: string;
  title: string;
  description: string;
  classification: "write" | "destructive";
  requiresConfirmation: boolean;
  idempotent: true;
  target: "resource" | "collection";
}
export const sendFnAdminResources = [
  {
    id: "providers",
    label: "Providers",
    description: "Inspect and operate providers in SendFn.",
    icon: "sendfn:providers",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "credentials",
    label: "Credentials",
    description: "Inspect and operate credentials in SendFn.",
    icon: "sendfn:credentials",
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
    id: "domains-senders",
    label: "Domains Senders",
    description: "Inspect and operate domains senders in SendFn.",
    icon: "sendfn:domains-senders",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "templates",
    label: "Templates",
    description: "Inspect and operate templates in SendFn.",
    icon: "sendfn:templates",
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
    description: "Inspect and operate messages in SendFn.",
    icon: "sendfn:messages",
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
    id: "batches",
    label: "Batches",
    description: "Inspect and operate batches in SendFn.",
    icon: "sendfn:batches",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "delivery-events",
    label: "Delivery Events",
    description: "Inspect and operate delivery events in SendFn.",
    icon: "sendfn:delivery-events",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "contacts",
    label: "Contacts",
    description: "Inspect and operate contacts in SendFn.",
    icon: "sendfn:contacts",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "suppressions-unsubscribes",
    label: "Suppressions Unsubscribes",
    description: "Inspect and operate suppressions unsubscribes in SendFn.",
    icon: "sendfn:suppressions-unsubscribes",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "device-tokens",
    label: "Device Tokens",
    description: "Inspect and operate device tokens in SendFn.",
    icon: "sendfn:device-tokens",
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
    id: "webhooks",
    label: "Webhooks",
    description: "Inspect and operate webhooks in SendFn.",
    icon: "sendfn:webhooks",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "usage",
    label: "Usage",
    description: "Inspect and operate usage in SendFn.",
    icon: "sendfn:usage",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
] as const satisfies readonly SendFnAdminResourceDefinition[];
export const sendFnAdminActions = [
  {
    id: "verify-domain",
    resource: "domains-senders",
    title: "Verify Domain",
    description: "Verify Domain for domains senders.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "send-message",
    resource: "messages",
    title: "Send Message",
    description: "Send Message for messages.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "send-batch",
    resource: "batches",
    title: "Send Batch",
    description: "Send Batch for batches.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "cancel-batch",
    resource: "batches",
    title: "Cancel Batch",
    description: "Cancel Batch for batches.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "retry-delivery",
    resource: "delivery-events",
    title: "Retry Delivery",
    description: "Retry Delivery for delivery events.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-template",
    resource: "templates",
    title: "Manage Template",
    description: "Manage Template for templates.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-contact",
    resource: "contacts",
    title: "Manage Contact",
    description: "Manage Contact for contacts.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-suppression",
    resource: "suppressions-unsubscribes",
    title: "Manage Suppression",
    description: "Manage Suppression for suppressions unsubscribes.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-device",
    resource: "device-tokens",
    title: "Manage Device",
    description: "Manage Device for device tokens.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-webhook",
    resource: "webhooks",
    title: "Manage Webhook",
    description: "Manage Webhook for webhooks.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "rotate-key",
    resource: "credentials",
    title: "Rotate Key",
    description: "Rotate Key for credentials.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
] as const satisfies readonly SendFnAdminActionDefinition[];

export interface SendFnAdminResourcePolicy {
  defaultScope: "active";
  permission: string;
  redaction: "none" | "sensitive-fields";
}

export interface SendFnAdminOperationPolicy {
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
    domain: "sendfn";
    requestIdPath: "context.requestId";
    correlationIdPath: "context.correlationId";
  };
}

export const sendFnAdminResourcePolicies = Object.freeze(
  Object.fromEntries(
    sendFnAdminResources.map((resource) => [
      resource.id,
      {
        defaultScope: "active",
        permission: "sendfn." + resource.id + ".read",
        redaction:
          resource.sensitiveFields.length > 0 ? "sensitive-fields" : "none",
      } satisfies SendFnAdminResourcePolicy,
    ]),
  ),
) as Readonly<Record<string, SendFnAdminResourcePolicy>>;

export const sendFnAdminOperationPolicies = Object.freeze(
  Object.fromEntries(
    sendFnAdminActions.map((action) => [
      "sendfn." + action.resource + "." + action.id,
      {
        permission: "sendfn." + action.resource + "." + action.id,
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
          action: "sendfn." + action.id,
          targetResource: action.resource,
          ...(action.target === "resource"
            ? { targetIdPath: "$.id" as const }
            : { collection: true as const }),
        },
        observation: {
          domain: "sendfn",
          requestIdPath: "context.requestId",
          correlationIdPath: "context.correlationId",
        },
      } satisfies SendFnAdminOperationPolicy,
    ]),
  ),
) as Readonly<Record<string, SendFnAdminOperationPolicy>>;

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
export const sendFnAdminSchemas = {
  entity: entitySchema,
  listInput: listInputSchema,
  listOutput: listOutputSchema,
  getInput: getInputSchema,
  getOutput: getOutputSchema,
  actionInput: actionInputSchema,
  actionOutput: actionOutputSchema,
} as const satisfies Record<string, AdminJsonSchema>;
function resourceOperations(
  resource: SendFnAdminResourceDefinition,
): AdminOperationDefinition[] {
  const baseId = "sendfn." + resource.id,
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
      permission: "sendfn." + resource.id + ".read",
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
      permission: "sendfn." + resource.id + ".read",
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
  action: SendFnAdminActionDefinition,
): AdminOperationDefinition {
  const sensitiveFields =
    sendFnAdminResources.find((resource) => resource.id === action.resource)
      ?.sensitiveFields ?? [];
  return {
    id: "sendfn." + action.resource + "." + action.id,
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
    permission: "sendfn." + action.resource + "." + action.id,
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
  ...sendFnAdminResources.flatMap(resourceOperations),
  ...sendFnAdminActions.map(actionOperation),
];
type FunctionAdminActionOperationId<TModule extends string, TAction> =
  TAction extends { resource: infer TResource extends string; id: infer TActionId extends string }
    ? `${TModule}.${TResource}.${TActionId}`
    : never;
export type SendFnAdminOperationId =
  | `sendfn.${(typeof sendFnAdminResources)[number]["id"]}.list`
  | `sendfn.${(typeof sendFnAdminResources)[number]["id"]}.get`
  | FunctionAdminActionOperationId<"sendfn", (typeof sendFnAdminActions)[number]>;
export const sendFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "sendfn",
  displayName: "SendFn",
  version: "1.0.0",
  description:
    "Commercial-grade, function-owned operator capabilities for SendFn.",
  category: "communication",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: sendFnAdminResources,
  navigation: [
    {
      id: "sendfn",
      label: "SendFn",
      path: "/modules/sendfn",
      icon: "sendfn",
      description: "Operate SendFn in the active scope.",
      order: 100,
    },
  ],
  operations: operations as readonly (AdminOperationDefinition & { readonly id: SendFnAdminOperationId })[],
});
export function createSendFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(sendFnAdminCapability, adminClient);
}
export interface SendFnAdminServiceRequest {
  operationId: SendFnAdminOperationId;
  input: unknown;
  context: AdminOperationContext;
}
export interface SendFnAdminService {
  execute(
    request: SendFnAdminServiceRequest,
  ):
    | Promise<AdminOperationResult<Record<string, unknown>>>
    | AdminOperationResult<Record<string, unknown>>;
}
export function createSendFnAdminAdapter(
  service: SendFnAdminService,
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
  for (const operation of sendFnAdminCapability.operations)
    handlers[operation.id] = (request) =>
      service.execute({
        operationId: operation.id,
        input: request.input,
        context: request.context,
      });
  return createKernelAdminCapabilityAdapter(sendFnAdminCapability, handlers);
}
export const adminCapability = sendFnAdminCapability;
export const createAdminAdapter = createSendFnAdminAdapter;
