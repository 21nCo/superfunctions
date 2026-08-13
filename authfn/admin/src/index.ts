import { timingSafeEqual } from "node:crypto";
import { wrapWithSchema } from "@superfunctions/db";
import { createRouter, type Route, type Router } from "@superfunctions/http";
import {
  AdminError,
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminOperationContext,
} from "@superfunctions/admin";
import {
  AuthFnAdminConfigError,
  AuthFnAdminUnauthorizedError,
  AuthFnValidationError,
  createPluginRunner,
  deleteAuthFnAdminUserById,
  deleteAuthFnAdminUsersByEmail,
  findRegionProfileByUserId,
  findUserById,
  getSchema,
  jsonError,
  jsonSuccess,
  listAuthFnAdminUsers,
  revokeSessionById,
  type AuthFnAccountDeletionResult,
  type AuthFnAdminDeleteUsersByEmailResult,
  type AuthFnAdminListUsersInput,
  type AuthFnAdminListUsersResult,
  type AuthFnAdminUserSummary,
  type AuthFnConfig,
  type AuthFnHooks,
  type AuthFnSessionRecord,
  type AuthFnUserRecord,
} from "@authfn/core";

export type AuthFnAdminAction = "users.list" | "users.delete";
export interface AuthFnAdminAuthorizationContext { request: Request; action: AuthFnAdminAction }
export interface AuthFnAdminAuthorizationInput { operationId: string; params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown }
export type AuthFnAdminAuthorizationResult = boolean | { allowed: boolean; actorId?: string; metadata?: Record<string, unknown> };
export type AuthFnAdminAuthorize = (ctx: AuthFnAdminAuthorizationContext, input: AuthFnAdminAuthorizationInput) => Promise<AuthFnAdminAuthorizationResult> | AuthFnAdminAuthorizationResult;
export interface AuthFnAdminOptions { authFnConfig: AuthFnConfig; authorize: AuthFnAdminAuthorize; basePath?: string }
export interface AuthFnAdminInstance { router: Router; routes: Route[] }
export interface StaticAdminKeyAuthorizerOptions { token: string; actorId?: string; headerName?: string }

function prepareConfig(config: AuthFnConfig): { config: AuthFnConfig; hooks: Partial<AuthFnHooks> } {
  const normalized: AuthFnConfig = { ...config, plugins: config.plugins ?? [] };
  const prepared: AuthFnConfig = { ...normalized, database: wrapWithSchema(normalized.database, getSchema(normalized)) };
  return { config: prepared, hooks: createPluginRunner(prepared).hooks };
}

/** @deprecated Bind `createAuthFnAdminService` through the shared administration dispatcher. */
export function createAuthFnAdmin(options: AuthFnAdminOptions): AuthFnAdminInstance {
  if (typeof options.authorize !== "function") throw new AuthFnAdminConfigError("AuthFn admin routes require an authorize hook");
  const prepared = prepareConfig(options.authFnConfig);
  const authorize = async (request: Request, action: AuthFnAdminAction, input: AuthFnAdminAuthorizationInput): Promise<{ actorId?: string }> => {
    const result = await options.authorize({ request, action }, input);
    if (!(typeof result === "boolean" ? result : result.allowed)) throw new AuthFnAdminUnauthorizedError();
    return typeof result === "boolean" ? {} : result;
  };
  const routes: Route[] = [
    {
      method: "GET", path: "/users", handler: async (request, context) => {
        try {
          const input: AuthFnAdminListUsersInput = {
            limit: parseOptionalInt(context.query.get("limit"), "limit"), cursor: context.query.get("cursor") ?? undefined,
            email: context.query.get("email") ?? undefined, regionId: context.query.get("regionId") ?? undefined,
            direction: parseDirection(context.query.get("direction")),
          };
          await authorize(request, "users.list", { operationId: "listAuthFnAdminUsers", query: Object.fromEntries(context.query) });
          return jsonSuccess(request, await listAuthFnAdminUsers(prepared.config, input));
        } catch (error) { return jsonError(request, error); }
      },
    },
    {
      method: "DELETE", path: "/users/:id", handler: async (request, context) => {
        try {
          const id = context.params.id?.trim(); if (!id) throw new AuthFnValidationError("User id is required", { field: "id" });
          const actor = await authorize(request, "users.delete", { operationId: "deleteAuthFnAdminUserById", params: { id } });
          return jsonSuccess(request, await deleteAuthFnAdminUserById(prepared.config, prepared.hooks, { userId: id, request, actorId: actor.actorId }));
        } catch (error) { return jsonError(request, error); }
      },
    },
    {
      method: "DELETE", path: "/users/by-email/:email", handler: async (request, context) => {
        try {
          const email = context.params.email?.trim(); if (!email) throw new AuthFnValidationError("Email is required", { field: "email" });
          const body = await parseOptionalBody(request);
          const deleteAllMatches = body.deleteAllMatches === undefined ? undefined : body.deleteAllMatches;
          if (deleteAllMatches !== undefined && typeof deleteAllMatches !== "boolean") throw new AuthFnValidationError("deleteAllMatches must be boolean", { field: "deleteAllMatches" });
          const actor = await authorize(request, "users.delete", { operationId: "deleteAuthFnAdminUsersByEmail", params: { email }, body });
          return jsonSuccess(request, await deleteAuthFnAdminUsersByEmail(prepared.config, prepared.hooks, { email, deleteAllMatches, request, actorId: actor.actorId }));
        } catch (error) { return jsonError(request, error); }
      },
    },
  ];
  return { routes, router: createRouter({ basePath: options.basePath ?? "/admin", routes, onError: (error, request) => jsonError(request, error) }) };
}
export function createAuthFnAdminRouter(options: AuthFnAdminOptions): Router { return createAuthFnAdmin(options).router }
export function createAuthFnAdminRoutes(options: AuthFnAdminOptions): Route[] { return createAuthFnAdmin(options).routes }

