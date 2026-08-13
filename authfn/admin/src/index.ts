import { wrapWithSchema } from "@superfunctions/db";
import { createRouter, type Route, type Router } from "@superfunctions/http";
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
import {
  AuthFnAdminConfigError,
  AuthFnAdminUnauthorizedError,
  AuthFnValidationError,
  createPluginRunner,
  deleteAuthFnAdminUserById,
  deleteAuthFnAdminUsersByEmail,
  getSchema,
  jsonError,
  jsonSuccess,
  listAuthFnAdminUsers,
  type AuthFnAccountDeletionResult,
  type AuthFnAdminDeleteUsersByEmailResult,
  type AuthFnAdminListUsersResult,
  type AuthFnConfig,
  type AuthFnHooks,
} from "@authfn/core";

export type AuthFnAdminAction = "users.list" | "users.delete";

export interface AuthFnAdminAuthorizationContext {
  request: Request;
  action: AuthFnAdminAction;
}

export interface AuthFnAdminAuthorizationInput {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export type AuthFnAdminAuthorizationResult =
  | boolean
  | {
      allowed: boolean;
      actorId?: string;
      metadata?: Record<string, unknown>;
    };

export type AuthFnAdminAuthorize = (
  ctx: AuthFnAdminAuthorizationContext,
  input: AuthFnAdminAuthorizationInput,
) => Promise<AuthFnAdminAuthorizationResult> | AuthFnAdminAuthorizationResult;

export interface AuthFnAdminOptions {
  authFnConfig: AuthFnConfig;
  authorize: AuthFnAdminAuthorize;
  basePath?: string;
}

export interface AuthFnAdminInstance {
  router: Router;
  routes: Route[];
}

export interface StaticAdminKeyAuthorizerOptions {
  token: string;
  actorId?: string;
  headerName?: string;
}

interface PreparedAuthFnAdmin {
  config: AuthFnConfig;
  hooks: Partial<AuthFnHooks>;
  authorize: AuthFnAdminAuthorize;
}

interface AuthorizedAdminActor {
  actorId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * @deprecated Low-level compatibility router. It predates the shared
 * `@superfunctions/admin` confirmation, idempotency, and attempted/terminal
 * audit contract. New operator control planes must bind
 * `createAuthFnAdminAdapter` through Super Console (or the shared dispatcher)
 * instead of exposing this router directly.
 */
export function createAuthFnAdmin(
  options: AuthFnAdminOptions,
): AuthFnAdminInstance {
  const prepared = prepareAuthFnAdmin(options);
  const routes = createPreparedAuthFnAdminRoutes(prepared);

  return {
    routes,
    router: createRouter({
      basePath: options.basePath ?? "/admin",
      routes,
      onError: (error, request) => jsonError(request, error),
    }),
  };
}

/** @deprecated Use `createAuthFnAdminAdapter` through the shared admin dispatcher. */
export function createAuthFnAdminRouter(options: AuthFnAdminOptions): Router {
  return createAuthFnAdmin(options).router;
}

/** @deprecated Use `createAuthFnAdminAdapter` through the shared admin dispatcher. */
export function createAuthFnAdminRoutes(options: AuthFnAdminOptions): Route[] {
  return createPreparedAuthFnAdminRoutes(prepareAuthFnAdmin(options));
}

export function createStaticAdminKeyAuthorizer(
  options: StaticAdminKeyAuthorizerOptions,
): AuthFnAdminAuthorize {
  const expectedToken = options.token.trim();
  if (!expectedToken) {
    throw new AuthFnAdminConfigError(
      "Static admin key authorizer requires a token",
    );
  }

  const headerName = options.headerName ?? "authorization";
  const actorId = options.actorId ?? "authfn-admin-key";

  return ({ request }) => {
    const headerValue = request.headers.get(headerName);
    const token = headerValue?.replace(/^Bearer\s+/i, "").trim();
    return {
      allowed: Boolean(token && safeEqual(token, expectedToken)),
      actorId,
    };
  };
}

function prepareAuthFnAdmin(options: AuthFnAdminOptions): PreparedAuthFnAdmin {
  if (typeof options.authorize !== "function") {
    throw new AuthFnAdminConfigError(
      "AuthFn admin routes require an authorize hook",
    );
  }

  const schema = getSchema(options.authFnConfig);
  const config: AuthFnConfig = {
    ...options.authFnConfig,
    database: wrapWithSchema(options.authFnConfig.database, schema),
  };
  const runner = createPluginRunner(config);

  return {
    config,
    hooks: runner.hooks,
    authorize: options.authorize,
  };
}

function createPreparedAuthFnAdminRoutes(admin: PreparedAuthFnAdmin): Route[] {
  return [
    {
      method: "GET",
      path: "/users",
      meta: createAdminRouteMeta("listAuthFnAdminUsers", "List AuthFn users"),
      handler: (request, context) =>
        withAdminEnvelope(request, async () => {
          const input = parseListUsersInput(context.query);
          await authorizeAdmin(admin, request, "users.list", {
            operationId: "listAuthFnAdminUsers",
            query: queryToObject(context.query),
          });

          return listAuthFnAdminUsers(admin.config, input);
        }),
    },
    {
      method: "DELETE",
      path: "/users/:id",
      meta: createAdminRouteMeta(
        "deleteAuthFnAdminUserById",
        "Delete an AuthFn user by id",
      ),
      handler: (request, context) =>
        withAdminEnvelope(request, async () => {
          const userId = context.params.id?.trim();
          if (!userId) {
            throw new AuthFnValidationError("User id is required", {
              field: "id",
            });
          }

          const authorization = await authorizeAdmin(
            admin,
            request,
            "users.delete",
            {
              operationId: "deleteAuthFnAdminUserById",
              params: { id: userId },
            },
          );

          return deleteAuthFnAdminUserById(admin.config, admin.hooks, {
            userId,
            request,
            actorId: authorization.actorId,
          });
        }),
    },
    {
      method: "DELETE",
      path: "/users/by-email/:email",
      meta: createAdminRouteMeta(
        "deleteAuthFnAdminUsersByEmail",
        "Delete AuthFn user by email",
      ),
      handler: (request, context) =>
        withAdminEnvelope(request, async () => {
          const email = context.params.email?.trim();
          if (!email) {
            throw new AuthFnValidationError("Email is required", {
              field: "email",
            });
          }

          const body = await parseOptionalJsonBody(request);
          const deleteAllMatches = readDeleteAllMatches(body);
          const authorization = await authorizeAdmin(
            admin,
            request,
            "users.delete",
            {
              operationId: "deleteAuthFnAdminUsersByEmail",
              params: { email },
              body:
                deleteAllMatches === undefined
                  ? undefined
                  : { deleteAllMatches },
            },
          );

          return deleteAuthFnAdminUsersByEmail(admin.config, admin.hooks, {
            email,
            deleteAllMatches,
            request,
            actorId: authorization.actorId,
          });
        }),
    },
  ];
}

async function authorizeAdmin(
  admin: PreparedAuthFnAdmin,
  request: Request,
  action: AuthFnAdminAction,
  input: AuthFnAdminAuthorizationInput,
): Promise<AuthorizedAdminActor> {
  const result = await admin.authorize({ request, action }, input);
  const allowed = typeof result === "boolean" ? result : result.allowed;
  if (!allowed) {
    throw new AuthFnAdminUnauthorizedError();
  }

  return typeof result === "boolean"
    ? {}
    : {
        actorId: result.actorId,
        metadata: result.metadata,
      };
}

async function withAdminEnvelope<TData>(
  request: Request,
  operation: () => Promise<TData>,
): Promise<Response> {
  try {
    return jsonSuccess(request, await operation());
  } catch (error) {
    return jsonError(request, error);
  }
}

function parseListUsersInput(query: URLSearchParams): {
  limit?: number;
  cursor?: string;
  email?: string;
  regionId?: string;
  direction?: "asc" | "desc";
} {
  const direction = query.get("direction") ?? undefined;
  if (direction !== undefined && direction !== "asc" && direction !== "desc") {
    throw new AuthFnValidationError("direction must be asc or desc", {
      field: "direction",
    });
  }

  return {
    limit: parseOptionalInteger(query.get("limit"), "limit"),
    cursor: query.get("cursor") ?? undefined,
    email: query.get("email") ?? undefined,
    regionId: query.get("regionId") ?? undefined,
    direction,
  };
}

function parseOptionalInteger(
  value: string | null,
  field: string,
): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new AuthFnValidationError(`${field} must be an integer`, {
      field,
    });
  }

