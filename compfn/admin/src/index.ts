import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminCapabilityAdapter,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationDefinition,
  type AdminOperationRequest,
  type AdminOperationResult,
} from "@superfunctions/admin";

export interface CompFnAdminResourceDefinition {
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
export interface CompFnAdminActionDefinition {
  id: string;
  resource: string;
  title: string;
  description: string;
  classification: "write" | "destructive";
  requiresConfirmation: boolean;
  idempotent: true;
  target: "resource" | "collection";
}
export const compFnAdminResources = [
  {
    id: "frameworks",
    label: "Frameworks",
    description: "Inspect and operate frameworks in CompFn.",
    icon: "compfn:frameworks",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "version", "updatedAt"],
    searchableFields: ["id", "name", "description", "version"],
    filterableFields: ["id", "name", "version"],
    sortableFields: ["createdAt", "updatedAt", "name", "version", "id"],
    sensitiveFields: [],
  },
  {
    id: "controls",
    label: "Controls",
    description: "Inspect and operate controls in CompFn.",
    icon: "compfn:controls",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "category", "updatedAt"],
    searchableFields: ["id", "name", "description", "category"],
    filterableFields: ["id", "category", "tags"],
    sortableFields: ["createdAt", "updatedAt", "name", "category", "id"],
    sensitiveFields: [],
  },
  {
    id: "checks",
    label: "Checks",
    description: "Inspect and operate checks in CompFn.",
    icon: "compfn:checks",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "controlId", "adapterName", "updatedAt"],
    searchableFields: ["id", "name", "controlId", "adapterName"],
    filterableFields: ["id", "controlId", "adapterName"],
    sortableFields: ["createdAt", "updatedAt", "name", "id"],
    sensitiveFields: [],
  },
  {
    id: "evidence",
    label: "Evidence",
    description: "Inspect and operate evidence in CompFn.",
    icon: "compfn:evidence",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "controlId", "type", "outcome", "timestamp"],
    searchableFields: ["id", "controlId", "actorId", "type", "sourceId"],
    filterableFields: ["id", "controlId", "frameworkId", "type", "since", "outcome", "actorId"],
    sortableFields: ["createdAt", "timestamp", "type", "outcome", "id"],
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
    id: "policies",
    label: "Policies",
    description: "Inspect and operate policies in CompFn.",
    icon: "compfn:policies",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "risks",
    label: "Risks",
    description: "Inspect and operate risks in CompFn.",
    icon: "compfn:risks",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "exceptions",
    label: "Exceptions",
    description: "Inspect and operate exceptions in CompFn.",
    icon: "compfn:exceptions",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "owners",
    label: "Owners",
    description: "Inspect and operate owners in CompFn.",
    icon: "compfn:owners",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name", "status"],
    filterableFields: ["status", "createdAt", "updatedAt"],
    sortableFields: ["createdAt", "updatedAt", "name"],
    sensitiveFields: [],
  },
  {
    id: "auditors",
    label: "Auditors",
    description: "Inspect and operate auditors in CompFn.",
    icon: "compfn:auditors",
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
    id: "reports",
    label: "Reports",
    description: "Inspect and operate reports in CompFn.",
    icon: "compfn:reports",
    risk: "sensitive",
    idField: "id",
    displayFields: ["exportedAt", "frameworkId"],
    searchableFields: [],
    filterableFields: [],
    sortableFields: [],
    sensitiveFields: ["value"],
  },
] as const satisfies readonly CompFnAdminResourceDefinition[];
export const compFnAdminActions = [
  {
    id: "map-control",
    resource: "controls",
    title: "Map Control",
    description: "Map Control for controls.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "collect-evidence",
    resource: "evidence",
    title: "Collect Evidence",
    description: "Collect Evidence for evidence.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "approve-evidence",
    resource: "evidence",
    title: "Approve Evidence",
    description: "Approve Evidence for evidence.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "accept-risk",
    resource: "risks",
    title: "Accept Risk",
    description: "Accept Risk for risks.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "grant-exception",
    resource: "exceptions",
    title: "Grant Exception",
    description: "Grant Exception for exceptions.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "generate-report",
    resource: "reports",
    title: "Generate Report",
    description: "Generate Report for reports.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
] as const satisfies readonly CompFnAdminActionDefinition[];

export interface CompFnAdminResourcePolicy {
  defaultScope: "active";
  permission: string;
  redaction: "none" | "sensitive-fields";
}

export interface CompFnAdminOperationPolicy {
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
    domain: "compfn";
    requestIdPath: "context.requestId";
    correlationIdPath: "context.correlationId";
  };
}

