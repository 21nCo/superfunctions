import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminCapabilityAdapter,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationDefinition,
  type AdminOperationRequest,
  type AdminOperationResult,
} from "@superfunctions/admin";

type JsonRecord = Record<string, unknown>;

export interface SecFnAdminResourceDefinition {
  id: "namespaces" | "environments" | "secrets" | "secret-sets" | "secret-set-members" | "audit-events" | "scanner" | "rate-limits";
  label: string;
  description: string;
  icon: string;
  risk: "standard" | "sensitive";
  minimumScope: "project";
  idField: string;
  displayFields: readonly string[];
  searchableFields: readonly string[];
  filterableFields: readonly string[];
  sortableFields: readonly string[];
  sensitiveFields: readonly string[];
}

export const secFnAdminResources = [
  { id: "namespaces", label: "Namespaces", description: "SecFn namespaces inside the active project tenant.", icon: "secfn:namespaces", risk: "standard", minimumScope: "project", idField: "id", displayFields: ["id", "slug", "label", "updatedAt"], searchableFields: ["slug", "label"], filterableFields: [], sortableFields: ["label", "updatedAt"], sensitiveFields: [] },
  { id: "environments", label: "Environments", description: "SecFn environments inside the active project and namespace.", icon: "secfn:environments", risk: "standard", minimumScope: "project", idField: "id", displayFields: ["id", "name", "description", "updatedAt"], searchableFields: ["name", "description"], filterableFields: ["namespaceId"], sortableFields: ["name", "updatedAt"], sensitiveFields: [] },
  { id: "secrets", label: "Secrets", description: "Secret metadata in the active SecFn scope. Plaintext is never returned by this admin binding.", icon: "secfn:secrets", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "key", "environment", "currentVersion", "updatedAt", "revokedAt"], searchableFields: ["key", "description", "tags"], filterableFields: ["environment", "tags", "revokedAt"], sortableFields: ["key", "updatedAt"], sensitiveFields: ["value", "encryptedPayload", "token", "tokenHash"] },
  { id: "secret-sets", label: "Secret Sets", description: "Named sets of secrets in the active SecFn namespace. Plaintext values are never returned.", icon: "secfn:secret-sets", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "name", "description", "updatedAt"], searchableFields: ["name", "description"], filterableFields: ["namespaceId"], sortableFields: ["name", "updatedAt"], sensitiveFields: ["value", "secrets", "dotenv"] },
  { id: "secret-set-members", label: "Secret Set Members", description: "Membership records for a scoped SecFn secret set.", icon: "secfn:secret-set-members", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "setId", "secretId", "alias", "createdAt"], searchableFields: ["secretId", "alias"], filterableFields: ["setId"], sortableFields: ["createdAt"], sensitiveFields: [] },
  { id: "audit-events", label: "Security Audit", description: "SecFn security events constrained to the active project and namespace.", icon: "secfn:audit", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "timestamp", "type", "severity", "actorId", "action", "resolved"], searchableFields: ["type", "actorId", "resource", "action"], filterableFields: ["type", "severity", "actorId", "resolved"], sortableFields: ["timestamp"], sensitiveFields: ["ip", "userAgent"] },
  { id: "scanner", label: "Secret Scanner", description: "Run SecFn's in-process scanner over submitted content without persisting the content.", icon: "secfn:scanner", risk: "sensitive", minimumScope: "project", idField: "fingerprint", displayFields: ["fingerprint", "ruleId", "severity", "file", "line"], searchableFields: ["ruleId", "ruleName", "file"], filterableFields: ["severity"], sortableFields: ["severity", "file", "line"], sensitiveFields: ["content", "match", "context"] },
  { id: "rate-limits", label: "Rate Limits", description: "Evaluate the configured SecFn rate limiter for an active-scope request identity.", icon: "secfn:rate-limits", risk: "sensitive", minimumScope: "project", idField: "scope", displayFields: ["scope", "allowed", "remaining", "resetAt"], searchableFields: [], filterableFields: ["scope", "allowed"], sortableFields: ["resetAt"], sensitiveFields: ["ip"] },
] as const satisfies readonly SecFnAdminResourceDefinition[];

