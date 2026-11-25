/**
 * Server-side authorization enforcement based on permissions policy.
 * Enforces read/write field policies and rejects unauthorized access with FORBIDDEN.
 */

import type {
  DatafnDefaultPermissionsFieldMode,
  DatafnDefaultPermissionsPolicy,
  DatafnSchema,
  DatafnResourceSchema,
  DatafnPermissionsPolicy
} from "../core-types.js";
import type { Adapter } from "@superfunctions/db";
import {
  endpointIncludes,
  endpointList,
  findRelationMatch,
  firstEndpoint,
  getCapabilityFields,
  getTemporalClauses,
  getTemporalGroupAliases,
  parseSortTerm,
  relationFkFieldForManyOne,
  relationFkFieldForOneMany,
  relationTargetEndpoint,
  resolveCapabilities,
} from "@datafn/core";
import type { CapabilityEntry, ShareableCapability } from "@datafn/core";
import { canonicalizeActorPrincipal, resolveEffectivePrincipals } from "../execution/auth/principal-resolver.js";
import { resolveEffectiveLevel, type AccessGrant } from "../execution/auth/access-resolver.js";
import {
  getSpv2MigrationRuntimeConfig,
  resolveAccessLevelFromLegacyV1,
  resolveDualReadAccessDecision,
} from "../execution/migration/spv2.js";

/**
 * Error result for authorization failures
 */
export type AuthzError = {
  ok: false;
  code: "FORBIDDEN";
  message: string;
  path: string;
};

/**
 * Options for authorization validation
 */
export type AuthzOptions = {
  /** VAL-001: Allow queries/mutations on resources with no policy. Default: false (deny-by-default). */
  allowUnknownResources?: boolean;
  /** VAL-009: Debug mode — when false, strip field/schema details from error messages. Default: true. */
  debug?: boolean;
};

function isShareableCapability(entry: CapabilityEntry): entry is ShareableCapability {
  return typeof entry === "object" && entry !== null && "shareable" in entry;
}

function getCapabilityFieldSets(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
): {
  capabilityFields: Set<string>;
  readonlyCapabilityFields: Set<string>;
} {
  const resolvedCapabilities = resolveCapabilities(
    schema.capabilities as any,
    resource.capabilities as any,
  );
  const capabilityFieldDefs = getCapabilityFields(resolvedCapabilities as any);
  const capabilityFields = new Set<string>();
  const readonlyCapabilityFields = new Set<string>();

  for (const fieldDef of capabilityFieldDefs) {
    capabilityFields.add(fieldDef.name);
    if (fieldDef.readonly) {
      readonlyCapabilityFields.add(fieldDef.name);
    }
  }

  return { capabilityFields, readonlyCapabilityFields };
}

function getReadFields(policy: DatafnPermissionsPolicy | undefined): readonly string[] {
  return policy?.read?.fields || [];
}

function defaultPermissionModeEnabled(
  value: unknown,
): value is DatafnDefaultPermissionsFieldMode {
  return value === "allResourceFields";
}

function relationWriteModeEnabled(
  value: DatafnDefaultPermissionsPolicy,
): boolean {
  return typeof value === "object" && value.relationWrites === "all";
}

function resourceFieldNames(resource: DatafnResourceSchema): string[] {
  return [...new Set(["id", ...resource.fields.map((field) => field.name)])];
}

function relationWriteFields(schema: DatafnSchema, resourceName: string): string[] {
  const names = new Set<string>();
  for (const relation of schema.relations ?? []) {
    if (relation.relation && endpointIncludes(relation.from, resourceName)) {
      names.add(relation.relation);
    }
    if (relation.inverse && endpointIncludes(relation.to, resourceName)) {
      names.add(relation.inverse);
    }
  }
  return [...names];
}

function resolveDefaultPermissions(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
): DatafnPermissionsPolicy | undefined {
  if (resource.defaultPermissions === false) {
    return undefined;
  }

  const defaults = schema.defaultPermissions;
  if (!defaults) {
    return undefined;
  }

  const fields = resourceFieldNames(resource);
  const readDefault = typeof defaults === "string" ? defaults : defaults.read;
  const writeDefault = typeof defaults === "string" ? defaults : defaults.write;
  const readFields = defaultPermissionModeEnabled(readDefault) ? fields : undefined;
  const writeFields = defaultPermissionModeEnabled(writeDefault)
    ? fields.concat(
        relationWriteModeEnabled(defaults)
          ? relationWriteFields(schema, resource.name)
          : [],
      )
    : undefined;

  if (!readFields && !writeFields) {
    return undefined;
  }

  return {
    ...(readFields ? { read: { fields: readFields } } : {}),
    ...(writeFields ? { write: { fields: writeFields } } : {}),
  };
}

