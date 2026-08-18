import type { SecFnServer } from "@secfn/server";
import {
  AdminError,
  decodeAdminCursor,
  encodeAdminCursor,
  normalizeAdminPageLimit,
  type AdminOperationContext,
  type AdminOperationResult,
} from "@superfunctions/admin";
import type {
  AuditEventListInput,
  SecFnAdminOperationInputMap,
  SecFnAdminService,
  SecFnAdminServiceMethod,
  SecFnAdminOperationId,
} from "./index.js";

type JsonRecord = Record<string, unknown>;
type SecFnDomainRequest = {
  [K in SecFnAdminOperationId]: {
    operationId: K;
    input: SecFnAdminOperationInputMap[K];
    context: AdminOperationContext;
  }
}[SecFnAdminOperationId];
type ScopeRecord = {
  tenantId?: string;
  namespaceId?: string;
  namespace?: string;
  environmentId?: string;
  environment?: string;
};

export interface SecFnDomainScope extends ScopeRecord {
  tenantId: string;
}

export interface SecFnDomainAdminServiceOptions {
  /** Resolve the SecFn server configured for the active installation. */
  server(context: AdminOperationContext): SecFnServer | Promise<SecFnServer>;
  /** Map the authorized Super Console project scope to SecFn's tenant namespace. */
  scope(context: AdminOperationContext): SecFnDomainScope | Promise<SecFnDomainScope>;
}

function json(value: unknown, name = "input"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminError("invalid_argument", `${name} must be an object.`);
  }
  return value as JsonRecord;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminError("invalid_argument", `${name} must be a non-empty string.`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}

function optionalNullableText(value: unknown, name: string): string | null | undefined {
  return value === null ? null : optionalText(value, name);
}

function actor(context: AdminOperationContext): string {
  return text(context.actor.id, "context.actor.id");
}

function item(value: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { item: { ...value } } };
}

function list(values: readonly object[], nextCursor?: string): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { items: values.map((value) => ({ ...value })), nextCursor: nextCursor ?? null } };
}

function paginatedList(
  values: readonly object[],
  input: JsonRecord,
  context: AdminOperationContext,
  resource: "namespaces" | "environments",
): AdminOperationResult<JsonRecord> {
  const limit = normalizeAdminPageLimit(input.limit);
  const search = optionalText(input.search, "search")?.toLowerCase() ?? null;
  const position = input.cursor === undefined
    ? { offset: 0, resource, search }
    : decodeAdminCursor<{ offset: number; resource: string; search: string | null }>(
      text(input.cursor, "cursor"),
      context.scope,
    );
  if (
    !Number.isInteger(position.offset)
    || position.offset < 0
    || position.resource !== resource
    || position.search !== search
  ) {
    throw new AdminError("invalid_argument", "The pagination cursor is invalid for this SecFn collection.");
  }
  const items = values.slice(position.offset, position.offset + limit);
  const nextOffset = position.offset + items.length;
  const nextCursor = nextOffset < values.length
    ? encodeAdminCursor(context.scope, { offset: nextOffset, resource, search })
    : null;
  return {
    ok: true,
    data: { items: items.map((value) => ({ ...value })), nextCursor },
    page: { nextCursor, hasMore: nextCursor !== null },
  };
}

function accepted(value?: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { accepted: true, ...(value ? { item: { ...value } } : {}) } };
}

function belongsToScope(value: ScopeRecord, scope: SecFnDomainScope): boolean {
  if (value.tenantId !== undefined && value.tenantId !== scope.tenantId) return false;
  if (scope.namespaceId && value.namespaceId !== undefined && value.namespaceId !== scope.namespaceId) return false;
  if (!scope.namespaceId && scope.namespace && value.namespace !== undefined && value.namespace !== scope.namespace) return false;
  if (scope.environmentId && value.environmentId !== undefined && value.environmentId !== scope.environmentId) return false;
  if (!scope.environmentId && scope.environment && value.environment !== undefined && value.environment !== scope.environment) return false;
  return true;
}

function assertScoped(value: ScopeRecord, scope: SecFnDomainScope, label: string): void {
  if (!belongsToScope(value, scope)) throw new AdminError("not_found", `${label} was not found in the active SecFn scope.`);
}

function scopeInput(scope: SecFnDomainScope): ScopeRecord {
  return {
    tenantId: scope.tenantId,
    namespaceId: scope.namespaceId,
    namespace: scope.namespace,
    environmentId: scope.environmentId,
    environment: scope.environment,
  };
}