export interface PageInput { limit?: number; cursor?: string }
export interface NamespaceListInput extends PageInput { search?: string }
export interface CreateNamespaceInput { slug: string; label?: string; description?: string; metadata?: JsonRecord }
export interface UpdateNamespaceInput { id: string; slug?: string; label?: string; description?: string | null; metadata?: JsonRecord | null }
export interface EnvironmentListInput extends PageInput { search?: string }
export interface CreateEnvironmentInput { name: string; description?: string; metadata?: JsonRecord }
export interface UpdateEnvironmentInput { id: string; name?: string; description?: string | null; metadata?: JsonRecord | null }
export interface SecretListInput extends PageInput { search?: string; tag?: string }
export interface IdInput { id: string }
export interface CreateSecretInput { key: string; value: string; description?: string; tags?: string[]; metadata?: JsonRecord }
export interface UpdateSecretInput { id: string; key?: string; description?: string | null; tags?: string[] }
export interface RotateSecretInput { id: string; value: string }
export interface CreateSecretSetInput { name: string; description?: string; members?: Array<{ secretId: string; alias?: string }> }
export interface UpdateSecretSetInput { id: string; name?: string; description?: string | null }
export interface SecretSetMemberListInput { setId: string }
export interface AddSecretSetMemberInput { setId: string; secretId: string; alias?: string }
export interface UpdateSecretSetMemberInput { setId: string; id: string; secretId?: string; alias?: string | null }
export interface RemoveSecretSetMemberInput { setId: string; id: string }
export interface AuditEventListInput { type?: string; severity?: string; actorId?: string; resolved?: boolean; limit?: number }
export interface ScanContentInput { content: string; path: string; displayPath?: string }
export interface RateLimitCheckInput { userId?: string; ip?: string; endpoint?: string }

export interface SecFnAdminOperationInputMap {
  "secfn.namespaces.list": NamespaceListInput;
  "secfn.namespaces.create": CreateNamespaceInput;
  "secfn.namespaces.update": UpdateNamespaceInput;
  "secfn.environments.list": EnvironmentListInput;
  "secfn.environments.create": CreateEnvironmentInput;
  "secfn.environments.update": UpdateEnvironmentInput;
  "secfn.secrets.list": SecretListInput;
  "secfn.secrets.get": IdInput;
  "secfn.secrets.create": CreateSecretInput;
  "secfn.secrets.update": UpdateSecretInput;
  "secfn.secrets.rotate": RotateSecretInput;
  "secfn.secrets.revoke": IdInput;
  "secfn.secrets.delete": IdInput;
  "secfn.secret-sets.list": PageInput;
  "secfn.secret-sets.get": IdInput;
  "secfn.secret-sets.create": CreateSecretSetInput;
  "secfn.secret-sets.update": UpdateSecretSetInput;
  "secfn.secret-sets.delete": IdInput;
  "secfn.secret-set-members.list": SecretSetMemberListInput;
  "secfn.secret-set-members.add": AddSecretSetMemberInput;
  "secfn.secret-set-members.update": UpdateSecretSetMemberInput;
  "secfn.secret-set-members.remove": RemoveSecretSetMemberInput;
  "secfn.audit-events.list": AuditEventListInput;
  "secfn.scanner.scan-content": ScanContentInput;
  "secfn.rate-limits.check": RateLimitCheckInput;
}
export type SecFnAdminOperationId = keyof SecFnAdminOperationInputMap;