export function createStaticAdminKeyAuthorizer(options: StaticAdminKeyAuthorizerOptions): AuthFnAdminAuthorize {
  const expected = options.token.trim(); if (!expected) throw new AuthFnAdminConfigError("Static admin key authorizer requires a token");
  return ({ request }) => ({ allowed: safeEqual(request.headers.get(options.headerName ?? "authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "", expected), actorId: options.actorId ?? "authfn-admin-key" });
}
function safeEqual(actual: string, expected: string): boolean { const a = Buffer.from(actual); const b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b) }
function parseOptionalInt(value: string | null, field: string): number | undefined { if (value === null) return undefined; const parsed = Number(value); if (!Number.isInteger(parsed)) throw new AuthFnValidationError(`${field} must be an integer`, { field }); return parsed }
function parseDirection(value: string | null): "asc" | "desc" | undefined { if (value === null) return undefined; if (value !== "asc" && value !== "desc") throw new AuthFnValidationError("direction must be asc or desc", { field: "direction" }); return value }
async function parseOptionalBody(request: Request): Promise<Record<string, unknown>> { const text = await request.text(); if (!text.trim()) return {}; try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new AuthFnValidationError("Request body must be a JSON object"); } }

export type { AuthFnAccountDeletionResult, AuthFnAdminDeleteUsersByEmailResult, AuthFnAdminListUsersResult };

export interface AuthFnUserAdminView { id: string; primaryEmail?: string; emailVerifiedAt: string | null; createdAt: string; updatedAt: string; regionId?: string; authority?: string }
export interface AuthFnSessionAdminView { id: string; userId: string; methods: string[]; expiresAt: string; revokedAt: string | null; createdAt: string; updatedAt: string; regionId?: string }
export interface ListUsersInput { limit?: number; cursor?: string; email?: string; direction?: "asc" | "desc" }
export interface UserListResult { items: AuthFnUserAdminView[]; nextCursor: string | null }
export interface UserIdInput { id: string }
export interface UserResult { item: AuthFnUserAdminView }
export interface DeleteUserResult { deleted: true; id: string }
export interface ListSessionsInput { userId: string }
export interface SessionListResult { items: AuthFnSessionAdminView[] }
export interface RevokeSessionInput { id: string; userId: string }
export interface RevokeSessionResult { item: AuthFnSessionAdminView }

const userSchema = { type: "object", properties: { id: { type: "string" }, primaryEmail: { type: "string" }, emailVerifiedAt: { oneOf: [{ type: "string" }, { type: "null" }] }, createdAt: { type: "string" }, updatedAt: { type: "string" }, regionId: { type: "string" }, authority: { type: "string" } }, required: ["id", "emailVerifiedAt", "createdAt", "updatedAt"], additionalProperties: false } as const;
const sessionSchema = { type: "object", properties: { id: { type: "string" }, userId: { type: "string" }, methods: { type: "array", items: { type: "string" } }, expiresAt: { type: "string" }, revokedAt: { oneOf: [{ type: "string" }, { type: "null" }] }, createdAt: { type: "string" }, updatedAt: { type: "string" }, regionId: { type: "string" } }, required: ["id", "userId", "methods", "expiresAt", "revokedAt", "createdAt", "updatedAt"], additionalProperties: false } as const;
const operations = [
  {
    id: "authfn.users.list", title: "List users", description: "List AuthFn users in the bound namespace and active region.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, cursor: { type: "string" }, email: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: userSchema }, nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] } }, required: ["items", "nextCursor"], additionalProperties: false },
    route: { method: "GET", path: "/resources/users" }, permission: "authfn.users.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "required" }, pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 100 }, mcp: { readOnlyHint: true }, redaction: { inputFields: ["email"] }, target: { resource: "users", collection: true },
  },
  {
    id: "authfn.users.get", title: "Get user", description: "Get an AuthFn user only when it belongs to the active namespace and region.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false }, outputSchema: { type: "object", properties: { item: userSchema }, required: ["item"], additionalProperties: false },
    route: { method: "GET", path: "/resources/users/:id" }, permission: "authfn.users.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: true }, target: { resource: "users", idInput: "id" },
  },
  {
    id: "authfn.users.delete", title: "Delete user", description: "Permanently delete an in-scope AuthFn user and authentication state.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false }, outputSchema: { type: "object", properties: { deleted: { type: "boolean", const: true }, id: { type: "string" } }, required: ["deleted", "id"], additionalProperties: false },
    route: { method: "DELETE", path: "/resources/users/:id" }, permission: "authfn.users.delete", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "critical", method: "mfa", reason: "Permanent deletion removes the user and owned authentication state.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "users", idInput: "id" },
  },
  {
    id: "authfn.users.list-sessions", title: "List user sessions", description: "List active sessions for an in-scope AuthFn user.",
    inputSchema: { type: "object", properties: { userId: { type: "string", minLength: 1 } }, required: ["userId"], additionalProperties: false }, outputSchema: { type: "object", properties: { items: { type: "array", items: sessionSchema } }, required: ["items"], additionalProperties: false },
    route: { method: "GET", path: "/resources/users/:userId/sessions" }, permission: "authfn.sessions.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: true }, target: { resource: "users", idInput: "userId" },
  },
  {
    id: "authfn.sessions.revoke", title: "Revoke session", description: "Revoke a session after proving it belongs to an in-scope AuthFn user.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, userId: { type: "string", minLength: 1 } }, required: ["id", "userId"], additionalProperties: false }, outputSchema: { type: "object", properties: { item: sessionSchema }, required: ["item"], additionalProperties: false },
    route: { method: "POST", path: "/resources/sessions/actions/revoke" }, permission: "authfn.sessions.revoke", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason: "Session revocation immediately terminates an authenticated session.", maxAgeSeconds: 600 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "sessions", idInput: "id" },
  },
] as const;

export const authFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0", id: "authfn", displayName: "AuthFn", version: "1.1.0", description: "AuthFn user and session operations backed by the AuthFn core service and scoped storage.",
  category: "identity", availability: "required-product", scopeLevels: ["organization", "workspace", "project", "environment"],
  resources: [
    { id: "users", label: "Users", description: "Authentication users in the active namespace and region.", icon: "authfn:users", risk: "sensitive", idField: "id", displayFields: ["id", "primaryEmail", "updatedAt"], searchableFields: ["id", "primaryEmail"], filterableFields: ["regionId", "createdAt"], sortableFields: ["createdAt", "updatedAt"], sensitiveFields: [] },
    { id: "sessions", label: "Sessions", description: "Active AuthFn sessions for an in-scope user.", icon: "authfn:sessions", risk: "sensitive", idField: "id", displayFields: ["id", "userId", "expiresAt", "revokedAt"], sensitiveFields: [] },
  ],
  navigation: [{ id: "authfn", label: "AuthFn", path: "/modules/authfn", icon: "authfn", order: 10 }], operations,
});