function resolvePermissions(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
): DatafnPermissionsPolicy | undefined {
  return resource.permissions ?? resolveDefaultPermissions(schema, resource);
}

function getResourceSchema(
  schema: DatafnSchema,
  resourceName: string,
): DatafnResourceSchema | undefined {
  return schema.resources.find((resource) => resource.name === resourceName);
}

function canReadField(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
  field: string,
): boolean {
  if (field === "id") {
    return true;
  }
  const { capabilityFields } = getCapabilityFieldSets(schema, resource);
  if (capabilityFields.has(field)) {
    return true;
  }
  return getReadFields(resolvePermissions(schema, resource)).includes(field);
}

/**
 * DATA-41: whether a caller may read every field of the resource (each
 * schema field, and each key of `row` when given), so a row and its
 * revision may be returned whole. Decided from the policy, not only the keys
 * a row happens to carry: an unset hidden field still hides writes to it.
 * Resources without a policy are read in full by anyone the route already
 * let through (`allowUnknownResources`).
 */
export function canReadEveryField(
  schema: DatafnSchema,
  resourceName: string,
  row?: Record<string, unknown>,
): boolean {
  const resource = getResourceSchema(schema, resourceName);
  if (!resource) return false;
  if (!resolvePermissions(schema, resource)) return true;
  const declared = resourceFieldNames(resource);
  const fields = new Set([...declared, ...Object.keys(row ?? {})]);
  return [...fields].every(
    (field) => field === "__ns" || isRevisionMetadata(declared, field) || canReadField(schema, resource, field),
  );
}

/** `$rev` is revision metadata unless the resource declares its own `$rev` field. */
function isRevisionMetadata(declared: readonly string[], field: string): boolean {
  return field === "$rev" && !declared.includes("$rev");
}

/**
 * DATA-41: a copy of `row` without the fields the resource's read policy
 * withholds (and without `$rev` revision metadata, which only a complete row
 * may carry; a resource's own declared `$rev` field is an ordinary field).
 * Resources without a policy are returned unchanged.
 */
export function withoutUnreadableFields(
  schema: DatafnSchema,
  resourceName: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const resource = getResourceSchema(schema, resourceName);
  if (!resource || !resolvePermissions(schema, resource)) return row;
  const declared = resourceFieldNames(resource);
  const readable: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    if (field === "__ns" || (!isRevisionMetadata(declared, field) && canReadField(schema, resource, field))) {
      readable[field] = value;
    }
  }
  return readable;
}

/**
 * DATA-41: a copy of `row` without the declared schema fields of the
 * resource that its read policy withholds. Keys the schema does not declare
 * (aggregation aliases, a resource's own declared `$rev` is declared and kept
 * when readable) are returned unchanged.
 */
export function withoutHiddenDeclaredFields(
  schema: DatafnSchema,
  resourceName: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const resource = getResourceSchema(schema, resourceName);
  if (!resource || !resolvePermissions(schema, resource)) return row;
  const declared = new Set(resourceFieldNames(resource));
  const hidden = Object.keys(row).filter(
    (field) => declared.has(field) && !canReadField(schema, resource, field),
  );
  if (hidden.length === 0) return row;
  const copy = { ...row };
  for (const field of hidden) delete copy[field];
  return copy;
}

/**
 * A relation of `resource` whose foreign key is stored on `resource` under
 * the relation's own name (e.g. a many-one `parent` with fkField "parent").
 */
function isForeignKeyNamedManyOne(schema: DatafnSchema, resource: string, name: string): boolean {
  const match = findRelationMatch(schema as any, resource, name);
  if (!match) return false;
  const relation = match.relation as any;
  if (relation.type === "many-one" && match.direction === "forward") {
    return relationFkFieldForManyOne(relation) === name;
  }
  if (relation.type === "one-many" && match.direction === "inverse") {
    return (relation.fkField || relation.foreignKey || `${relation.inverse}Id`) === name;
  }
  return false;
}