const stringSchema = (description?: string) => ({ type: "string", minLength: 1, maxLength: 2000, ...(description ? { description } : {}) } as const);
const nullableStringSchema = { type: ["string", "null"], maxLength: 2000 } satisfies import("@superfunctions/admin").AdminJsonSchema;
const metadataSchema = { type: "object", additionalProperties: true } as const;
const entitySchema: AdminObjectSchema = { type: "object", additionalProperties: true };
const listOutputSchema: AdminObjectSchema = { type: "object", properties: { items: { type: "array", items: entitySchema }, nextCursor: { type: ["string", "null"] } }, required: ["items"], additionalProperties: false };
const itemOutputSchema: AdminObjectSchema = { type: "object", properties: { item: entitySchema }, required: ["item"], additionalProperties: false };
const acceptedOutputSchema: AdminObjectSchema = { type: "object", properties: { accepted: { type: "boolean" }, item: entitySchema }, required: ["accepted"], additionalProperties: true };
const idInputSchema: AdminObjectSchema = { type: "object", properties: { id: stringSchema("Domain resource identifier.") }, required: ["id"], additionalProperties: false };
const pageInputSchema: AdminObjectSchema = { type: "object", properties: { cursor: stringSchema(), limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, additionalProperties: false };
const searchListInputSchema: AdminObjectSchema = { type: "object", properties: { cursor: stringSchema(), limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, search: { type: "string", maxLength: 500 } }, additionalProperties: false };
const createNamespaceInputSchema: AdminObjectSchema = { type: "object", properties: { slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }, label: { type: "string", maxLength: 200 }, description: { type: "string", maxLength: 2000 }, metadata: metadataSchema }, required: ["slug"], additionalProperties: false };
const updateNamespaceInputSchema: AdminObjectSchema = { type: "object", properties: { id: stringSchema(), slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }, label: { type: "string", maxLength: 200 }, description: nullableStringSchema, metadata: { type: ["object", "null"], additionalProperties: true } }, required: ["id"], additionalProperties: false };
const createEnvironmentInputSchema: AdminObjectSchema = { type: "object", properties: { name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" }, description: { type: "string", maxLength: 2000 }, metadata: metadataSchema }, required: ["name"], additionalProperties: false };
const updateEnvironmentInputSchema: AdminObjectSchema = { type: "object", properties: { id: stringSchema(), name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" }, description: nullableStringSchema, metadata: { type: ["object", "null"], additionalProperties: true } }, required: ["id"], additionalProperties: false };
const secretListInputSchema: AdminObjectSchema = { type: "object", properties: { cursor: stringSchema(), limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, search: { type: "string", maxLength: 500 }, tag: { type: "string", maxLength: 200 } }, additionalProperties: false };
const createSecretInputSchema: AdminObjectSchema = { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 500 }, value: { type: "string", minLength: 1 }, description: { type: "string", maxLength: 2000 }, tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 100, uniqueItems: true }, metadata: metadataSchema }, required: ["key", "value"], additionalProperties: false };
const updateSecretInputSchema: AdminObjectSchema = { type: "object", properties: { id: stringSchema(), key: { type: "string", minLength: 1, maxLength: 500 }, description: nullableStringSchema, tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 100, uniqueItems: true } }, required: ["id"], additionalProperties: false };
const rotateSecretInputSchema: AdminObjectSchema = { type: "object", properties: { id: stringSchema(), value: { type: "string", minLength: 1 } }, required: ["id", "value"], additionalProperties: false };
const secretSetMemberSchema: AdminObjectSchema = { type: "object", properties: { secretId: stringSchema(), alias: { type: "string", maxLength: 500 } }, required: ["secretId"], additionalProperties: false };
const createSecretSetInputSchema: AdminObjectSchema = { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 500 }, description: { type: "string", maxLength: 2000 }, members: { type: "array", items: secretSetMemberSchema, maxItems: 500 } }, required: ["name"], additionalProperties: false };
const updateSecretSetInputSchema: AdminObjectSchema = { type: "object", properties: { id: stringSchema(), name: { type: "string", minLength: 1, maxLength: 500 }, description: nullableStringSchema }, required: ["id"], additionalProperties: false };
const setIdInputSchema: AdminObjectSchema = { type: "object", properties: { setId: stringSchema() }, required: ["setId"], additionalProperties: false };
const addMemberInputSchema: AdminObjectSchema = { type: "object", properties: { setId: stringSchema(), secretId: stringSchema(), alias: { type: "string", maxLength: 500 } }, required: ["setId", "secretId"], additionalProperties: false };
const updateMemberInputSchema: AdminObjectSchema = { type: "object", properties: { setId: stringSchema(), id: stringSchema(), secretId: stringSchema(), alias: nullableStringSchema }, required: ["setId", "id"], additionalProperties: false };
const removeMemberInputSchema: AdminObjectSchema = { type: "object", properties: { setId: stringSchema(), id: stringSchema() }, required: ["setId", "id"], additionalProperties: false };
const auditListInputSchema: AdminObjectSchema = { type: "object", properties: { type: { type: "string", maxLength: 200 }, severity: { type: "string", enum: ["low", "medium", "high", "critical", "info", "warning", "error"] }, actorId: { type: "string", maxLength: 500 }, resolved: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } }, additionalProperties: false };
const scanContentInputSchema: AdminObjectSchema = { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: 1_048_576 }, path: { type: "string", minLength: 1, maxLength: 4096 }, displayPath: { type: "string", maxLength: 4096 } }, required: ["content", "path"], additionalProperties: false };
const scanOutputSchema: AdminObjectSchema = { type: "object", properties: { accepted: { type: "boolean" }, findings: { type: "array", items: entitySchema }, findingCount: { type: "integer", minimum: 0 } }, required: ["accepted", "findings", "findingCount"], additionalProperties: false };
const rateLimitInputSchema: AdminObjectSchema = { type: "object", properties: { userId: { type: "string", maxLength: 500 }, ip: { type: "string", maxLength: 200 }, endpoint: { type: "string", maxLength: 2000 } }, additionalProperties: false };