  return parsed;
}

async function parseOptionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AuthFnValidationError("Invalid JSON body", {
      field: "body",
    });
  }
}

function readDeleteAllMatches(body: unknown): boolean | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (
    !isRecord(body) ||
    (body.deleteAllMatches !== undefined &&
      typeof body.deleteAllMatches !== "boolean")
  ) {
    throw new AuthFnValidationError(
      "deleteAllMatches must be a boolean when provided",
      {
        field: "deleteAllMatches",
      },
    );
  }

  return body.deleteAllMatches;
}

function createAdminRouteMeta(operationId: string, summary: string) {
  return {
    auth: {
      mode: "bearer" as const,
      scopes: ["authfn:admin"],
    },
    openapi: {
      include: true,
      operationId,
      summary,
      tags: ["authfn-admin"],
    },
  };
}

function queryToObject(
  query: URLSearchParams,
): Record<string, string | undefined> {
  return {
    limit: query.get("limit") ?? undefined,
    cursor: query.get("cursor") ?? undefined,
    email: query.get("email") ?? undefined,
    regionId: query.get("regionId") ?? undefined,
    direction: query.get("direction") ?? undefined,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);

  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type {
  AuthFnAccountDeletionResult,
  AuthFnAdminDeleteUsersByEmailResult,
  AuthFnAdminListUsersResult,
};

export interface AuthFnAdminResourceDefinition {
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

export interface AuthFnAdminActionDefinition {
  id: string;
  resource: string;
  title: string;
  description: string;
  classification: "write" | "destructive";
  requiresConfirmation: boolean;
  idempotent: true;
  target: "resource" | "collection";
}

export const authFnAdminResources = [
  {
    id: "users",
    label: "Users",
    description: "Authentication users and account state.",
    icon: "authfn:users",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "primaryEmail", "status", "updatedAt"],
    searchableFields: ["id", "primaryEmail"],
    filterableFields: ["status", "createdAt", "regionId"],
    sortableFields: ["createdAt", "updatedAt", "primaryEmail"],
    sensitiveFields: [
      "metadata",
      "password",
      "passwordHash",
      "verificationCode",
      "recoveryCode",
      "recoveryCodes",
    ],
  },
  {
    id: "identities",
    label: "Identities",
    description: "Linked login identities.",
    icon: "authfn:identities",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "provider", "userId", "updatedAt"],
    searchableFields: ["id", "provider", "userId"],
    filterableFields: ["provider", "status"],
    sortableFields: ["createdAt", "updatedAt"],
    sensitiveFields: [
      "accessToken",
      "refreshToken",
      "idToken",
      "authorizationCode",
      "clientSecret",
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Active and historical sessions.",
    icon: "authfn:sessions",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "userId", "expiresAt", "status"],
    searchableFields: ["id", "userId"],
    filterableFields: ["status", "method", "regionId"],
    sortableFields: ["createdAt", "expiresAt"],
    sensitiveFields: ["token", "tokenHash", "sessionToken", "cookie"],
  },
  {
    id: "workspaces",
    label: "Workspaces",
    description: "AuthFn workspace boundaries.",
    icon: "authfn:workspaces",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name"],
    filterableFields: ["status"],
    sortableFields: ["name", "createdAt"],
    sensitiveFields: [],
  },
  {
    id: "memberships",
    label: "Memberships",
    description: "Workspace membership grants.",
    icon: "authfn:memberships",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "userId", "workspaceId", "roleId"],
    searchableFields: ["id", "userId", "workspaceId"],
    filterableFields: ["roleId", "status"],
    sortableFields: ["createdAt", "updatedAt"],
    sensitiveFields: [],
  },
  {
    id: "roles",
    label: "Roles",
    description: "Operator and application roles.",
    icon: "authfn:roles",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name"],
    filterableFields: ["status"],
    sortableFields: ["name", "createdAt"],
    sensitiveFields: ["permissions"],
  },
  {
    id: "api-keys",
    label: "API Keys",
    description: "Issued API credentials and status.",
    icon: "authfn:api-keys",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "name", "prefix", "status"],
    searchableFields: ["id", "name", "prefix"],
    filterableFields: ["status", "expiresAt"],
    sortableFields: ["createdAt", "expiresAt"],
    sensitiveFields: [
      "secret",
      "key",
      "tokenHash",
      "apiKey",
      "privateKey",
      "authorization",
    ],
  },
  {
    id: "oauth-providers",
    label: "OAuth Providers",
    description: "Configured OAuth providers and connections.",
    icon: "authfn:oauth",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "name", "status", "updatedAt"],
    searchableFields: ["id", "name"],
    filterableFields: ["status", "regionId"],
    sortableFields: ["name", "updatedAt"],
    sensitiveFields: [
      "clientSecret",
      "privateKey",
      "apiKey",
      "authorization",
      "cookie",
    ],
  },
  {
    id: "mfa",
    label: "MFA",
    description: "Multi-factor enrollment state.",
    icon: "authfn:mfa",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "userId", "method", "status"],
    searchableFields: ["id", "userId"],
    filterableFields: ["method", "status"],
    sortableFields: ["createdAt", "updatedAt"],
    sensitiveFields: [
      "secret",
      "otp",
      "otpCode",
      "verificationCode",
      "recoveryCode",
      "recoveryCodes",
    ],
  },
  {
    id: "regions",
    label: "Regions",
    description: "Authentication regions and directory health.",
    icon: "authfn:regions",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "authority", "status", "updatedAt"],
    searchableFields: ["id", "authority"],
    filterableFields: ["status"],
    sortableFields: ["id", "updatedAt"],
    sensitiveFields: [],
  },
  {
    id: "health",
    label: "Auth Health",
    description: "AuthFn runtime and dependency health.",
    icon: "authfn:health",
    risk: "standard",
    idField: "id",
    displayFields: ["id", "status", "updatedAt"],
    searchableFields: ["id"],
    filterableFields: ["status"],
    sortableFields: ["updatedAt"],
    sensitiveFields: [],
  },
  {
    id: "audit",
    label: "Audit",
    description: "Authentication security and administration events.",
    icon: "authfn:audit",
    risk: "sensitive",
    idField: "id",
    displayFields: ["id", "action", "actorId", "createdAt"],
    searchableFields: ["id", "action", "actorId", "subjectId"],
    filterableFields: ["action", "outcome", "createdAt"],
    sortableFields: ["createdAt"],
    sensitiveFields: ["metadata"],
  },
] as const satisfies readonly AuthFnAdminResourceDefinition[];