export const compFnAdminResourcePolicies = Object.freeze(
  Object.fromEntries(
    compFnAdminResources.map((resource) => [
      resource.id,
      {
        defaultScope: "active",
        permission: "compfn." + resource.id + ".read",
        redaction:
          resource.sensitiveFields.length > 0 ? "sensitive-fields" : "none",
      } satisfies CompFnAdminResourcePolicy,
    ]),
  ),
) as Readonly<Record<string, CompFnAdminResourcePolicy>>;

export const compFnAdminOperationPolicies = Object.freeze(
  Object.fromEntries(
    compFnAdminActions.map((action) => [
      "compfn." + action.resource + "." + action.id,
      {
        permission: "compfn." + action.resource + "." + action.id,
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
          action: "compfn." + action.id,
          targetResource: action.resource,
          ...(action.target === "resource"
            ? { targetIdPath: "$.id" as const }
            : { collection: true as const }),
        },
        observation: {
          domain: "compfn",
          requestIdPath: "context.requestId",
          correlationIdPath: "context.correlationId",
        },
      } satisfies CompFnAdminOperationPolicy,
    ]),
  ),
) as Readonly<Record<string, CompFnAdminOperationPolicy>>;

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
const domainActionInputSchemas: Record<string, AdminObjectSchema> = {
  "collect-evidence": {
    type: "object",
    properties: { payload: { type: "object", additionalProperties: true } },
    required: ["payload"],
    additionalProperties: false,
  },
  "generate-report": {
    type: "object",
    properties: {
      payload: {
        type: "object",
        properties: {
          frameworkId: { type: "string", minLength: 1 },
          since: { type: "number", minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};
export const compFnAdminSchemas = {
  entity: entitySchema,
  listInput: listInputSchema,
  listOutput: listOutputSchema,
  getInput: getInputSchema,
  getOutput: getOutputSchema,
  actionInput: actionInputSchema,
  actionOutput: actionOutputSchema,
} as const satisfies Record<string, AdminJsonSchema>;

function resourceOperations(
  resource: CompFnAdminResourceDefinition,
): AdminOperationDefinition[] {
  const baseId = "compfn." + resource.id;
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
      permission: "compfn." + resource.id + ".read",
      minimumScope: "workspace",
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
      permission: "compfn." + resource.id + ".read",
      minimumScope: "workspace",
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
  action: CompFnAdminActionDefinition,
): AdminOperationDefinition {
  const sensitiveFields =
    compFnAdminResources.find((resource) => resource.id === action.resource)
      ?.sensitiveFields ?? [];
  return {
    id: "compfn." + action.resource + "." + action.id,
    title: action.title,
    description: action.description,
    inputSchema: domainActionInputSchemas[action.id] ?? (
      action.target === "resource"
        ? { ...actionInputSchema, required: ["id"] }
        : actionInputSchema
    ),
    outputSchema: actionOutputSchema,
    route: {
      method: "POST",
      path: "/resources/" + action.resource + "/actions/" + action.id,
    },
    permission: "compfn." + action.resource + "." + action.id,
    minimumScope: "workspace",
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
const domainResourceIds = new Set(["frameworks", "controls", "checks", "evidence", "reports"]);
const domainActionIds = new Set(["collect-evidence", "generate-report"]);
const domainResources = compFnAdminResources.filter((resource) => domainResourceIds.has(resource.id));
const domainActions = compFnAdminActions.filter((action) => domainActionIds.has(action.id));
const operations: AdminOperationDefinition[] = [
  ...domainResources.filter((resource) => resource.id !== "reports").flatMap(resourceOperations),
  ...domainActions.map(actionOperation),
];
type FunctionAdminActionOperationId<TModule extends string, TAction> =
  TAction extends { resource: infer TResource extends string; id: infer TActionId extends string }
    ? `${TModule}.${TResource}.${TActionId}`
    : never;
type CompFnDomainReadResourceId = "frameworks" | "controls" | "checks" | "evidence";
type CompFnDomainAction = Extract<
  (typeof compFnAdminActions)[number],
  { id: "collect-evidence" | "generate-report" }
>;
export type CompFnAdminOperationId =
  | `compfn.${CompFnDomainReadResourceId}.list`
  | `compfn.${CompFnDomainReadResourceId}.get`
  | FunctionAdminActionOperationId<"compfn", CompFnDomainAction>;
export const compFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "compfn",
  displayName: "CompFn",
  version: "1.0.0",
  description:
    "Function-owned CompFn operator capabilities backed by an exact scoped compliance API.",
  category: "security",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: domainResources,
  navigation: [
    {
      id: "compfn",
      label: "CompFn",
      path: "/modules/compfn",
      icon: "compfn",
      description: "Operate CompFn in the active scope.",
      order: 100,
    },
  ],
  operations: operations as readonly (AdminOperationDefinition & { readonly id: CompFnAdminOperationId })[],
});

export interface CompFnAdminListInput {
  search?: string;
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}
export interface CompFnAdminGetInput { id: string }
export interface CompFnCollectEvidenceInput { payload: Record<string, unknown> }
export interface CompFnGenerateReportInput {
  payload?: { frameworkId?: string; since?: number };
}
type CompFnAdminResult = AdminOperationResult<Record<string, unknown>>;

export function createCompFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(compFnAdminCapability, adminClient);
  return Object.assign(client, {
    frameworks: {
      list: (input: CompFnAdminListInput = {}, options?: AdminClientRequestOptions) => client.invoke("compfn.frameworks.list", input, options),
      get: (input: CompFnAdminGetInput, options?: AdminClientRequestOptions) => client.invoke("compfn.frameworks.get", input, options),
    },
    controls: {
      list: (input: CompFnAdminListInput = {}, options?: AdminClientRequestOptions) => client.invoke("compfn.controls.list", input, options),
      get: (input: CompFnAdminGetInput, options?: AdminClientRequestOptions) => client.invoke("compfn.controls.get", input, options),
    },
    checks: {
      list: (input: CompFnAdminListInput = {}, options?: AdminClientRequestOptions) => client.invoke("compfn.checks.list", input, options),
      get: (input: CompFnAdminGetInput, options?: AdminClientRequestOptions) => client.invoke("compfn.checks.get", input, options),
    },
    evidence: {
      list: (input: CompFnAdminListInput = {}, options?: AdminClientRequestOptions) => client.invoke("compfn.evidence.list", input, options),
      get: (input: CompFnAdminGetInput, options?: AdminClientRequestOptions) => client.invoke("compfn.evidence.get", input, options),
      collect: (input: CompFnCollectEvidenceInput, options?: AdminClientRequestOptions) => client.invoke("compfn.evidence.collect-evidence", input, options),
    },
    reports: {
      generate: (input: CompFnGenerateReportInput = {}, options?: AdminClientRequestOptions) => client.invoke("compfn.reports.generate-report", input, options),
    },
  });
}
export interface CompFnAdminService {
  listFrameworks(input: CompFnAdminListInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  getFramework(input: CompFnAdminGetInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  listControls(input: CompFnAdminListInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  getControl(input: CompFnAdminGetInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  listChecks(input: CompFnAdminListInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  getCheck(input: CompFnAdminGetInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  listEvidence(input: CompFnAdminListInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  getEvidence(input: CompFnAdminGetInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  collectEvidence(input: CompFnCollectEvidenceInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
  generateReport(input: CompFnGenerateReportInput, context: AdminOperationContext): Promise<CompFnAdminResult>;
}

function bind<TInput>(
  handler: (input: TInput, context: AdminOperationContext) => Promise<CompFnAdminResult>,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

export function createCompFnAdminAdapter(
  service: CompFnAdminService,
): AdminCapabilityAdapter {
  return createKernelAdminCapabilityAdapter(compFnAdminCapability, {
    "compfn.frameworks.list": bind(service.listFrameworks),
    "compfn.frameworks.get": bind(service.getFramework),
    "compfn.controls.list": bind(service.listControls),
    "compfn.controls.get": bind(service.getControl),
    "compfn.checks.list": bind(service.listChecks),
    "compfn.checks.get": bind(service.getCheck),
    "compfn.evidence.list": bind(service.listEvidence),
    "compfn.evidence.get": bind(service.getEvidence),
    "compfn.evidence.collect-evidence": bind(service.collectEvidence),
    "compfn.reports.generate-report": bind(service.generateReport),
  });
}
export const adminCapability = compFnAdminCapability;
export const createAdminAdapter = createCompFnAdminAdapter;
export {
  createCompFnDomainAdminService,
  type CompFnDomainAdminServiceOptions,
} from "./domain-service.js";