function resolveRelationTargetResources(
  schema: DatafnSchema,
  sourceResource: string,
  relationName: string,
): string[] {
  if (!Array.isArray(schema.relations)) {
    return [];
  }
  const match = findRelationMatch(schema, sourceResource, relationName);
  return match ? endpointList(relationTargetEndpoint(match.relation, match.direction)) : [];
}

/**
 * Validate that a query adheres to read permissions policy
 */
export function validateQueryAuthz(
  query: Record<string, unknown>,
  schema: DatafnSchema,
  opts?: AuthzOptions,
): { ok: true } | AuthzError {
  const resource = schema.resources.find((r) => r.name === query.resource);
  if (!resource) {
    // Resource not found should be caught by schema validation first
    return { ok: true };
  }

  const policy = resolvePermissions(schema, resource);
  if (!policy) {
    // VAL-001: Deny-by-default — resources without a policy are FORBIDDEN unless escape hatch enabled
    if (!opts?.allowUnknownResources) {
      const message = opts?.debug === false
        ? "Authorization denied"
        : `No authorization policy found for resource '${query.resource}'. Define a policy or use allowUnknownResources: true to allow.`;
      return {
        ok: false,
        code: "FORBIDDEN",
        message,
        path: "resource",
      };
    }
    return { ok: true };
  }

  const { capabilityFields } = getCapabilityFieldSets(schema, resource);

  // Validate select fields (including nested relation target fields)
  if (query.select && Array.isArray(query.select)) {
    for (let i = 0; i < query.select.length; i++) {
      const token = query.select[i];
      if (typeof token !== "string") continue;
      if (token === "*") continue;

      const parts = token.split(".");
      let currentResourceNames = [resource.name];

      for (let segmentIndex = 0; segmentIndex < parts.length; segmentIndex++) {
        const segment = parts[segmentIndex];
        const isLastSegment = segmentIndex === parts.length - 1;
        const isDirective = segment === "*" || segment === "#" || segment === "*#";

        if (isDirective && isLastSegment) {
          break;
        }

        const relationTargets = [
          ...new Set(
            currentResourceNames.flatMap((currentResourceName) =>
              resolveRelationTargetResources(schema, currentResourceName, segment),
            ),
          ),
        ];
        if (relationTargets.length > 0) {
          // A many-one relation that stores its id under its own name (e.g.
          // node.parent) returns that field's value; it needs read access to
          // the field as well.
          const hidesUnreadableField = currentResourceNames.some((currentResourceName) => {
            const currentResource = getResourceSchema(schema, currentResourceName);
            return (
              !!currentResource &&
              isForeignKeyNamedManyOne(schema, currentResourceName, segment) &&
              !canReadField(schema, currentResource, segment)
            );
          });
          if (hidesUnreadableField) {
            return {
              ok: false,
              code: "FORBIDDEN",
              message: "Read access denied",
              path: `select[${i}]`,
            };
          }
          currentResourceNames = relationTargets;
          continue;
        }

        const readable = currentResourceNames.every((currentResourceName) => {
          const currentResource = getResourceSchema(schema, currentResourceName);
          return currentResource ? canReadField(schema, currentResource, segment) : true;
        });
        if (!readable) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Read access denied",
            path: `select[${i}]`,
          };
        }

        // Field segment terminates traversal.
        break;
      }
    }
  }

  // Validate filter fields
  if (query.filters && typeof query.filters === "object") {
    const filterFieldsResult = extractFieldsFromFilter(
      query.filters as Record<string, unknown>,
      resource,
      policy,
      capabilityFields,
      schema,
    );
    if (!filterFieldsResult.ok) {
      return filterFieldsResult;
    }
  }

  const readFields = policy.read?.fields || [];
  const temporalAliases = getTemporalGroupAliases(query);

  for (const clause of getTemporalClauses(query)) {
    const field = clause.field;
    if (field === "id" || capabilityFields.has(field)) continue;
    if (!readFields.includes(field)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Authorization denied",
        path: "temporal.field",
      };
    }
  }

  // SEC-003: Validate aggregation fields
  if (query.aggregations && typeof query.aggregations === "object" && !Array.isArray(query.aggregations)) {
    const aggs = query.aggregations as Record<string, Record<string, unknown>>;
    for (const [alias, def] of Object.entries(aggs)) {
      if (typeof def === "object" && def !== null && typeof def.field === "string") {
        const field = def.field;
        if (field === "*" || field === "id") continue;
        if (!capabilityFields.has(field) && !readFields.includes(field)) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Authorization denied",
            path: `aggregations.${alias}.field`,
          };
        }
      }
    }
  }

  // SEC-003: Validate groupBy fields
  if (query.groupBy && Array.isArray(query.groupBy)) {
    for (let i = 0; i < query.groupBy.length; i++) {
      const field = query.groupBy[i];
      if (typeof field !== "string") continue;
      if (field === "id" || capabilityFields.has(field)) continue;
      if (!readFields.includes(field)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `groupBy[${i}]`,
        };
      }
    }
  }

  // SEC-003: Validate having clause (recursive field extraction)
  if (query.having && typeof query.having === "object" && !Array.isArray(query.having)) {
    const havingResult = extractFieldsFromFilter(
      query.having as Record<string, unknown>,
      resource,
      policy,
      capabilityFields,
    );
    if (!havingResult.ok) {
      return { ...havingResult, path: `having.${havingResult.path.replace(/^filters\./, "")}` };
    }
  }

  // SEC-003: Validate sort fields
  if (query.sort && Array.isArray(query.sort)) {
    for (let i = 0; i < query.sort.length; i++) {
      const sortItem = query.sort[i];
      let field: string;
      try {
        field = parseSortTerm(sortItem).field;
      } catch {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `sort[${i}]`,
        };
      }
      if (field === "id" || capabilityFields.has(field)) continue;
      // Allow sorting by aggregation aliases
      if (query.aggregations && typeof query.aggregations === "object" && field in (query.aggregations as object)) {
        continue;
      }
      if (temporalAliases.has(field)) {
        continue;
      }
      const isField = resource.fields.some((f) => f.name === field) ||
                      capabilityFields.has(field);
      if (isField && !readFields.includes(field)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `sort[${i}]`,
        };
      }
    }
  }

  // SEC-003: Validate search.fields
  if (query.search && typeof query.search === "object" && !Array.isArray(query.search)) {
    const search = query.search as Record<string, unknown>;
    if (search.fields && Array.isArray(search.fields)) {
      for (let i = 0; i < search.fields.length; i++) {
        const field = search.fields[i];
        if (typeof field !== "string") continue;
        if (field === "id" || capabilityFields.has(field)) continue;
        if (!readFields.includes(field)) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Authorization denied",
            path: `search.fields[${i}]`,
          };
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Extract and validate fields from a filter object
 */
function extractFieldsFromFilter(
  filter: Record<string, unknown>,
  resource: DatafnResourceSchema,
  policy: DatafnPermissionsPolicy,
  capabilityFields: Set<string>,
  schema?: DatafnSchema,
): { ok: true } | AuthzError {
  const readFields = policy.read?.fields || [];

  for (const [key, value] of Object.entries(filter)) {
    // Skip logical operators
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const subFilter of value) {
          if (typeof subFilter === "object" && subFilter !== null) {
            const result = extractFieldsFromFilter(
              subFilter as Record<string, unknown>,
              resource,
              policy,
              capabilityFields,
              schema,
            );
            if (!result.ok) return result;
          }
        }
      }
      continue;
    }

    // Extract base field name (handle dot-paths like "goal.label")
    const parts = key.split(".");
    const baseField = parts[0];

    // id and capability-managed fields are always allowed for filtering
    if (baseField === "id") continue;
    if (capabilityFields.has(baseField)) continue;

    // Check if it's a direct field (not a relation). A scalar filter on a
    // relation that stores its id under its own name (e.g. node.parent)
    // filters that field, declared or not; quantifier objects stay relation
    // filters.
    const isQuantifier =
      parts.length === 1 &&
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      ("$any" in value || "$all" in value || "$none" in value);
    const isField = resource.fields.some((f) => f.name === baseField) ||
                    capabilityFields.has(baseField) ||
                    (!!schema && parts.length === 1 && !isQuantifier &&
                      isForeignKeyNamedManyOne(schema, resource.name, baseField));

    if (isField && !readFields.includes(baseField)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Authorization denied",
        path: `filters.${key}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Validate that a mutation adheres to write permissions policy
 */
export function validateMutationAuthz(
  mutation: Record<string, unknown>,
  schema: DatafnSchema,
  opts?: AuthzOptions,
): { ok: true } | AuthzError {
  const resource = schema.resources.find((r) => r.name === mutation.resource);
  if (!resource) {
    // Resource not found should be caught by schema validation first
    return { ok: true };
  }

  const policy = resolvePermissions(schema, resource);
  if (!policy) {
    // VAL-001: Deny-by-default — resources without a policy are FORBIDDEN unless escape hatch enabled
    if (!opts?.allowUnknownResources) {
      const message = opts?.debug === false
        ? "Authorization denied"
        : `No authorization policy found for resource '${mutation.resource}'. Define a policy or use allowUnknownResources: true to allow.`;
      return {
        ok: false,
        code: "FORBIDDEN",
        message,
        path: "resource",
      };
    }
    return { ok: true };
  }

  const { readonlyCapabilityFields } = getCapabilityFieldSets(schema, resource);

  const writeFields = policy.write?.fields || [];

  // Validate record fields for insert/merge/replace operations
  if (mutation.record && typeof mutation.record === "object") {
    const record = mutation.record as Record<string, unknown>;
    for (const fieldName of Object.keys(record)) {
      // id is a special case - always allowed for upsert/merge semantics
      if (fieldName === "id") continue;
      // readonly capability fields are excluded from write policy checks
      if (readonlyCapabilityFields.has(fieldName)) continue;

      // Check write policy
      if (!writeFields.includes(fieldName)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `record.${fieldName}`,
        };
      }
    }
  }

  // SEC-009: Validate relation mutations for relate/modifyRelation/unrelate
  const op = mutation.operation as string;
  if (op === "relate" || op === "modifyRelation" || op === "unrelate") {
    // `defaultPermissions.relationWrites: "all"` grants relation writes on
    // resources that use the defaults, even when the scalar write default is
    // off. It applies to relation operations only, and only once the defaults
    // resolve to a policy (read or write set to "allResourceFields"); with
    // neither set the resource has no policy and is denied above.
    const relationGrants =
      !resource.permissions &&
      resource.defaultPermissions !== false &&
      schema.defaultPermissions &&
      relationWriteModeEnabled(schema.defaultPermissions)
        ? relationWriteFields(schema, resource.name)
        : [];
    const relationAuthzResult = validateRelationAuthz(
      mutation,
      resource,
      relationGrants.length > 0 ? [...writeFields, ...relationGrants] : writeFields,
      schema,
    );
    if (!relationAuthzResult.ok) {
      return relationAuthzResult;
    }
  }

  return { ok: true };
}

/**
 * Validate relation operation against write fields policy (SEC-009).
 *
 * DFN-06: relation operations name their relations as the keys of
 * `mutation.relations`; every key must be writable. A relation counts as
 * writable when `write.fields` lists the relation name or, for relations that
 * store a foreign key on this resource, that FK field. The legacy singular
 * `mutation.relation` is checked too. A relation operation without any
 * relation name is denied.
 */
export function validateRelationAuthz(
  mutation: Record<string, unknown>,
  resource: { fields: readonly { name: string }[]; name?: string },
  writeFields: readonly string[],
  schema?: DatafnSchema,
): { ok: true } | AuthzError {
  const names: string[] = [];
  const relations = mutation.relations;
  if (relations && typeof relations === "object" && !Array.isArray(relations)) {
    names.push(...Object.keys(relations as Record<string, unknown>));
  }
  if (typeof mutation.relation === "string") {
    names.push(mutation.relation);
  }

  if (names.length === 0) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: "relations",
    };
  }

  for (const name of names) {
    if (writeFields.includes(name)) continue;
    const fkField = schema && resource.name
      ? findOwnForeignKeyField(schema, resource.name, name)
      : undefined;
    if (fkField && writeFields.includes(fkField)) continue;
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: `relations.${name}`,
    };
  }

  return { ok: true };
}

/**
 * The FK field a relation write through `relationName` stores, resolved the
 * same way the relation executor does (`findRelationMatch` plus the core FK
 * helpers), so a policy that lists the FK field allows the relation.
 */
function findOwnForeignKeyField(
  schema: DatafnSchema,
  resourceName: string,
  relationName: string,
): string | undefined {
  const match = findRelationMatch(schema, resourceName, relationName);
  if (!match) return undefined;
  const { relation, direction } = match;
  // htree: only the inverse (parent) direction writes an FK, on the model the
  // executor picks (the first `from` endpoint); the alias applies only when
  // that is this resource, i.e. the write lands on the authorized record. A
  // polymorphic `from` also writes the parent-resource discriminator, which
  // the FK field alone never granted, so it needs the relation name.
  if (relation.type === "htree" && direction === "inverse") {
    const froms = endpointList(relation.from);
    return froms.length === 1 && firstEndpoint(relation.from) === resourceName
      ? relation.fkField || relation.foreignKey || relation.inverse || "parentId"
      : undefined;
  }
  // many-one / one-many: when the referenced endpoint is polymorphic, link and
  // unlink also write a resource discriminator next to the FK (`to` for a
  // forward many-one, `from` for an inverse one-many, as in the executor's
  // fkResourcePatch), so the alias then needs the relation name granted.
  if (relation.type === "many-one" && direction === "forward") {
    return endpointList(relation.to).length === 1
      ? relationFkFieldForManyOne(relation)
      : undefined;
  }
  if (relation.type === "one-many" && direction === "inverse") {
    return endpointList(relation.from).length === 1
      ? relationFkFieldForOneMany(relation)
      : undefined;
  }
  return undefined;
}

export type ShareAccessLevel = "viewer" | "editor" | "owner";

const GLOBAL_PERMISSIONS_TABLE = "__datafn_permissions_global";
const PRINCIPAL_MEMBERSHIPS_TABLE = "__datafn_principal_memberships";
const PRINCIPAL_HIERARCHY_TABLE = "__datafn_principal_hierarchy";

function isGrantActive(row: Record<string, unknown>): boolean {
  return row.revokedAt === undefined || row.revokedAt === null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canonicalizePrincipalFromUserId(value: string): string {
  return value.includes(":") ? value : `user:${value}`;
}

function getShareableCapability(resource: DatafnResourceSchema, schema: DatafnSchema):
  | ShareableCapability
  | undefined {
  const resolved = resolveCapabilities(schema.capabilities as any, resource.capabilities as any);
  return resolved.find(isShareableCapability);
}

/**
 * True when the actor is the namespace's own principal. Such an actor owns
 * every record in the namespace (see `resolveAccessLevel`), so callers that
 * filter rows they have just loaded from that namespace can keep them all
 * without resolving access row by row.
 */
export function isNamespaceOwnerActor(
  actorId: string | undefined,
  namespace: string,
): boolean {
  if (!actorId) return false;
  const namespacePrincipal = normalizeNonEmptyString(namespace);
  return !!namespacePrincipal && canonicalizeActorPrincipal(actorId) === namespacePrincipal;
}

export function isPrivateShareableResource(
  schema: DatafnSchema,
  resourceName: string,
): boolean {
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource) return false;
  const capability = getShareableCapability(resource, schema);
  return capability?.shareable.default === "private";
}

async function resolveAccessLevelFromV2(
  db: Adapter,
  resource: string,
  recordId: string,
  actorId: string,
  namespace: string,
): Promise<ShareAccessLevel | null> {
  const principalResult = await resolveEffectivePrincipals({
    namespace,
    actorId,
    store: {
      getDirectMemberships: async ({ namespace: actorNamespace, actorId: actor }) => {
        const rows = await db.findMany({
          model: PRINCIPAL_MEMBERSHIPS_TABLE,
          where: [{ field: "actorId", operator: "eq", value: actor }],
          namespace: actorNamespace,
        });
        return rows
          .map((row) => row as Record<string, unknown>)
          .filter((row) => isGrantActive(row))
          .map((row) =>
            typeof row.principalId === "string" ? row.principalId : "",
          )
          .filter((principalId) => principalId.length > 0);
      },
      getHierarchyParents: async ({ namespace: actorNamespace, principalIds }) => {
        const edges: Array<{ principalId: string; parentPrincipalId: string }> = [];
        for (const principalId of principalIds) {
          const rows = await db.findMany({
            model: PRINCIPAL_HIERARCHY_TABLE,
            where: [{ field: "principalId", operator: "eq", value: principalId }],
            namespace: actorNamespace,
          });
          for (const row of rows) {
            const edge = row as Record<string, unknown>;
            if (!isGrantActive(edge)) {
              continue;
            }
            if (
              typeof edge.principalId === "string" &&
              typeof edge.parentPrincipalId === "string"
            ) {
              edges.push({
                principalId: edge.principalId,
                parentPrincipalId: edge.parentPrincipalId,
              });
            }
          }
        }
        return edges;
      },
    },
  });

  const grants: AccessGrant[] = [];
  for (const principalId of principalResult.effectivePrincipals) {
    const rows = await db.findMany({
      model: GLOBAL_PERMISSIONS_TABLE,
      where: [
        { field: "resourceType", operator: "eq", value: resource },
        { field: "resourceNs", operator: "eq", value: namespace },
        { field: "principalId", operator: "eq", value: principalId },
      ],
      namespace,
    });

    for (const row of rows) {
      const grant = row as Record<string, unknown>;
      if (!isGrantActive(grant)) {
        continue;
      }
      const level = grant.level;
      if (level !== "viewer" && level !== "editor" && level !== "owner") {
        continue;
      }

      const grantKind =
        grant.grantKind === "scope" || grant.resourceId === null
          ? "scope"
          : grant.grantKind === "relation_inherited"
            ? "relation_inherited"
            : "record";

      grants.push({
        principalId,
        level,
        grantKind,
        resourceId:
          typeof grant.resourceId === "string" ? grant.resourceId : null,
        sourceRef:
          typeof grant.sourceRef === "string" ? grant.sourceRef : null,
      });
    }
  }

  const effective = resolveEffectiveLevel({
    resourceId: recordId,
    effectivePrincipals: principalResult.effectivePrincipals,
    grants,
  });
  if (effective.effectiveLevel) {
    return effective.effectiveLevel;
  }
  return null;
}

export async function hasResourceScopeOwnerAccess(
  db: Adapter,
  resource: string,
  actorId: string | undefined,
  namespace: string,
): Promise<boolean> {
  if (!actorId) {
    return false;
  }

  const principalResult = await resolveEffectivePrincipals({
    namespace,
    actorId,
    store: {
      getDirectMemberships: async ({ namespace: actorNamespace, actorId: actor }) => {
        const rows = await db.findMany({
          model: PRINCIPAL_MEMBERSHIPS_TABLE,
          where: [{ field: "actorId", operator: "eq", value: actor }],
          namespace: actorNamespace,
        });
        return rows
          .map((row) => row as Record<string, unknown>)
          .filter((row) => isGrantActive(row))
          .map((row) =>
            typeof row.principalId === "string" ? row.principalId : "",
          )
          .filter((principalId) => principalId.length > 0);
      },
      getHierarchyParents: async ({ namespace: actorNamespace, principalIds }) => {
        const edges: Array<{ principalId: string; parentPrincipalId: string }> = [];
        for (const principalId of principalIds) {
          const rows = await db.findMany({
            model: PRINCIPAL_HIERARCHY_TABLE,
            where: [{ field: "principalId", operator: "eq", value: principalId }],
            namespace: actorNamespace,
          });
          for (const row of rows) {
            const edge = row as Record<string, unknown>;
            if (!isGrantActive(edge)) {
              continue;
            }
            if (
              typeof edge.principalId === "string" &&
              typeof edge.parentPrincipalId === "string"
            ) {
              edges.push({
                principalId: edge.principalId,
                parentPrincipalId: edge.parentPrincipalId,
              });
            }
          }
        }
        return edges;
      },
    },
  });

  if (principalResult.effectivePrincipals.includes(namespace)) {
    return true;
  }

  for (const principalId of principalResult.effectivePrincipals) {
    const rows = await db.findMany({
      model: GLOBAL_PERMISSIONS_TABLE,
      where: [
        { field: "resourceType", operator: "eq", value: resource },
        { field: "resourceNs", operator: "eq", value: namespace },
        { field: "principalId", operator: "eq", value: principalId },
        { field: "level", operator: "eq", value: "owner" },
      ],
      namespace,
    });

    const hasScopeOwnerGrant = rows.some((row) => {
      const grant = row as Record<string, unknown>;
      if (!isGrantActive(grant)) {
        return false;
      }
      return grant.grantKind === "scope" || grant.resourceId === null;
    });

    if (hasScopeOwnerGrant) {
      return true;
    }
  }

  return false;
}

export async function resolveAccessLevel(
  db: Adapter,
  schema: DatafnSchema,
  resource: string,
  recordId: string,
  actorId: string | undefined,
  namespace: string,
): Promise<ShareAccessLevel | null> {
  if (!actorId) {
    return null;
  }

  const resourceSchema = schema.resources.find((r) => r.name === resource);
  if (!resourceSchema) {
    return null;
  }

  const shareable = getShareableCapability(resourceSchema, schema);
  if (!shareable) {
    return null;
  }

  const record = await db.findOne({
    model: resource,
    where: [{ field: "id", operator: "eq", value: recordId }],
    namespace,
  });
  if (!record) {
    return null;
  }

  const recordObject = record as Record<string, unknown>;
  const actorPrincipal = canonicalizeActorPrincipal(actorId);
  if (isNamespaceOwnerActor(actorId, namespace)) {
    return "owner";
  }

  const createdByValue = normalizeNonEmptyString(recordObject.createdBy);
  if (
    createdByValue &&
    (createdByValue === actorId ||
      canonicalizePrincipalFromUserId(createdByValue) === actorPrincipal)
  ) {
    return "owner";
  }

  const readMode = getSpv2MigrationRuntimeConfig().readMode;
  if (readMode === "v1") {
    return await resolveAccessLevelFromLegacyV1({
      db,
      namespace,
      resource,
      recordId,
      actorId,
    });
  }

  const v2Level = await resolveAccessLevelFromV2(
    db,
    resource,
    recordId,
    actorId,
    namespace,
  );
  if (readMode === "v2") {
    return v2Level;
  }

  const v1Level = await resolveAccessLevelFromLegacyV1({
    db,
    namespace,
    resource,
    recordId,
    actorId,
  });
  return resolveDualReadAccessDecision({
    v1Level,
    v2Level,
  }).level;
}

export async function validateShareableOperationAccess(input: {
  db: Adapter;
  schema: DatafnSchema;
  resource: string;
  operation: string;
  id?: string;
  actorId: string | undefined;
  namespace: string;
  requireActorForPrivate?: boolean;
}): Promise<{ ok: true } | AuthzError> {
  const resourceSchema = getResourceSchema(input.schema, input.resource);
  if (!resourceSchema) {
    return { ok: true };
  }

  const shareable = getShareableCapability(resourceSchema, input.schema);
  if (!shareable) {
    return { ok: true };
  }

  if (
    input.requireActorForPrivate &&
    !input.actorId &&
    shareable.shareable.default === "private" &&
    input.operation !== "insert"
  ) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Actor required for private shareable operation",
      path: "operation",
    };
  }

  if (
    input.operation === "insert"
  ) {
    return { ok: true };
  }

  if (
    (input.operation === "share" || input.operation === "unshare") &&
    (typeof input.id !== "string" || input.id.length === 0)
  ) {
    if (
      !(await hasResourceScopeOwnerAccess(
        input.db,
        input.resource,
        input.actorId,
        input.namespace,
      ))
    ) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Authorization denied",
        path: "operation",
      };
    }
    return { ok: true };
  }

  if (typeof input.id !== "string" || input.id.length === 0) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: "operation",
    };
  }

  if (
    input.operation === "merge" ||
    input.operation === "replace" ||
    input.operation === "delete"
  ) {
    const existingRecord = await input.db.findOne({
      model: input.resource,
      where: [{ field: "id", operator: "eq", value: input.id }],
      namespace: input.namespace,
    });
    if (!existingRecord) {
      return { ok: true };
    }
  }

  const accessLevel = await resolveAccessLevel(
    input.db,
    input.schema,
    input.resource,
    input.id,
    input.actorId,
    input.namespace,
  );

  const isOwner = accessLevel === "owner";
  const isEditor = accessLevel === "editor";
  const allowed = isOwner
    ? true
    : isEditor
      ? input.operation !== "delete" &&
        input.operation !== "share" &&
        input.operation !== "unshare"
      : false;

  if (!allowed) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: "operation",
    };
  }

  return { ok: true };
}