export const authFnAdminActions = [
  {
    id: "invite-user",
    resource: "users",
    title: "Invite User",
    description: "Invite a user into the active workspace.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "collection",
  },
  {
    id: "block-user",
    resource: "users",
    title: "Block User",
    description: "Block authentication for a user.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "delete-user",
    resource: "users",
    title: "Delete User",
    description: "Permanently delete a user and owned authentication state.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "revoke-session",
    resource: "sessions",
    title: "Revoke Session",
    description: "Revoke an active session.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "rotate-key",
    resource: "api-keys",
    title: "Rotate API Key",
    description: "Rotate an API credential.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "revoke-key",
    resource: "api-keys",
    title: "Revoke API Key",
    description: "Revoke an API credential.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "manage-role",
    resource: "roles",
    title: "Manage Role",
    description: "Create or update role permissions.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
  {
    id: "reset-mfa",
    resource: "mfa",
    title: "Reset MFA",
    description: "Remove a user multi-factor enrollment.",
    classification: "destructive",
    requiresConfirmation: true,
    idempotent: true,
    target: "resource",
  },
  {
    id: "configure-provider",
    resource: "oauth-providers",
    title: "Configure Provider",
    description: "Create or update an OAuth provider.",
    classification: "write",
    requiresConfirmation: false,
    idempotent: true,
    target: "resource",
  },
] as const satisfies readonly AuthFnAdminActionDefinition[];

export interface AuthFnAdminResourcePolicy {
  defaultScope: "active";
  permission: string;
  redaction: "none" | "sensitive-fields";
}

export interface AuthFnAdminOperationPolicy {
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
    domain: "authfn";
    requestIdPath: "context.requestId";
    correlationIdPath: "context.correlationId";
  };
}