interface OperationOptions<TId extends SecFnAdminOperationId> {
  id: TId;
  title: string;
  description: string;
  resource: SecFnAdminResourceDefinition["id"];
  inputSchema: AdminObjectSchema;
  outputSchema: AdminObjectSchema;
  route: string;
  read?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  confirmation?: "explicit" | "recent-auth" | "mfa";
  collection?: boolean;
  idInput?: string;
  pagination?: boolean;
  inputFields?: readonly string[];
  outputFields?: readonly string[];
}

function operation<TId extends SecFnAdminOperationId>(options: OperationOptions<TId>): AdminOperationDefinition<SecFnAdminOperationInputMap[TId], JsonRecord> & { id: TId } {
  const read = options.read ?? false;
  const destructive = options.destructive ?? false;
  const confirmation = options.confirmation;
  const idempotent = options.idempotent ?? true;
  const redaction = options.inputFields
    ? { inputFields: options.inputFields, ...(options.outputFields ? { outputFields: options.outputFields } : {}) }
    : options.outputFields
      ? { outputFields: options.outputFields }
      : undefined;
  return {
    id: options.id,
    title: options.title,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    route: { method: read ? "GET" : "POST", path: options.route },
    permission: options.id,
    minimumScope: "project",
    safety: {
      classification: read ? "read" : destructive ? "destructive" : "write",
      idempotent,
      requiresConfirmation: Boolean(confirmation),
      ...(confirmation ? { confirmation: { risk: destructive ? "critical" as const : "high" as const, method: confirmation, reason: options.description, maxAgeSeconds: confirmation === "explicit" ? undefined : 300 } } : {}),
      audit: read ? (options.resource === "audit-events" || options.resource === "secrets" || options.resource === "secret-sets" ? "required" : "optional") : "required",
    },
    ...(options.pagination ? { pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 200 } as const } : {}),
    mcp: { readOnlyHint: read, destructiveHint: destructive, idempotentHint: idempotent },
    ...(redaction ? { redaction } : {}),
    target: options.collection ? { resource: options.resource, collection: true } : { resource: options.resource, idInput: options.idInput ?? "id" },
  };
}