async function canonicalScope(server: SecFnServer, scope: SecFnDomainScope): Promise<SecFnDomainScope> {
  if (!scope.namespace && !scope.namespaceId) return scope;
  const namespaces = await server.vault.listNamespaces({ tenantId: scope.tenantId });
  const namespace = namespaces.find((value) =>
    value.id === scope.namespaceId || value.slug === scope.namespace || value.label === scope.namespace,
  );
  if (!namespace) return scope;
  return { ...scope, namespaceId: namespace.id, namespace: namespace.label || namespace.slug };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mapDomainError(error: unknown): never {
  if (error instanceof AdminError) throw error;
  const candidate = error as { code?: string; message?: string; details?: unknown };
  const code = candidate?.code;
  const adminCode = code === "SECFN_NOT_FOUND"
    ? "not_found"
    : code === "SECFN_FORBIDDEN"
      ? "forbidden"
      : code === "SECFN_UNAUTHORIZED"
      ? "unauthenticated"
        : code === "SECFN_VALIDATION_FAILED" || code === "SECFN_CONFIG_INVALID"
          ? "invalid_argument"
          : "dependency_unavailable";
  throw new AdminError(adminCode, candidate?.message ?? "SecFn operation failed.", { details: candidate?.details });
}

async function findScopedNamespace(server: SecFnServer, scope: SecFnDomainScope, id: string) {
  const value = (await server.vault.listNamespaces({ tenantId: scope.tenantId })).find((entry) => entry.id === id);
  if (!value) throw new AdminError("not_found", "Namespace was not found in the active SecFn project.");
  return value;
}

async function findScopedEnvironment(server: SecFnServer, scope: SecFnDomainScope, id: string) {
  const values = await server.vault.listEnvironments({ tenantId: scope.tenantId, namespaceId: scope.namespaceId, namespace: scope.namespace });
  const value = values.find((entry) => entry.id === id && belongsToScope(entry, scope));
  if (!value) throw new AdminError("not_found", "Environment was not found in the active SecFn scope.");
  return value;
}

async function findScopedSecret(server: SecFnServer, scope: SecFnDomainScope, id: string) {
  const value = await server.vault.getSecret(id);
  assertScoped(value, scope, "Secret");
  return value;
}

async function findScopedSet(server: SecFnServer, scope: SecFnDomainScope, id: string) {
  const value = await server.vault.getSecretSet(id);
  assertScoped(value, scope, "Secret set");
  return value;
}

function auditQuery(input: AuditEventListInput, scope: SecFnDomainScope) {
  return {
    tenantId: scope.tenantId,
    namespace: scope.namespace,
    type: input.type,
    severity: input.severity,
    actorId: input.actorId,
    resolved: input.resolved,
    limit: input.limit,
  };
}

/**
 * Creates the SecFn admin service from SecFn's public server services. All ID
 * operations perform a scope membership check before mutation because Vault
 * ID lookups are intentionally low-level and not tenant-aware by themselves.
 */
export function createSecFnDomainAdminService(options: SecFnDomainAdminServiceOptions): SecFnAdminService {
  const execute = async (request: SecFnDomainRequest): Promise<AdminOperationResult<JsonRecord>> => {
      try {
        const input = json(request.input ?? {});
        const [server, requestedScope] = await Promise.all([options.server(request.context), options.scope(request.context)]);
        const scopedOperation = request.operationId.startsWith("secfn.environments.")
          || request.operationId.startsWith("secfn.secrets.")
          || request.operationId.startsWith("secfn.secret-sets.")
          || request.operationId.startsWith("secfn.secret-set-members.")
          || request.operationId === "secfn.audit-events.list";
        const scope = scopedOperation ? await canonicalScope(server, requestedScope) : requestedScope;
        const scoped = scopeInput(scope);
        const actorId = actor(request.context);

        switch (request.operationId) {
          case "secfn.namespaces.list": {
            let values = await server.vault.listNamespaces({ tenantId: scope.tenantId });
            const search = optionalText(input.search, "search")?.toLowerCase();
            if (search) values = values.filter((value) => value.slug.toLowerCase().includes(search) || value.label.toLowerCase().includes(search));
            return paginatedList(values, input, request.context, "namespaces");
          }
          case "secfn.namespaces.create":
            return accepted(await server.vault.createNamespace({
              tenantId: scope.tenantId,
              slug: text(input.slug, "slug"),
              label: optionalText(input.label, "label"),
              description: optionalText(input.description, "description"),
              createdBy: actorId,
              metadata: input.metadata === undefined ? undefined : json(input.metadata, "metadata"),
            }));
          case "secfn.namespaces.update": {
            const id = text(input.id, "id");
            await findScopedNamespace(server, scope, id);
            return accepted(await server.vault.updateNamespace(id, {
              slug: optionalText(input.slug, "slug"),
              label: optionalText(input.label, "label"),
              description: optionalNullableText(input.description, "description"),
              metadata: input.metadata === null ? null : input.metadata === undefined ? undefined : json(input.metadata, "metadata"),
            }));
          }
          case "secfn.environments.list": {
            let values = await server.vault.listEnvironments({ tenantId: scope.tenantId, namespaceId: scope.namespaceId, namespace: scope.namespace });
            values = values.filter((value) => belongsToScope(value, scope));
            const search = optionalText(input.search, "search")?.toLowerCase();
            if (search) values = values.filter((value) => value.name.toLowerCase().includes(search) || (value.description ?? "").toLowerCase().includes(search));
            return paginatedList(values, input, request.context, "environments");
          }
          case "secfn.environments.create":
            return accepted(await server.vault.createEnvironment({
              tenantId: scope.tenantId,
              namespaceId: scope.namespaceId,
              namespace: scope.namespace,
              name: text(input.name, "name"),
              description: optionalText(input.description, "description"),
              createdBy: actorId,
              metadata: input.metadata === undefined ? undefined : json(input.metadata, "metadata"),
            }));
          case "secfn.environments.update": {
            const id = text(input.id, "id");
            await findScopedEnvironment(server, scope, id);
            return accepted(await server.vault.updateEnvironment(id, {
              name: optionalText(input.name, "name"),
              description: optionalNullableText(input.description, "description"),
              metadata: input.metadata === null ? null : input.metadata === undefined ? undefined : json(input.metadata, "metadata"),
            }));
          }
          case "secfn.secrets.list": {
            const page = await server.vault.listSecrets({
              ...scoped,
              cursor: optionalText(input.cursor, "cursor"),
              limit: isNumber(input.limit) ? input.limit : undefined,
              search: optionalText(input.search, "search"),
              tag: optionalText(input.tag, "tag"),
            });
            return list(page.items.filter((value) => belongsToScope(value, scope)), page.nextCursor);
          }
          case "secfn.secrets.get": return item(await findScopedSecret(server, scope, text(input.id, "id")));
          case "secfn.secrets.create":
            return accepted(await server.vault.createSecret({
              ...scoped,
              key: text(input.key, "key"),
              value: text(input.value, "value"),
              description: optionalText(input.description, "description"),
              tags: input.tags as string[] | undefined,
              metadata: input.metadata === undefined ? undefined : json(input.metadata, "metadata"),
              createdBy: actorId,
            }));
          case "secfn.secrets.update": {
            const id = text(input.id, "id");
            await findScopedSecret(server, scope, id);
            return accepted(await server.vault.updateSecret(id, {
              ...scoped,
              key: optionalText(input.key, "key"),
              description: optionalNullableText(input.description, "description"),
              tags: input.tags as string[] | undefined,
              actorId,
              requireRenameConfirmation: true,
            }));
          }
          case "secfn.secrets.rotate": {
            const id = text(input.id, "id");
            await findScopedSecret(server, scope, id);
            return accepted(await server.vault.rotateSecret(id, { value: text(input.value, "value"), actorId }));
          }
          case "secfn.secrets.revoke": {
            const id = text(input.id, "id");
            await findScopedSecret(server, scope, id);
            await server.vault.revokeSecret(id, actorId);
            return accepted();
          }
          case "secfn.secrets.delete": {
            const id = text(input.id, "id");
            await findScopedSecret(server, scope, id);
            await server.vault.deleteSecret(id, actorId);
            return accepted();
          }
          case "secfn.secret-sets.list": {
            const values = await server.vault.listSecretSets(scoped);
            return list(values.filter((value) => belongsToScope(value, scope)));
          }
          case "secfn.secret-sets.get": return item(await findScopedSet(server, scope, text(input.id, "id")));
          case "secfn.secret-sets.create":
            return accepted(await server.vault.createSecretSet({
              ...scoped,
              name: text(input.name, "name"),
              description: optionalText(input.description, "description"),
              members: input.members as Array<{ secretId: string; alias?: string }> | undefined,
              createdBy: actorId,
            }));
          case "secfn.secret-sets.update": {
            const id = text(input.id, "id");
            await findScopedSet(server, scope, id);
            return accepted(await server.vault.updateSecretSet(id, { name: optionalText(input.name, "name"), description: optionalNullableText(input.description, "description"), actorId }));
          }
          case "secfn.secret-sets.delete": {
            const id = text(input.id, "id");
            await findScopedSet(server, scope, id);
            await server.vault.deleteSecretSet(id, actorId);
            return accepted();
          }
          case "secfn.secret-set-members.list": {
            const setId = text(input.setId, "setId");
            await findScopedSet(server, scope, setId);
            return list(await server.vault.listSecretSetMembers(setId));
          }
          case "secfn.secret-set-members.add": {
            const setId = text(input.setId, "setId");
            const secretId = text(input.secretId, "secretId");
            await Promise.all([findScopedSet(server, scope, setId), findScopedSecret(server, scope, secretId)]);
            return accepted(await server.vault.addSecretSetMember(setId, secretId, optionalText(input.alias, "alias")));
          }
          case "secfn.secret-set-members.update": {
            const setId = text(input.setId, "setId");
            const id = text(input.id, "id");
            await findScopedSet(server, scope, setId);
            const members = await server.vault.listSecretSetMembers(setId);
            if (!members.some((member) => member.id === id)) throw new AdminError("not_found", "Secret-set member was not found in the active scope.");
            if (input.secretId !== undefined) await findScopedSecret(server, scope, text(input.secretId, "secretId"));
            return accepted(await server.vault.updateSecretSetMember(id, { secretId: optionalText(input.secretId, "secretId"), alias: optionalNullableText(input.alias, "alias") }));
          }
          case "secfn.secret-set-members.remove": {
            const setId = text(input.setId, "setId");
            const id = text(input.id, "id");
            await findScopedSet(server, scope, setId);
            const members = await server.vault.listSecretSetMembers(setId);
            if (!members.some((member) => member.id === id)) throw new AdminError("not_found", "Secret-set member was not found in the active scope.");
            await server.vault.removeSecretSetMember(id);
            return accepted();
          }
          case "secfn.audit-events.list":
            return list(await server.audit.queryEvents(auditQuery(input, scope)));
          case "secfn.scanner.scan-content": {
            const findings = server.scanner.scanContent(text(input.content, "content"), { path: text(input.path, "path"), displayPath: optionalText(input.displayPath, "displayPath") });
            return { ok: true, data: { accepted: true, findings, findingCount: findings.length } };
          }
          case "secfn.rate-limits.check":
            return item(await server.rateLimit.check({
              userId: optionalText(input.userId, "userId") ?? actorId,
              ip: optionalText(input.ip, "ip"),
              endpoint: optionalText(input.endpoint, "endpoint"),
              tenantId: scope.tenantId,
              namespace: scope.namespace,
            }));
          default:
            throw new AdminError("not_found", "Unsupported SecFn admin operation.");
        }
      } catch (error) {
        return mapDomainError(error);
      }
    };

  const operation = <K extends SecFnAdminOperationId>(operationId: K): SecFnAdminServiceMethod<K> =>
    async (input, context) => execute({ operationId, input, context } as SecFnDomainRequest);

  return {
    listNamespaces: operation("secfn.namespaces.list"),
    createNamespace: operation("secfn.namespaces.create"),
    updateNamespace: operation("secfn.namespaces.update"),
    listEnvironments: operation("secfn.environments.list"),
    createEnvironment: operation("secfn.environments.create"),
    updateEnvironment: operation("secfn.environments.update"),
    listSecrets: operation("secfn.secrets.list"),
    getSecret: operation("secfn.secrets.get"),
    createSecret: operation("secfn.secrets.create"),
    updateSecret: operation("secfn.secrets.update"),
    rotateSecret: operation("secfn.secrets.rotate"),
    revokeSecret: operation("secfn.secrets.revoke"),
    deleteSecret: operation("secfn.secrets.delete"),
    listSecretSets: operation("secfn.secret-sets.list"),
    getSecretSet: operation("secfn.secret-sets.get"),
    createSecretSet: operation("secfn.secret-sets.create"),
    updateSecretSet: operation("secfn.secret-sets.update"),
    deleteSecretSet: operation("secfn.secret-sets.delete"),
    listSecretSetMembers: operation("secfn.secret-set-members.list"),
    addSecretSetMember: operation("secfn.secret-set-members.add"),
    updateSecretSetMember: operation("secfn.secret-set-members.update"),
    removeSecretSetMember: operation("secfn.secret-set-members.remove"),
    listAuditEvents: operation("secfn.audit-events.list"),
    scanContent: operation("secfn.scanner.scan-content"),
    checkRateLimit: operation("secfn.rate-limits.check"),
  };
}

export function isSecFnAdminOperationId(value: string): value is SecFnAdminOperationId {
  return value.startsWith("secfn.");
}