export const authFnAdminResourcePolicies = Object.freeze(
  Object.fromEntries(
    authFnAdminResources.map((resource) => [
      resource.id,
      {
        defaultScope: "active",
        permission: "authfn." + resource.id + ".read",
        redaction:
          resource.sensitiveFields.length > 0 ? "sensitive-fields" : "none",
      } satisfies AuthFnAdminResourcePolicy,
    ]),
  ),
) as Readonly<Record<string, AuthFnAdminResourcePolicy>>;

export const authFnAdminOperationPolicies = Object.freeze(
  Object.fromEntries(
    authFnAdminActions.map((action) => [
      "authfn." + action.resource + "." + action.id,
      {
        permission: "authfn." + action.resource + "." + action.id,
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
          action: "authfn." + action.id,
          targetResource: action.resource,
          ...(action.target === "resource"
            ? { targetIdPath: "$.id" as const }
            : { collection: true as const }),
        },
        observation: {
          domain: "authfn",
          requestIdPath: "context.requestId",
          correlationIdPath: "context.correlationId",
        },
      } satisfies AuthFnAdminOperationPolicy,
    ]),
  ),
) as Readonly<Record<string, AuthFnAdminOperationPolicy>>;

const authEntitySchema: AdminObjectSchema = {
  type: "object",
  description:
    "A domain-owned AuthFn administration resource with secret fields redacted.",
  additionalProperties: true,
};
const authListInputSchema: AdminObjectSchema = {
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
const authListOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: authEntitySchema },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["items"],
  additionalProperties: false,
};
const authGetInputSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
};
const authGetOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: { item: authEntitySchema },
  required: ["item"],
  additionalProperties: false,
};
const authActionInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    payload: { type: "object", additionalProperties: true },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
  additionalProperties: false,
};
const authActionOutputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    item: authEntitySchema,
    accepted: { type: "boolean" },
    operationReference: { type: "string" },
  },
  required: ["accepted"],
  additionalProperties: true,
};