const operations = [
  operation({ id: "secfn.namespaces.list", title: "List namespaces", description: "List namespaces in the active SecFn project tenant.", resource: "namespaces", inputSchema: searchListInputSchema, outputSchema: listOutputSchema, route: "/resources/namespaces", read: true, collection: true, pagination: true }),
  operation({ id: "secfn.namespaces.create", title: "Create namespace", description: "Create a namespace inside the active project tenant.", resource: "namespaces", inputSchema: createNamespaceInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/namespaces/actions/create", collection: true, confirmation: "recent-auth" }),
  operation({ id: "secfn.namespaces.update", title: "Update namespace", description: "Update an existing namespace inside the active project tenant.", resource: "namespaces", inputSchema: updateNamespaceInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/namespaces/actions/update", confirmation: "recent-auth" }),
  operation({ id: "secfn.environments.list", title: "List environments", description: "List environments in the active SecFn namespace.", resource: "environments", inputSchema: searchListInputSchema, outputSchema: listOutputSchema, route: "/resources/environments", read: true, collection: true, pagination: true }),
  operation({ id: "secfn.environments.create", title: "Create environment", description: "Create an environment in the active SecFn namespace.", resource: "environments", inputSchema: createEnvironmentInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/environments/actions/create", collection: true, confirmation: "recent-auth" }),
  operation({ id: "secfn.environments.update", title: "Update environment", description: "Update an environment in the active SecFn namespace.", resource: "environments", inputSchema: updateEnvironmentInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/environments/actions/update", confirmation: "recent-auth" }),
  operation({ id: "secfn.secrets.list", title: "List secrets", description: "List redacted secret metadata in the active SecFn scope.", resource: "secrets", inputSchema: secretListInputSchema, outputSchema: listOutputSchema, route: "/resources/secrets", read: true, collection: true, pagination: true, outputFields: ["value", "encryptedPayload", "token", "tokenHash"] }),
  operation({ id: "secfn.secrets.get", title: "Get secret", description: "Get redacted metadata for a secret in the active scope.", resource: "secrets", inputSchema: idInputSchema, outputSchema: itemOutputSchema, route: "/resources/secrets/:id", read: true, outputFields: ["value", "encryptedPayload", "token", "tokenHash"] }),
  operation({ id: "secfn.secrets.create", title: "Create secret", description: "Encrypt and persist a new secret in the active scope.", resource: "secrets", inputSchema: createSecretInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secrets/actions/create", collection: true, confirmation: "recent-auth", inputFields: ["value"] }),
  operation({ id: "secfn.secrets.update", title: "Update secret metadata", description: "Update secret metadata or rename a scoped secret.", resource: "secrets", inputSchema: updateSecretInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secrets/actions/update", confirmation: "recent-auth" }),
  operation({ id: "secfn.secrets.rotate", title: "Rotate secret", description: "Create a new encrypted version for a scoped secret.", resource: "secrets", inputSchema: rotateSecretInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secrets/actions/rotate", confirmation: "mfa", inputFields: ["value"] }),
  operation({ id: "secfn.secrets.revoke", title: "Revoke secret", description: "Revoke a scoped secret so runtime reads reject it.", resource: "secrets", inputSchema: idInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secrets/actions/revoke", destructive: true, confirmation: "mfa" }),
  operation({ id: "secfn.secrets.delete", title: "Delete secret", description: "Permanently delete a scoped secret record.", resource: "secrets", inputSchema: idInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secrets/actions/delete", destructive: true, confirmation: "mfa" }),
  operation({ id: "secfn.secret-sets.list", title: "List secret sets", description: "List secret-set metadata in the active namespace.", resource: "secret-sets", inputSchema: pageInputSchema, outputSchema: listOutputSchema, route: "/resources/secret-sets", read: true, collection: true, outputFields: ["value", "secrets", "dotenv"] }),
  operation({ id: "secfn.secret-sets.get", title: "Get secret set", description: "Get redacted secret-set metadata in the active namespace.", resource: "secret-sets", inputSchema: idInputSchema, outputSchema: itemOutputSchema, route: "/resources/secret-sets/:id", read: true, outputFields: ["value", "secrets", "dotenv"] }),
  operation({ id: "secfn.secret-sets.create", title: "Create secret set", description: "Create a secret set and validated memberships in the active namespace.", resource: "secret-sets", inputSchema: createSecretSetInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secret-sets/actions/create", collection: true, confirmation: "recent-auth" }),
  operation({ id: "secfn.secret-sets.update", title: "Update secret set", description: "Update scoped secret-set metadata.", resource: "secret-sets", inputSchema: updateSecretSetInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secret-sets/actions/update", confirmation: "recent-auth" }),
  operation({ id: "secfn.secret-sets.delete", title: "Delete secret set", description: "Permanently delete a scoped secret set and its memberships.", resource: "secret-sets", inputSchema: idInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secret-sets/actions/delete", destructive: true, confirmation: "mfa" }),
  operation({ id: "secfn.secret-set-members.list", title: "List secret-set members", description: "List memberships for a scoped secret set.", resource: "secret-set-members", inputSchema: setIdInputSchema, outputSchema: listOutputSchema, route: "/resources/secret-set-members", read: true, collection: true }),
  operation({ id: "secfn.secret-set-members.add", title: "Add secret-set member", description: "Add a same-namespace secret to a scoped secret set.", resource: "secret-set-members", inputSchema: addMemberInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secret-set-members/actions/add", collection: true, confirmation: "recent-auth" }),
  operation({ id: "secfn.secret-set-members.update", title: "Update secret-set member", description: "Update a validated membership in a scoped secret set.", resource: "secret-set-members", inputSchema: updateMemberInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secret-set-members/actions/update", confirmation: "recent-auth" }),
  operation({ id: "secfn.secret-set-members.remove", title: "Remove secret-set member", description: "Remove a membership from a scoped secret set.", resource: "secret-set-members", inputSchema: removeMemberInputSchema, outputSchema: acceptedOutputSchema, route: "/resources/secret-set-members/actions/remove", destructive: true, confirmation: "recent-auth" }),
  operation({ id: "secfn.audit-events.list", title: "List security audit events", description: "List SecFn security audit events in the active project and namespace.", resource: "audit-events", inputSchema: auditListInputSchema, outputSchema: listOutputSchema, route: "/resources/audit-events", read: true, collection: true, outputFields: ["ip", "userAgent"] }),
  operation({ id: "secfn.scanner.scan-content", title: "Scan content", description: "Run SecFn secret-detection rules over submitted content without persisting it.", resource: "scanner", inputSchema: scanContentInputSchema, outputSchema: scanOutputSchema, route: "/resources/scanner/actions/scan-content", collection: true, inputFields: ["content"], outputFields: ["match", "context"] }),
  operation({ id: "secfn.rate-limits.check", title: "Check rate limit", description: "Evaluate the configured SecFn rate limiter for one active-scope identity.", resource: "rate-limits", inputSchema: rateLimitInputSchema, outputSchema: itemOutputSchema, route: "/resources/rate-limits/actions/check", collection: true, idempotent: false, inputFields: ["ip"] }),
] as const;

export const secFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "secfn",
  displayName: "SecFn",
  version: "1.1.0",
  description: "Function-owned SecFn administration backed by its vault, audit, scanner, and rate-limit services.",
  category: "security",
  availability: "required-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: secFnAdminResources,
  navigation: [{ id: "secfn", label: "SecFn", path: "/modules/secfn", icon: "secfn", description: "Operate SecFn in the active project scope.", order: 100 }],
  operations,
});

export function createSecFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(secFnAdminCapability, adminClient);
  return Object.assign(client, {
    namespaces: {
      list: (input: NamespaceListInput = {}, options?: AdminClientRequestOptions) => client.invoke("secfn.namespaces.list", input, options),
      create: (input: CreateNamespaceInput, options?: AdminClientRequestOptions) => client.invoke("secfn.namespaces.create", input, options),
      update: (input: UpdateNamespaceInput, options?: AdminClientRequestOptions) => client.invoke("secfn.namespaces.update", input, options),
    },
    environments: {
      list: (input: EnvironmentListInput = {}, options?: AdminClientRequestOptions) => client.invoke("secfn.environments.list", input, options),
      create: (input: CreateEnvironmentInput, options?: AdminClientRequestOptions) => client.invoke("secfn.environments.create", input, options),
      update: (input: UpdateEnvironmentInput, options?: AdminClientRequestOptions) => client.invoke("secfn.environments.update", input, options),
    },
    secrets: {
      list: (input: SecretListInput = {}, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.list", input, options),
      get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.get", input, options),
      create: (input: CreateSecretInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.create", input, options),
      update: (input: UpdateSecretInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.update", input, options),
      rotate: (input: RotateSecretInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.rotate", input, options),
      revoke: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.revoke", input, options),
      delete: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secrets.delete", input, options),
    },
    secretSets: {
      list: (input: PageInput = {}, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-sets.list", input, options),
      get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-sets.get", input, options),
      create: (input: CreateSecretSetInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-sets.create", input, options),
      update: (input: UpdateSecretSetInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-sets.update", input, options),
      delete: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-sets.delete", input, options),
    },
    secretSetMembers: {
      list: (input: SecretSetMemberListInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-set-members.list", input, options),
      add: (input: AddSecretSetMemberInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-set-members.add", input, options),
      update: (input: UpdateSecretSetMemberInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-set-members.update", input, options),
      remove: (input: RemoveSecretSetMemberInput, options?: AdminClientRequestOptions) => client.invoke("secfn.secret-set-members.remove", input, options),
    },
    auditEvents: {
      list: (input: AuditEventListInput = {}, options?: AdminClientRequestOptions) => client.invoke("secfn.audit-events.list", input, options),
    },
    scanner: {
      scanContent: (input: ScanContentInput, options?: AdminClientRequestOptions) => client.invoke("secfn.scanner.scan-content", input, options),
    },
    rateLimits: {
      check: (input: RateLimitCheckInput = {}, options?: AdminClientRequestOptions) => client.invoke("secfn.rate-limits.check", input, options),
    },
  });
}

export type SecFnAdminServiceMethod<K extends SecFnAdminOperationId> = (
  input: SecFnAdminOperationInputMap[K],
  context: AdminOperationContext,
) => Promise<AdminOperationResult<JsonRecord>>;

export interface SecFnAdminService {
  listNamespaces: SecFnAdminServiceMethod<"secfn.namespaces.list">;
  createNamespace: SecFnAdminServiceMethod<"secfn.namespaces.create">;
  updateNamespace: SecFnAdminServiceMethod<"secfn.namespaces.update">;
  listEnvironments: SecFnAdminServiceMethod<"secfn.environments.list">;
  createEnvironment: SecFnAdminServiceMethod<"secfn.environments.create">;
  updateEnvironment: SecFnAdminServiceMethod<"secfn.environments.update">;
  listSecrets: SecFnAdminServiceMethod<"secfn.secrets.list">;
  getSecret: SecFnAdminServiceMethod<"secfn.secrets.get">;
  createSecret: SecFnAdminServiceMethod<"secfn.secrets.create">;
  updateSecret: SecFnAdminServiceMethod<"secfn.secrets.update">;
  rotateSecret: SecFnAdminServiceMethod<"secfn.secrets.rotate">;
  revokeSecret: SecFnAdminServiceMethod<"secfn.secrets.revoke">;
  deleteSecret: SecFnAdminServiceMethod<"secfn.secrets.delete">;
  listSecretSets: SecFnAdminServiceMethod<"secfn.secret-sets.list">;
  getSecretSet: SecFnAdminServiceMethod<"secfn.secret-sets.get">;
  createSecretSet: SecFnAdminServiceMethod<"secfn.secret-sets.create">;
  updateSecretSet: SecFnAdminServiceMethod<"secfn.secret-sets.update">;
  deleteSecretSet: SecFnAdminServiceMethod<"secfn.secret-sets.delete">;
  listSecretSetMembers: SecFnAdminServiceMethod<"secfn.secret-set-members.list">;
  addSecretSetMember: SecFnAdminServiceMethod<"secfn.secret-set-members.add">;
  updateSecretSetMember: SecFnAdminServiceMethod<"secfn.secret-set-members.update">;
  removeSecretSetMember: SecFnAdminServiceMethod<"secfn.secret-set-members.remove">;
  listAuditEvents: SecFnAdminServiceMethod<"secfn.audit-events.list">;
  scanContent: SecFnAdminServiceMethod<"secfn.scanner.scan-content">;
  checkRateLimit: SecFnAdminServiceMethod<"secfn.rate-limits.check">;
}

function bind<K extends SecFnAdminOperationId>(handler: SecFnAdminServiceMethod<K>) {
  return ({ input, context }: AdminOperationRequest) => handler(input as SecFnAdminOperationInputMap[K], context);
}

export function createSecFnAdminAdapter(service: SecFnAdminService): AdminCapabilityAdapter<typeof secFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(secFnAdminCapability, {
    "secfn.namespaces.list": bind(service.listNamespaces),
    "secfn.namespaces.create": bind(service.createNamespace),
    "secfn.namespaces.update": bind(service.updateNamespace),
    "secfn.environments.list": bind(service.listEnvironments),
    "secfn.environments.create": bind(service.createEnvironment),
    "secfn.environments.update": bind(service.updateEnvironment),
    "secfn.secrets.list": bind(service.listSecrets),
    "secfn.secrets.get": bind(service.getSecret),
    "secfn.secrets.create": bind(service.createSecret),
    "secfn.secrets.update": bind(service.updateSecret),
    "secfn.secrets.rotate": bind(service.rotateSecret),
    "secfn.secrets.revoke": bind(service.revokeSecret),
    "secfn.secrets.delete": bind(service.deleteSecret),
    "secfn.secret-sets.list": bind(service.listSecretSets),
    "secfn.secret-sets.get": bind(service.getSecretSet),
    "secfn.secret-sets.create": bind(service.createSecretSet),
    "secfn.secret-sets.update": bind(service.updateSecretSet),
    "secfn.secret-sets.delete": bind(service.deleteSecretSet),
    "secfn.secret-set-members.list": bind(service.listSecretSetMembers),
    "secfn.secret-set-members.add": bind(service.addSecretSetMember),
    "secfn.secret-set-members.update": bind(service.updateSecretSetMember),
    "secfn.secret-set-members.remove": bind(service.removeSecretSetMember),
    "secfn.audit-events.list": bind(service.listAuditEvents),
    "secfn.scanner.scan-content": bind(service.scanContent),
    "secfn.rate-limits.check": bind(service.checkRateLimit),
  });
}

export { createSecFnDomainAdminService, type SecFnDomainAdminServiceOptions, type SecFnDomainScope } from "./domain-service.js";
export const adminCapability = secFnAdminCapability;
export const createAdminAdapter = createSecFnAdminAdapter;