export interface AuthFnAdminService {
  listUsers(input: ListUsersInput, context: AdminOperationContext): Promise<UserListResult>;
  getUser(input: UserIdInput, context: AdminOperationContext): Promise<UserResult>;
  deleteUser(input: UserIdInput, context: AdminOperationContext): Promise<DeleteUserResult>;
  listSessions(input: ListSessionsInput, context: AdminOperationContext): Promise<SessionListResult>;
  revokeSession(input: RevokeSessionInput, context: AdminOperationContext): Promise<RevokeSessionResult>;
}

function iso(value: Date | string | null | undefined): string | null { return value == null ? null : new Date(value).toISOString() }
function userView(user: AuthFnUserRecord | AuthFnAdminUserSummary): AuthFnUserAdminView {
  const region = "regionProfile" in user ? user.regionProfile : undefined;
  return { id: user.id, primaryEmail: user.primaryEmail, emailVerifiedAt: iso(user.emailVerifiedAt), createdAt: iso(user.createdAt)!, updatedAt: iso(user.updatedAt)!, ...(region ? { regionId: region.regionId, authority: region.authority } : {}) };
}
function sessionView(session: AuthFnSessionRecord, regionId?: string): AuthFnSessionAdminView { return { id: session.id, userId: session.userId, methods: [...session.methods], expiresAt: iso(session.expiresAt)!, revokedAt: iso(session.revokedAt), createdAt: iso(session.createdAt)!, updatedAt: iso(session.updatedAt)!, regionId }; }