export const authFnAdminSchemas = {
  entity: authEntitySchema,
  listInput: authListInputSchema,
  listOutput: authListOutputSchema,
  getInput: authGetInputSchema,
  getOutput: authGetOutputSchema,
  actionInput: authActionInputSchema,
  actionOutput: authActionOutputSchema,
} as const satisfies Record<string, AdminJsonSchema>;

function authResourceOperations(
  resource: AuthFnAdminResourceDefinition,
): AdminOperationDefinition[] {
  const baseId = `authfn.${resource.id}`;
  const basePath = `/resources/${resource.id}`;
  return [
    {
      id: `${baseId}.list`,
      title: `List ${resource.label}`,
      description: `List permitted ${resource.label.toLowerCase()} in the active administration scope.`,
      inputSchema: authListInputSchema,
      outputSchema: authListOutputSchema,
      route: { method: "GET", path: basePath },
      permission: `authfn.${resource.id}.read`,
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
      id: `${baseId}.get`,
      title: `Get ${resource.label}`,
      description: `Get one permitted ${resource.label.toLowerCase()} resource.`,
      inputSchema: authGetInputSchema,
      outputSchema: authGetOutputSchema,
      route: { method: "GET", path: `${basePath}/:id` },
      permission: `authfn.${resource.id}.read`,
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

function authActionOperation(
  action: AuthFnAdminActionDefinition,
): AdminOperationDefinition {
  const sensitiveFields =
    authFnAdminResources.find((resource) => resource.id === action.resource)
      ?.sensitiveFields ?? [];
  return {
    id: `authfn.${action.resource}.${action.id}`,
    title: action.title,
    description: action.description,
    inputSchema:
      action.target === "resource"
        ? { ...authActionInputSchema, required: ["id"] }
        : authActionInputSchema,
    outputSchema: authActionOutputSchema,
    route: {
      method: "POST",
      path: `/resources/${action.resource}/actions/${action.id}`,
    },
    permission: `authfn.${action.resource}.${action.id}`,
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

const authCapabilityOperations: AdminOperationDefinition[] = [
  ...authFnAdminResources.flatMap(authResourceOperations),
  ...authFnAdminActions.map(authActionOperation),
];

type FunctionAdminActionOperationId<TModule extends string, TAction> =
  TAction extends { resource: infer TResource extends string; id: infer TActionId extends string }
    ? `${TModule}.${TResource}.${TActionId}`
    : never;

export type AuthFnCapabilityOperationId =
  | `authfn.${(typeof authFnAdminResources)[number]["id"]}.list`
  | `authfn.${(typeof authFnAdminResources)[number]["id"]}.get`
  | FunctionAdminActionOperationId<"authfn", (typeof authFnAdminActions)[number]>;

export const authFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "authfn",
  displayName: "AuthFn",
  version: "1.0.0",
  description:
    "Commercial-grade, function-owned operator capabilities for AuthFn.",
  category: "identity",
  availability: "required-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: authFnAdminResources,
  navigation: [
    {
      id: "authfn",
      label: "AuthFn",
      path: "/modules/authfn",
      icon: "authfn",
      description: "Operate AuthFn in the active scope.",
      order: 10,
    },
  ],
  health: { operationId: "authfn.health.list" },
  operations: authCapabilityOperations as readonly (AdminOperationDefinition & { readonly id: AuthFnCapabilityOperationId })[],
});

export function createAuthFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(authFnAdminCapability, adminClient);
}

export interface AuthFnAdminServiceRequest {
  operationId: AuthFnCapabilityOperationId;
  input: unknown;
  context: AdminOperationContext;
}

export interface AuthFnAdminService {
  execute(
    request: AuthFnAdminServiceRequest,
  ):
    | Promise<AdminOperationResult<Record<string, unknown>>>
    | AdminOperationResult<Record<string, unknown>>;
}

export function createAuthFnAdminAdapter(
  service: AuthFnAdminService,
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
  for (const operation of authFnAdminCapability.operations) {
    handlers[operation.id] = (request) =>
      service.execute({
        operationId: operation.id,
        input: request.input,
        context: request.context,
      });
  }
  return createKernelAdminCapabilityAdapter(authFnAdminCapability, handlers);
}

export const adminCapability = authFnAdminCapability;
export const createAdminAdapter = createAuthFnAdminAdapter;