export function createAuthFnAdminService(authFnConfig: AuthFnConfig): AuthFnAdminService {
  const prepared = prepareConfig(authFnConfig);
  const expectedNamespace = prepared.config.namespace ?? "authfn";
  const assertNamespace = (context: AdminOperationContext) => { if (context.scope.namespace !== undefined && context.scope.namespace !== expectedNamespace) throw new AdminError("forbidden", "AuthFn is not bound to the active namespace."); };
  const scopedUser = async (id: string, context: AdminOperationContext): Promise<AuthFnUserRecord> => {
    assertNamespace(context);
    const user = await findUserById(prepared.config, id); if (!user) throw new AdminError("not_found", "AuthFn user not found.", { details: { id } });
    if (context.scope.region) {
      const profile = await findRegionProfileByUserId(prepared.config, id);
      if (!profile || profile.regionId !== context.scope.region) throw new AdminError("not_found", "AuthFn user not found in the active region.", { details: { id } });
    }
    return user;
  };
  return {
    async listUsers(input, context) { assertNamespace(context); const result = await listAuthFnAdminUsers(prepared.config, { ...input, regionId: context.scope.region }); return { items: result.users.map(userView), nextCursor: result.pageInfo.nextCursor ?? null }; },
    async getUser(input, context) { const user = await scopedUser(input.id, context); const profile = await findRegionProfileByUserId(prepared.config, user.id); return { item: userView({ ...user, regionProfile: profile ? { regionId: profile.regionId, authority: profile.authority, domain: profile.domain } : undefined } as AuthFnAdminUserSummary) }; },
    async deleteUser(input, context) { await scopedUser(input.id, context); await deleteAuthFnAdminUserById(prepared.config, prepared.hooks, { userId: input.id, actorId: context.actor.id }); return { deleted: true, id: input.id }; },
    async listSessions(input, context) { await scopedUser(input.userId, context); const records = await prepared.config.database.findMany<AuthFnSessionRecord>({ model: "sessions", where: [{ field: "userId", operator: "eq", value: input.userId }], orderBy: [{ field: "createdAt", direction: "asc" }, { field: "id", direction: "asc" }], namespace: expectedNamespace }); const now = context.now ?? new Date(); return { items: records.filter((record) => !record.revokedAt && record.expiresAt > now).map((record) => sessionView(record, context.scope.region)) }; },
    async revokeSession(input, context) { await scopedUser(input.userId, context); return { item: sessionView(await revokeSessionById(prepared.config, input.id, { userId: input.userId }), context.scope.region) }; },
  };
}

export function createAuthFnAdminAdapter(service: AuthFnAdminService) {
  return createKernelAdminCapabilityAdapter(authFnAdminCapability, {
    "authfn.users.list": ({ input, context }) => service.listUsers(input as ListUsersInput, context),
    "authfn.users.get": ({ input, context }) => service.getUser(input as UserIdInput, context),
    "authfn.users.delete": ({ input, context }) => service.deleteUser(input as UserIdInput, context),
    "authfn.users.list-sessions": ({ input, context }) => service.listSessions(input as ListSessionsInput, context),
    "authfn.sessions.revoke": ({ input, context }) => service.revokeSession(input as RevokeSessionInput, context),
  });
}

export function createAuthFnAdminClient(adminClient: AdminClient) {
  const capability = createCapabilityAdminClient(authFnAdminCapability, adminClient);
  return Object.assign(capability, {
    users: {
      list: (input: ListUsersInput = {}, options?: AdminClientRequestOptions) => capability.invoke("authfn.users.list", input, options),
      get: (input: UserIdInput, options?: AdminClientRequestOptions) => capability.invoke("authfn.users.get", input, options),
      delete: (input: UserIdInput, options?: AdminClientRequestOptions) => capability.invoke("authfn.users.delete", input, options),
    },
    sessions: {
      list: (input: ListSessionsInput, options?: AdminClientRequestOptions) => capability.invoke("authfn.users.list-sessions", input, options),
      revoke: (input: RevokeSessionInput, options?: AdminClientRequestOptions) => capability.invoke("authfn.sessions.revoke", input, options),
    },
  });
}

export const adminCapability = authFnAdminCapability;
export const createAdminAdapter = createAuthFnAdminAdapter;
