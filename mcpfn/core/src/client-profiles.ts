import { schemaUriResolver } from "./schema-uri.js";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

import { canonicalJson, compareCodeUnits, sha256 } from "./canonical.js";
import { McpFnClientProfileError } from "./errors.js";
import { schemaEngine, validateSchemaCollection } from "./validation.js";
import type {
  McpFnListedTool,
  McpFnReportedClient,
  McpFnRequestExtra,
  McpFnSchemaIssue,
} from "./types.js";

export interface McpFnVerifiedClientIdentity {
  /** Stable authenticated subject. Never derived from initialize.clientInfo. */
  subject: string;
  /** Optional non-secret attributes used by product-owned profile selection. */
  attributes?: Record<string, string | number | boolean | null>;
}

export interface McpFnClientProfileHookInput<TContext> {
  context: TContext;
  extra: McpFnRequestExtra;
  verifiedIdentity: McpFnVerifiedClientIdentity;
  reportedClient: McpFnReportedClient;
}

export interface McpFnClientProfileCatalogInput<TContext>
  extends McpFnClientProfileHookInput<TContext> {
  tools: McpFnListedTool[];
}

export interface McpFnClientProfileCallInput<TContext>
  extends McpFnClientProfileHookInput<TContext> {
  tool: McpFnListedTool;
  arguments: Record<string, unknown>;
}

export interface McpFnClientProfile<TContext = undefined> {
  id: string;
  version: string;
  /** Defaults to true. Set false only when hooks do not use initialization metadata. */
  requiresReportedClient?: boolean;
  /** Selection is deliberately restricted to verified identity. */
  matches(identity: McpFnVerifiedClientIdentity): boolean | Promise<boolean>;
  projectCatalog?(
    input: McpFnClientProfileCatalogInput<TContext>,
  ): Tool[] | Promise<Tool[]>;
  /** Root argument names owned by the server for each tool. */
  serverOwnedArguments?: Readonly<Record<string, readonly string[]>>;
  enrichArguments?(
    input: McpFnClientProfileCallInput<TContext>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type McpFnClientProfileLifecycleStage =
  | "profile-resolution"
  | "catalog-projection"
  | "argument-enrichment"
  | "input-validation"
  | "invalid-arguments-handler"
  | "handler"
  | "output-validation"
  | "task-result-storage";

export interface McpFnClientProfileEvidence {
  formatVersion: 1;
  stage: McpFnClientProfileLifecycleStage;
  outcome: "started" | "succeeded" | "failed";
  profile?: { id: string; version: string };
  tool?: string;
  code?: string;
  issues?: McpFnSchemaIssue[];
}

export interface McpFnClientProfilesOptions<TContext = undefined> {
  profiles: readonly McpFnClientProfile<TContext>[];
  resolveVerifiedIdentity(input: {
    context: TContext;
    extra: McpFnRequestExtra;
  }):
    | McpFnVerifiedClientIdentity
    | undefined
    | Promise<McpFnVerifiedClientIdentity | undefined>;
  evidence?(event: McpFnClientProfileEvidence): void | Promise<void>;
  /**
   * A client that matches no profile (no verified identity, or an identity no
   * profile accepts) keeps the canonical catalog, except that by default
   * (`"reject"`) it does not see tools for which any profile declares
   * server-owned arguments, and calling one answers like an unknown tool. It
   * could not call them anyway: it may not supply those required arguments,
   * so it cannot choose a tenant or workspace value merely by not matching a
   * profile. `"allow"` lists those tools and passes their arguments to the
   * handler unchanged; the handler must then derive the value from trusted
   * context itself.
   */
  unmatchedServerOwnedArguments?: "reject" | "allow";
}

export interface McpFnCatalogChange {
  kind: "removed" | "modified";
  path: string;
  tool: string;
  beforeHash: string;
  afterHash?: string;
}

export interface McpFnResolvedClientProfile<TContext> {
  context: TContext;
  extra: McpFnRequestExtra;
  verifiedIdentity?: McpFnVerifiedClientIdentity;
  reportedClient: McpFnReportedClient;
  profile?: McpFnClientProfile<TContext>;
  /**
   * The profiles and unmatched-client policy this result was resolved with.
   * Set by resolveMcpFnClientProfile so buildMcpFnEffectiveCatalog and
   * enrichMcpFnClientProfileCall apply the same policy without being passed
   * the options again.
   */
  clientProfiles?: Pick<McpFnClientProfilesOptions<TContext>, "profiles" | "unmatchedServerOwnedArguments">;
}

function assertProfileMetadata(profile: McpFnClientProfile<unknown>): void {
  for (const [label, value] of [
    ["id", profile.id],
    ["version", profile.version],
  ] as const) {
    if (typeof value !== "string" || !value || value.length > 128 || !/^[A-Za-z0-9._/-]+$/.test(value)) {
      throw new McpFnClientProfileError(
        "MCPFN_INVALID_CLIENT_PROFILE",
        `Client profile ${label} must be a non-empty stable identifier`,
      );
    }
  }
}

export function validateMcpFnClientProfiles<TContext>(
  options: McpFnClientProfilesOptions<TContext>,
): void {
  if (
    options.unmatchedServerOwnedArguments !== undefined &&
    !["reject", "allow"].includes(options.unmatchedServerOwnedArguments)
  ) {
    throw new McpFnClientProfileError(
      "MCPFN_INVALID_CLIENT_PROFILE",
      'unmatchedServerOwnedArguments must be "reject" or "allow"',
    );
  }
  const ids = new Set<string>();
  for (const profile of options.profiles) {
    if (!profile || typeof profile !== "object" || typeof profile.matches !== "function") {
      throw new McpFnClientProfileError("MCPFN_INVALID_CLIENT_PROFILE", "Profiles require metadata and a matcher");
    }
    assertProfileMetadata(profile as McpFnClientProfile<unknown>);
    const ownership = profile.serverOwnedArguments;
    if (ownership !== undefined && (!ownership || typeof ownership !== "object" || Array.isArray(ownership) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(ownership)) ||
        Object.entries(ownership).some(([tool, names]) => !tool || !Array.isArray(names) ||
          names.some((name) => typeof name !== "string" || !name || ["__proto__", "constructor", "prototype"].includes(name)) ||
          new Set(names).size !== names.length))) {
      throw new McpFnClientProfileError("MCPFN_INVALID_CLIENT_PROFILE", "Server-owned arguments must map tools to unique root property names");
    }
    const key = `${profile.id}@${profile.version}`;
    if (ids.has(key)) {
      throw new McpFnClientProfileError(
        "MCPFN_DUPLICATE_CLIENT_PROFILE",
        `Duplicate client profile ${key}`,
      );
    }
    ids.add(key);
    if (
      Object.keys(profile.serverOwnedArguments ?? {}).length &&
      !profile.enrichArguments
    ) {
      throw new McpFnClientProfileError(
        "MCPFN_PROFILE_ENRICHER_REQUIRED",
        `Client profile ${key} declares server-owned arguments without an enricher`,
      );
    }
  }
}

export async function resolveMcpFnClientProfile<TContext>(
  options: McpFnClientProfilesOptions<TContext>,
  input: Omit<
    McpFnResolvedClientProfile<TContext>,
    "verifiedIdentity" | "profile"
  >,
): Promise<McpFnResolvedClientProfile<TContext>> {
  const verifiedIdentity = await options.resolveVerifiedIdentity({
    context: input.context,
    extra: input.extra,
  });
  const policy = {
    profiles: options.profiles,
    unmatchedServerOwnedArguments: options.unmatchedServerOwnedArguments,
  };
  if (!verifiedIdentity) return { ...input, verifiedIdentity, clientProfiles: policy };
  if (typeof verifiedIdentity.subject !== "string" || !verifiedIdentity.subject || verifiedIdentity.subject.length > 256) {
    throw new McpFnClientProfileError(
      "MCPFN_INVALID_VERIFIED_IDENTITY",
      "Verified client identity must contain a bounded subject",
    );
  }
  const matches: McpFnClientProfile<TContext>[] = [];
  for (const profile of options.profiles) {
    if (await profile.matches(verifiedIdentity)) matches.push(profile);
  }
  if (matches.length > 1) {
    throw new McpFnClientProfileError(
      "MCPFN_AMBIGUOUS_CLIENT_PROFILE",
      "Verified client identity matched multiple client profiles",
      { profiles: matches.map(({ id, version }) => ({ id, version })) },
    );
  }
  return { ...input, verifiedIdentity, profile: matches[0], clientProfiles: policy };
}

function isJsonMetadata(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const next = new Set(ancestors).add(value);
  return Array.isArray(value) ? Array.from(value).every(item => isJsonMetadata(item, next)) : Object.values(value).every(item => isJsonMetadata(item, next));
}

function assertProjectedCatalog(
  canonicalTools: McpFnListedTool[],
  knownTools: McpFnListedTool[],
  projectedTools: McpFnListedTool[],
  profile: McpFnClientProfile<unknown>,
  schemaResources: readonly object[],
): void {
  const canonical = new Map(canonicalTools.map((tool) => [tool.name, tool]));
  const known = new Map(knownTools.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  for (const tool of projectedTools) {
    if (!isJsonMetadata(tool) || !ToolSchema.safeParse(tool).success || !tool || typeof tool !== "object" || typeof tool.name !== "string" ||
        !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== "object") {
      throw new McpFnClientProfileError(
        "MCPFN_INVALID_PROJECTED_CATALOG",
        "Projected catalogs may contain only MCP tool definitions",
      );
    }
    if (!canonical.has(tool.name)) {
      throw new McpFnClientProfileError(
        "MCPFN_PROJECTED_TOOL_UNKNOWN",
        `Client profile ${profile.id} projected unknown tool ${tool.name}`,
        { tool: tool.name },
      );
    }
    if (seen.has(tool.name)) {
      throw new McpFnClientProfileError(
        "MCPFN_PROJECTED_TOOL_DUPLICATE",
        `Client profile ${profile.id} projected duplicate tool ${tool.name}`,
        { tool: tool.name },
      );
    }
    seen.add(tool.name);
  }

  for (const [toolName, ownedNames] of Object.entries(
    profile.serverOwnedArguments ?? {},
  )) {
    const canonicalTool = known.get(toolName);
    if (!canonicalTool) {
      throw new McpFnClientProfileError(
        "MCPFN_SERVER_ARGUMENT_TOOL_UNKNOWN",
        `Client profile ${profile.id} declares server-owned arguments for unknown tool ${toolName}`,
        { tool: toolName },
      );
    }
    if (!canonical.has(toolName)) continue;
    const visibleTool = projectedTools.find((tool) => tool.name === toolName);
    if (!visibleTool) continue;
    const ownedFields = new Set(ownedArguments(profile, visibleTool.name));
    const previous = anonymousBefore(schemaResources, canonicalTool.inputSchema);
    const canonicalShape = rootShape(canonicalTool.inputSchema, ownedFields, schemaResources, previous);
    const visibleShape = rootShape(visibleTool.inputSchema, ownedFields, schemaResources.filter(resource => canonicalJson(resource) !== canonicalJson(canonicalTool.inputSchema)), previous);
    const canonicalProperties = canonicalShape.properties;
    const canonicalRequired = canonicalShape.required;
    const visibleProperties = visibleShape.properties;
    const visibleRequired = visibleShape.required;
    for (const name of new Set(ownedNames)) {
      if (
        !Object.hasOwn(canonicalProperties, name) ||
        !canonicalRequired.has(name)
      ) {
        throw new McpFnClientProfileError(
          "MCPFN_SERVER_ARGUMENT_NOT_REQUIRED",
          `Server-owned argument ${toolName}.${name} must be a canonical required property`,
          { tool: toolName, property: name },
        );
      }
      if (Object.hasOwn(visibleProperties, name) || visibleRequired.has(name) || !visibleShape.prohibited.has(name)) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Server-owned argument ${toolName}.${name} remains model-visible`,
          { tool: toolName, property: name },
        );
      }
    }
  }

  for (const visibleTool of projectedTools) {
    const canonicalTool = canonical.get(visibleTool.name)!;
    const projectedResources = schemaResources.filter(resource => canonicalJson(resource) !== canonicalJson(canonicalTool.inputSchema));
    assertValidProfileSchema(visibleTool.inputSchema, projectedResources);
    const ownedFields = new Set(ownedArguments(profile, visibleTool.name));
    const previous = anonymousBefore(schemaResources, canonicalTool.inputSchema);
    const canonicalShape = rootShape(canonicalTool.inputSchema, ownedFields, schemaResources, previous);
    const visibleShape = rootShape(visibleTool.inputSchema, ownedFields, projectedResources, previous);
    const visibleRequired = visibleShape.required;
    const visibleProperties = visibleShape.properties;
    const owned = new Set(
      ownedArguments(profile, visibleTool.name),
    );
    if (owned.size && (canonicalShape.ownershipSensitive || visibleShape.ownershipSensitive)) {
      throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", "Server-owned fields cannot be hidden under conditional or whole-object constraints");
    }
    for (const name of Object.keys(canonicalShape.properties)) {
      if (!owned.has(name) && !Object.hasOwn(visibleProperties, name)) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Projected catalog hides ${visibleTool.name}.${name} without trusted enrichment`,
          { tool: visibleTool.name, property: name },
        );
      }
    }
    for (const [name, schema] of Object.entries(visibleProperties)) {
      if (!Object.hasOwn(canonicalShape.properties, name) || canonicalJson(schema) !== canonicalJson(canonicalShape.properties[name])) {
        throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", `Projected model-owned property ${visibleTool.name}.${name} must retain its canonical schema`);
      }
    }
    if ([...visibleRequired].some((name) => !canonicalShape.required.has(name))) {
      throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", "Projected catalogs cannot add required model-owned fields");
    }
    for (const required of canonicalShape.required) {
      if (owned.has(required)) continue;
      if (
        !visibleRequired.has(required)
      ) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Projected catalog weakens required ${visibleTool.name}.${required} without trusted enrichment`,
          { tool: visibleTool.name, property: required },
        );
      }
    }
    if (canonicalJson(canonicalShape.constraints) !== canonicalJson(visibleShape.constraints) ||
        canonicalJson(canonicalTool.outputSchema) !== canonicalJson(visibleTool.outputSchema) ||
        taskSupport(canonicalTool) !== taskSupport(visibleTool)) {
      throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", "Projected tools must preserve root constraints, output schemas and task support");
    }

  }
}

export async function buildMcpFnEffectiveCatalog<TContext>(input: {
  canonicalTools: McpFnListedTool[];
  /** Complete registry inventory when canonicalTools has already been visibility-filtered. */
  knownTools?: McpFnListedTool[];
  /** All registered resources, including schemas of hidden tools and prompts. */
  schemaResources?: readonly object[];
  resolved: McpFnResolvedClientProfile<TContext>;
  /**
   * The server's profile options; they take precedence over
   * `resolved.clientProfiles`. With either, a client that matches no profile
   * does not see tools that a profile gives server-owned arguments unless
   * `unmatchedServerOwnedArguments` is `"allow"`: such a client could never
   * call them.
   */
  clientProfiles?: Pick<
    McpFnClientProfilesOptions<TContext>,
    "profiles" | "unmatchedServerOwnedArguments"
  >;
}): Promise<{ tools: McpFnListedTool[]; changes: McpFnCatalogChange[] }> {
  const canonicalTools = structuredClone(input.canonicalTools);
  const knownTools = structuredClone(input.knownTools ?? input.canonicalTools);
  const profile = input.resolved.profile;
  if (!profile) {
    const options = input.clientProfiles ?? input.resolved.clientProfiles;
    if (!options || options.unmatchedServerOwnedArguments === "allow") {
      return { tools: canonicalTools, changes: [] };
    }
    const tools: McpFnListedTool[] = [];
    const changes: McpFnCatalogChange[] = [];
    for (const tool of canonicalTools) {
      if (unmatchedServerOwned(options.profiles, tool.name).length === 0) tools.push(tool);
      else changes.push({ kind: "removed", path: `tools.${tool.name}`, tool: tool.name, beforeHash: sha256(tool) });
    }
    return { tools, changes };
  }
  assertTrustedProfileIdentity(input.resolved);
  const projected = profile.projectCatalog
    ? await profile.projectCatalog({
        context: input.resolved.context,
        extra: input.resolved.extra,
        verifiedIdentity: input.resolved.verifiedIdentity!,
        reportedClient: input.resolved.reportedClient,
        tools: structuredClone(canonicalTools),
      })
    : canonicalTools;
  if (!Array.isArray(projected)) {
    throw new McpFnClientProfileError(
      "MCPFN_INVALID_PROJECTED_CATALOG",
      `Client profile ${profile.id} did not return a tool array`,
    );
  }
  assertProjectedCatalog(
    canonicalTools,
    knownTools,
    projected,
    profile as McpFnClientProfile<unknown>,
    input.schemaResources ?? knownTools.flatMap(tool => [tool.inputSchema, ...(tool.outputSchema ? [tool.outputSchema] : [])]),
  );
  const tools = structuredClone(projected).sort((left, right) => compareCodeUnits(left.name, right.name));
  const projectedByName = new Map(tools.map((tool) => [tool.name, tool]));
  const changes: McpFnCatalogChange[] = [];
  for (const canonical of canonicalTools) {
    const effective = projectedByName.get(canonical.name);
    if (!effective) {
      changes.push({
        kind: "removed",
        path: `tools.${canonical.name}`,
        tool: canonical.name,
        beforeHash: sha256(canonical),
      });
    } else if (canonicalJson(canonical) !== canonicalJson(effective)) {
      changes.push({
        kind: "modified",
        path: `tools.${canonical.name}`,
        tool: canonical.name,
        beforeHash: sha256(canonical),
        afterHash: sha256(effective),
      });
    }
  }
  return { tools, changes };
}

/** Every argument any profile declares server-owned for this tool. */
function unmatchedServerOwned<T>(profiles: readonly McpFnClientProfile<T>[], name: string): string[] {
  return [...new Set(profiles.flatMap((profile) => ownedArguments(profile, name)))];
}

function ownedArguments<T>(profile: McpFnClientProfile<T>, name: string): readonly string[] {
  const mapping = profile.serverOwnedArguments;
  return mapping && Object.hasOwn(mapping, name) ? mapping[name] : [];
}

function validateDefinitionContainers(schema: unknown, ajv: Ajv | Ajv2019 | Ajv2020): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const object = schema as Record<string, unknown>;
  for (const keyword of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]) {
    const entries = object[keyword];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const child of Object.values(entries)) {
      if (!ajv.validateSchema(child as object)) throw new Error("Invalid subschema");
      validateDefinitionContainers(child, ajv);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems", "items"]) {
    const entries = object[keyword];
    if (Array.isArray(entries)) for (const child of entries) validateDefinitionContainers(child, ajv);
  }
  for (const keyword of ["items", "additionalItems", "additionalProperties", "contains", "not", "if", "then", "else"]) validateDefinitionContainers(object[keyword], ajv);
}

// Cache only syntax validation; identity, projection and ownership checks still run per request.
const validProfileSchemas = new Set<string>();
// An absent or empty top-level $id leaves a schema anonymous, as at runtime. On
// Ajv so does "#" or "#/", which it normalizes to the same empty key and compiles
// with base ""; the edge engine keeps those IDs, so they stay named there.
function namedSchemaId(schema: object): string | undefined {
  const id = (schema as Record<string, unknown>).$id;
  if (typeof id !== "string" || id === "") return undefined;
  return schemaEngine !== "cfworker" && (id === "#" || id === "#/") ? undefined : id;
}
function profileSchemaResources(schema: Record<string, unknown>, resources: readonly object[]): object[] {
  const rootId = namedSchemaId(schema);
  const unique = new Map<string, object>();
  const rootKey = canonicalJson(schema);
  for (const resource of resources) {
    const key = canonicalJson(resource);
    if (!(rootId !== undefined && namedSchemaId(resource) === rootId) && key !== rootKey) unique.set(key, resource);
  }
  return [...unique.values(), schema];
}

function assertValidProfileSchema(schema: Record<string, unknown>, resources: readonly object[]): void {
  const graph = profileSchemaResources(schema, resources);
  const cacheKey = `${schemaEngine}:${sha256(graph)}`;
  if (validProfileSchemas.has(cacheKey)) return;
  try {
    const dialect = typeof schema.$schema === "string" ? schema.$schema : "http://json-schema.org/draft-07/schema#";
    if (schemaEngine === "cfworker") {
      if (!dialect.includes("draft-07")) {
        throw new Error("Modern projected schemas require a dialect-aware edge validator");
      }
      validateSchemaCollection(graph, "cfworker");
    } else {
      const Validator = dialect.includes("draft-07") ? Ajv : dialect.includes("2019-09") ? Ajv2019 : Ajv2020;
      const ajv = new Validator({ uriResolver: schemaUriResolver, strict: false, allowUnionTypes: true, validateFormats: false, logger: false,
        ...(dialect.includes("draft-07") ? { ignoreKeywordsWithRef: true } : {}),
      });
      for (const resource of graph) validateDefinitionContainers(resource, ajv);
      // Anonymous siblings need distinct registry keys without changing their JSON
      // Schema IDs. A relative key keeps Ajv's shared relative namespace, so an
      // authored relative $ref such as "shared" resolves as it does for every
      // other resource (and at runtime). The key carries a digest of the whole
      // graph, so no authored $id in that graph can claim it. The schema itself
      // is compiled without a key, as the runtime compiles each tool, so an
      // anonymous root keeps base "" and its dot-segment self references.
      const namespace = sha256(graph).slice(0, 32);
      for (const [index, resource] of graph.slice(0, -1).entries()) {
        ajv.addSchema(resource as object, namedSchemaId(resource) === undefined ? `mcpfn-profile-${namespace}-${index}` : undefined);
      }
      ajv.compile(schema);
    }
    if (validProfileSchemas.size >= 64) validProfileSchemas.delete(validProfileSchemas.values().next().value!);
    validProfileSchemas.add(cacheKey);
  }
  catch { throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Projected schema must be valid JSON Schema"); }
}

function objectArguments(value: unknown, source: "client" | "enricher" = "client"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // A malformed enricher result is a server fault, not client input.
    throw source === "client"
      ? new McpFnClientProfileError(
          "MCPFN_INVALID_PROFILE_ARGUMENTS",
          "Tool arguments must be an object before trusted enrichment",
        )
      : new McpFnClientProfileError(
          "MCPFN_PROFILE_ARGUMENT_MUTATION",
          "Trusted enrichment must return an arguments object",
        );
  }
  return value as Record<string, unknown>;
}

export async function enrichMcpFnClientProfileCall<TContext>(input: {
  resolved: McpFnResolvedClientProfile<TContext>;
  tool: McpFnListedTool;
  arguments: unknown;
  /**
   * The server's profile options. They take precedence over
   * `resolved.clientProfiles` (set by resolveMcpFnClientProfile). For a call
   * that matched no profile, the `unmatchedServerOwnedArguments` setting of
   * whichever is present (`"reject"` when unset) rejects only arguments that
   * some profile declares server-owned for the requested tool. Every other
   * unmatched call passes through unchanged, as does every call when neither
   * options object is present or the setting is `"allow"`.
   */
  clientProfiles?: Pick<
    McpFnClientProfilesOptions<TContext>,
    "profiles" | "unmatchedServerOwnedArguments"
  >;
}): Promise<unknown> {
  const profile = input.resolved.profile;
  if (!profile) {
    const value = input.arguments ?? {};
    // Defence in depth: the effective catalog already hides these tools from
    // unmatched clients, so a direct caller of this function is the only way here.
    const options = input.clientProfiles ?? input.resolved.clientProfiles;
    if (
      options &&
      options.unmatchedServerOwnedArguments !== "allow" &&
      value && typeof value === "object" && !Array.isArray(value)
    ) {
      for (const name of unmatchedServerOwned(options.profiles, input.tool.name)) {
        if (Object.hasOwn(value, name)) {
          throw new McpFnClientProfileError(
            "MCPFN_FORGED_SERVER_ARGUMENT",
            `Model arguments may not provide server-owned property ${name}`,
            { tool: input.tool.name, rejectedProperty: name },
          );
        }
      }
    }
    // Non-object arguments still reach canonical validation, which rejects them.
    return value;
  }
  const original = objectArguments(input.arguments ?? {});
  assertTrustedProfileIdentity(input.resolved);
  const owned = new Set(ownedArguments(profile, input.tool.name));
  for (const name of owned) {
    if (Object.hasOwn(original, name)) {
      throw new McpFnClientProfileError(
        "MCPFN_FORGED_SERVER_ARGUMENT",
        `Model arguments may not provide server-owned property ${name}`,
        { tool: input.tool.name, rejectedProperty: name },
      );
    }
  }
  if (!profile.enrichArguments) return original;
  const enriched = objectArguments(
    await profile.enrichArguments({
      context: input.resolved.context,
      extra: input.resolved.extra,
      verifiedIdentity: input.resolved.verifiedIdentity!,
      reportedClient: input.resolved.reportedClient,
      tool: structuredClone(input.tool),
      arguments: structuredClone(original),
    }),
    "enricher",
  );
  for (const [name, value] of Object.entries(original)) {
    if (owned.has(name)) continue;
    if (
      !Object.hasOwn(enriched, name) ||
      canonicalJson(enriched[name]) !== canonicalJson(value)
    ) {
      throw new McpFnClientProfileError(
        "MCPFN_PROFILE_ARGUMENT_MUTATION",
        `Trusted enrichment may not alter model-owned property ${name}`,
        { tool: input.tool.name, property: name },
      );
    }
  }
  for (const name of Object.keys(enriched)) {
    if (!Object.hasOwn(original, name) && !owned.has(name)) {
      throw new McpFnClientProfileError(
        "MCPFN_PROFILE_ARGUMENT_MUTATION",
        `Trusted enrichment added undeclared property ${name}`,
        { tool: input.tool.name, property: name },
      );
    }
  }
  for (const name of owned) {
    if (!Object.hasOwn(enriched, name)) {
      throw new McpFnClientProfileError(
        "MCPFN_MISSING_TRUSTED_CONTEXT",
        `Trusted enrichment did not provide server-owned property ${name}`,
        { tool: input.tool.name, property: name },
      );
    }
  }
  return enriched;
}

function assertTrustedProfileIdentity<T>(resolved: McpFnResolvedClientProfile<T>): void {
  if (typeof resolved.verifiedIdentity?.subject !== "string" || !resolved.verifiedIdentity.subject) {
    throw new McpFnClientProfileError("MCPFN_INVALID_VERIFIED_IDENTITY", "A resolved profile requires a verified identity");
  }
}

function taskSupport(tool: McpFnListedTool): string {
  if (tool.execution === undefined) return "forbidden";
  if (!tool.execution || typeof tool.execution !== "object" || Array.isArray(tool.execution) ||
      (tool.execution.taskSupport !== undefined && !["forbidden", "optional", "required"].includes(tool.execution.taskSupport))) {
    throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Invalid task execution metadata");
  }
  return tool.execution.taskSupport === undefined ? "forbidden" : tool.execution.taskSupport;
}

/** Visit schema positions without interpreting instance data as schema syntax. */
function mapSchemaKeyword(key: string, value: unknown, visit: (schema: unknown) => unknown, modern = false): unknown {
  // The registry's draft-07 Ajv ignores these later-draft containers. Do not
  // interpret their contents as active schemas (including nested $ref values).
  if (!modern && ["dependentSchemas", "prefixItems", "unevaluatedProperties", "unevaluatedItems"].includes(key)) return value;
  if (["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]));
  }
  if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value)) return value.map(visit);
  if (key === "items") return Array.isArray(value) ? value.map(visit) : visit(value);
  if (key === "dependencies" && value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, Array.isArray(child) ? child : visit(child)]));
  if (["additionalItems", "additionalProperties", "contains", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "propertyNames"].includes(key)) return visit(value);
  if (key === "contentSchema" && modern) return visit(value);
  return value;
}

// The runtime registry compiles schemaResources in order with one Ajv, whose ""
// entry is the last anonymous schema compiled. Returns that schema's canonical
// JSON for a root (null when none precedes it), or undefined when the root is
// not registered or its registrations see different ones. Ajv caches compiled
// schemas by object identity: a schema object it has already compiled neither
// takes the "" entry again nor registers again, while a copy does both.
function anonymousBefore(resources: readonly object[], root: object): string | null | undefined {
  const rootJson = canonicalJson(root);
  const seen = new Set<string | null>();
  const compiled = new Set<object>();
  let last: string | null = null;
  for (const resource of resources) {
    if (compiled.has(resource)) continue;
    compiled.add(resource);
    const json = canonicalJson(resource);
    if (json === rootJson) seen.add(last);
    if (namedSchemaId(resource) === undefined) last = json;
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

/** Resolve only root object composition; never traverse argument values. */
// Ajv and draft-07 clients both ignore assertion siblings of $ref. Resource IDs
// still affect reference resolution, so keep those fail-closed.
const DRAFT07_REF_UNSAFE_KEYWORDS = new Set(["$id", "id"]);

function rootShape(root: Record<string, unknown>, owned = new Set<string>(), schemaResources: readonly object[] = [], previousAnonymous?: string | null): { properties: Record<string, unknown>; required: Set<string>; constraints: string[]; ownershipSensitive: boolean; prohibited: Set<string> } {
  // JSON transports duplicate aliases. Give each occurrence its own identity so
  // relative references inherit the resource at that occurrence, not the first one.
  root = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  const properties: Record<string, unknown> = Object.create(null);
  const required = new Set<string>();
  const prohibited = new Set<string>();
  const constraints = new Set<string>();
  let ownershipSensitive = false;
  const seen = new Set<unknown>();
  // Keep resource roots separate from named aliases. In draft-07, $id: "#node"
  // names a subschema but does not make it the root for JSON Pointer fragments.
  // Resource identity follows the active validator, so the comparison never
  // folds IDs the validator keeps apart, or splits IDs it folds. On Ajv (the
  // runtime registry in validation.ts compiles each tool with one Ajv), targets
  // follow Ajv's own registry and lookup order; see ajvTarget below. The edge
  // runtime (validation.ts) resolves every ID against one absolute base, where
  // "shared" and "/shared" name one resource. Each anonymous resource (this root
  // and each anonymous sibling) keeps a private key used only for its own
  // fragment references and anchors. The keys carry a digest of the whole schema
  // graph, so no authored $id in that graph can name them: a sibling can never
  // take over this root's local references, or another sibling's.
  const siblings = profileSchemaResources(root, schemaResources).slice(0, -1);
  const namespace = sha256([root, siblings]).slice(0, 32);
  const literalRootIds = schemaEngine !== "cfworker";
  const sharedBase = literalRootIds ? "" : `https://${namespace}.relative.mcpfn.invalid/`;
  const privateKey = (label: string) => `https://${label}.${namespace}.mcpfn.invalid/schema`;
  const rootKey = privateKey("root");
  const privateKeys = new Set([rootKey, ...siblings.map((_, position) => privateKey(`resource-${position}`))]);
  // Inside an anonymous resource, the runtime treats a reference whose literal
  // dot segments resolve to no resource ("./#/x", "../#/x", ".") as a reference
  // to that resource itself (schema-uri.ts, validation.ts).
  const selfReference = (reference: string, local: string) => {
    if (!privateKeys.has(local)) return undefined;
    const resolved = schemaUriResolver.resolve("", reference);
    return resolved === "" || resolved.startsWith("#") ? resolved : undefined;
  };
  const scopes = new WeakMap<object, { resource: Record<string, unknown>; base: string; local: string; top: string }>();
  const resourceRoots = new Map<string, Record<string, unknown>>([[rootKey, root]]);
  const ids = new Map<string, Record<string, unknown>>();
  const ambiguousKeys = new Set<string>();
  // Ajv engine: nested IDs and anchors by registry key (Ajv's this.refs, where
  // they are aliases of "<top-level path>#<pointer>"), and anchors of anonymous
  // resources by "<private key>#name" (Ajv's per-root localRefs).
  const ajvAliases = new Map<string, object>();
  const ajvAliasTexts = new Map<string, string>();
  const localAnchors = new Map<string, object>();
  const resourceKey = (address: string) => address.split("#", 1)[0]!;
  const fragment = (address: string) => {
    const hash = address.indexOf("#");
    try { return hash < 0 ? "" : decodeURIComponent(address.slice(hash + 1)); }
    catch { throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Invalid schema reference encoding"); }
  };
  // RFC 3986 resolution, as both engines use (schema-uri.ts); undefined when the
  // URI cannot be parsed.
  const resolveUri = (base: string, reference: string) => {
    try { return schemaUriResolver.resolve(base, reference); }
    catch { return undefined; }
  };
  // Ajv matches and looks up IDs in serialized form (dot segments removed,
  // default ports dropped).
  const ajvPath = (key: string) => {
    try { return resourceKey(schemaUriResolver.serialize(schemaUriResolver.parse(key))); }
    catch { return key; }
  };
  const modernDialect = (schema: object) => {
    const resource = scopes.get(schema)?.resource ?? schema as Record<string, unknown>;
    const dialect = String(resource.$schema ?? root.$schema ?? "draft-07");
    return dialect.includes("2019-09") || dialect.includes("2020-12");
  };
  // Other tools' schemas are indexed only so references can resolve into them.
  // Their unsupported constructs are recorded per node and rejected only when a
  // reference from this schema reaches that node, its subtree or its ancestors.
  const deferred = new WeakMap<object, string>();
  const parents = new WeakMap<object, object>();
  // JSON pointer tokens from a resource root to a node indexed beneath it.
  const pathFromTop = (node: object): string[] => {
    const keys: string[] = [];
    for (let child = node, parent = parents.get(node); parent; child = parent, parent = parents.get(parent)) {
      for (const [key, value] of Object.entries(parent)) {
        if (value === child) { keys.unshift(key); break; }
        const nested = value && typeof value === "object" ? Object.entries(value).find(([, item]) => item === child) : undefined;
        if (nested) { keys.unshift(key, nested[0]); break; }
      }
    }
    return keys;
  };
  // A top-level resource's serialized path: "" for an anonymous one, whose
  // runtime base is "" (each tool is compiled without a key).
  const topPath = (top: string) => privateKeys.has(top) ? "" : ajvPath(top);
  // Ajv's stored alias pointer: escaped tokens, not percent-encoded.
  const pointerText = (node: object) => pathFromTop(node).map(key => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
  // Anonymous siblings by canonical JSON, to find the runtime's "" entry.
  const anonymousSiblings = new Map(siblings.flatMap((sibling, position) => namedSchemaId(sibling) === undefined ? [[canonicalJson(sibling), privateKey(`resource-${position}`)] as const] : []));
  // Ajv (compile/resolve.ts getSchemaRefs) registers a nested ID or anchor under
  // its URI resolved against the enclosing base, or as written when that base
  // is "" (then a "#name" key stays local to its top-level resource).
  const registerAjvKey = (base: string, id: string, node: object, top: string) => {
    const key = (base ? resolveUri(base, id) : id)?.replace(/#$/, "");
    if (key === undefined) return;
    if (key.startsWith("#")) { localAnchors.set(`${top}${key}`, node); return; }
    // Ajv keeps the last registration of a key claimed twice. Registrations with
    // the same alias text (the same pointer in two anonymous tools, or in a tool's
    // input and output) resolve alike; otherwise the target depends on
    // registration order, so references to it are refused.
    const text = `${topPath(top)}#${pointerText(node)}`;
    if ((ajvAliasTexts.has(key) && ajvAliasTexts.get(key) !== text) || (resourceRoots.has(key) && !privateKeys.has(key))) ambiguousKeys.add(key);
    ajvAliases.set(key, node);
    ajvAliasTexts.set(key, text);
  };
  const index = (value: unknown, resource: Record<string, unknown>, parentBase: string, parentLocal: string, strict: boolean, parent?: object, top?: string) => {
    if (!value || typeof value !== "object" || scopes.has(value)) return;
    if (parent) parents.set(value, parent);
    let base = parentBase;
    let local = parentLocal;
    const schemaValue = value as Record<string, unknown>;
    let invalid = false;
    const reject = (message: string) => {
      if (strict) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", message);
      if (!deferred.has(value)) deferred.set(value, message);
      invalid = true;
    };
    // A draft-07 client ignores a $id beside $ref, but Ajv applies its URI
    // scope before resolving the reference. Reject it before indexing either
    // schema so the published catalog cannot describe a different target.
    if (typeof schemaValue.$ref === "string" && !modernDialect(resource)) {
      if (Object.keys(schemaValue).some(key => DRAFT07_REF_UNSAFE_KEYWORDS.has(key) &&
          !(value === root && key === "type" && schemaValue.type === "object"))) {
        reject("Draft-07 $ref assertion siblings are unsupported in projected catalogs");
      }
    }
    // An empty $id names no resource, as at runtime: the schema stays anonymous.
    // So does a top-level "#" or "#/", which Ajv also normalizes to its empty key.
    const authoredId = Array.isArray(value) ? undefined : parent === undefined ? namedSchemaId(schemaValue) :
      typeof schemaValue.$id === "string" && schemaValue.$id !== "" ? schemaValue.$id : undefined;
    // A nested dot-segment $id would rename the anonymous resource it sits in.
    if (!invalid && authoredId !== undefined && value !== resource && !authoredId.startsWith("#") && selfReference(authoredId, parentLocal) !== undefined) {
      reject("Schema resource ID collides with an anonymous schema scope");
    }
    if (!invalid && authoredId !== undefined) {
      let name: string | undefined;
      // Ajv keys a top-level $id by its literal text (less one trailing "#").
      const address = parent === undefined && literalRootIds ? authoredId : resolveUri(parentBase, authoredId);
      if (address === undefined) reject("Invalid schema resource ID");
      else {
        try { name = fragment(address); }
        catch (error) { if (strict) throw error; reject("Invalid schema reference encoding"); }
      }
      if (address !== undefined && name !== undefined) {
        if (name) {
          // Compare in resolved form: a literal base such as "./shared"
          // resolves "#node" to "shared#node", which is still this resource.
          if (!/^[A-Za-z][-A-Za-z0-9.:_]*$/.test(name) || modernDialect(resource) ||
              resourceKey(address) !== resourceKey(resolveUri(parentBase, "") ?? parentBase)) {
            reject("Unsupported schema resource ID fragment");
          } else if (literalRootIds) registerAjvKey(parentBase, authoredId, schemaValue, top ?? local);
          else ids.set(`${local}#${name}`, schemaValue);
        } else if (literalRootIds && parent !== undefined) {
          // A nested resource stays in its top-level resource's Ajv registry
          // entry: it is reached through its alias, never as a resource root.
          registerAjvKey(parentBase, authoredId, schemaValue, top!);
          resource = schemaValue;
          local = resourceKey(address);
        } else if (resourceRoots.has(resourceKey(address)) &&
            canonicalJson(resourceRoots.get(resourceKey(address))) !== canonicalJson(schemaValue)) {
          // A different schema already owns this key under the active
          // validator's identity, which then refuses or cannot register it.
          // Neither may stand in for the other, so references to it are refused.
          ambiguousKeys.add(resourceKey(address));
          reject("Duplicate schema resource ID");
        } else {
          resource = schemaValue;
          local = resourceKey(address);
          if (literalRootIds && ajvAliases.has(local)) ambiguousKeys.add(local);
          resourceRoots.set(local, resource);
        }
        if (!invalid) base = address.replace(/#$/, "");
      }
    }
    if (schemaValue.$dynamicRef !== undefined || schemaValue.$recursiveRef !== undefined) {
      reject("Dynamic and recursive references are not supported in projected catalogs");
    }
    // The top-level resource is the root Ajv compiles a reference in.
    const topLocal = top ?? local;
    const anchor = (name: string) => literalRootIds ? registerAjvKey(base, `#${name}`, schemaValue, topLocal) : ids.set(`${local}#${name}`, schemaValue);
    if (typeof schemaValue.$anchor === "string") anchor(schemaValue.$anchor);
    if (typeof schemaValue.$dynamicAnchor === "string" && String(resource.$schema ?? root.$schema ?? "draft-07").includes("2020-12")) anchor(schemaValue.$dynamicAnchor);
    scopes.set(value, { resource, base, local, top: topLocal });
    for (const [key, child] of Object.entries(value)) {
      mapSchemaKeyword(key, child, item => { index(item, resource, base, local, strict, value, topLocal); return item; }, modernDialect(resource));
    }
  };
  for (const [position, resource] of siblings.entries()) {
    const detached = JSON.parse(JSON.stringify(resource)) as Record<string, unknown>;
    const siblingKey = privateKey(`resource-${position}`);
    resourceRoots.set(siblingKey, detached);
    index(detached, detached, sharedBase, siblingKey, false);
  }
  index(root, root, sharedBase, rootKey, true);
  const assertReachable = (target: unknown): unknown => {
    if (!target || typeof target !== "object") return target;
    for (let node: object | undefined = parents.get(target); node; node = parents.get(node)) {
      const message = deferred.get(node);
      if (message) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", message);
    }
    const pending: object[] = [target];
    const walked = new WeakSet<object>();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (walked.has(node)) continue;
      walked.add(node);
      const message = deferred.get(node);
      if (message) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", message);
      for (const child of Object.values(node)) if (child && typeof child === "object") pending.push(child);
    }
    return target;
  };
  const invalidCatalog = (message: string) => new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", message);
  const walk = (target: unknown, keys: readonly string[]): unknown => {
    for (const key of keys) target = target && typeof target === "object" && Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;
    return target;
  };
  const ajvResource = (key: string) => privateKeys.has(key) ? undefined : resourceRoots.get(key);
  // Ajv (compile/index.ts resolveSchema) resolves "<path>#<fragment>" in the
  // top-level resource being compiled when that resource's serialized path is
  // <path>; otherwise through the registry entry <path>, a resource or an alias.
  // Only a JSON pointer fragment, or none for a whole registry resource, resolves.
  const ajvSchema = (path: string, fragmentText: string | undefined, top: string): unknown => {
    const keys = fragmentText?.startsWith("/") ? fragmentText.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~")) : undefined;
    if (path === topPath(top)) {
      // Each anonymous tool is the runtime registry's "" entry while it compiles.
      return keys ? walk(resourceRoots.get(top), keys) : fragmentText === undefined && privateKeys.has(top) ? resourceRoots.get(top) : undefined;
    }
    if (path === "") {
      // The runtime's "" entry is the last anonymous schema compiled before this
      // root; elsewhere, or when that is unknown, the target is not fixed.
      if (top !== scopes.get(root)?.top || previousAnonymous === undefined) throw invalidCatalog("Ambiguous schema resource ID");
      const previous = previousAnonymous === null ? undefined : anonymousSiblings.get(previousAnonymous);
      return keys && previous !== undefined ? walk(resourceRoots.get(previous), keys) : undefined;
    }
    if (ambiguousKeys.has(path)) throw invalidCatalog("Ambiguous schema resource ID");
    const alias = ajvAliases.get(path);
    const resource = alias ? ajvAlias(alias, top) : ajvResource(path);
    if (keys) return walk(resource, keys);
    return fragmentText === undefined && !alias ? resource : undefined;
  };
  // A nested ID or anchor is an alias of "<owner path>#<pointer>", resolved in
  // the resource being compiled: an owner whose path another resource shares
  // (literal "./shared" beside "shared", or two anonymous tools) yields that
  // resource's node at the same pointer, as Ajv does. Ajv parses the stored
  // alias with the runtime URI resolver and decodes each token, even within the
  // owner itself: an ID under definitions["%41"] names definitions.A, while a
  // stray "%" (as in "100%") stays literal.
  const ajvAlias = (node: object, top: string): unknown => {
    let pointer: string;
    try { pointer = (schemaUriResolver.parse(`#${pointerText(node)}`).fragment ?? "").split("/").map(decodeURIComponent).join("/"); }
    catch { throw invalidCatalog("Invalid schema reference encoding"); }
    return ajvSchema(topPath(scopes.get(node)!.top), pointer, top);
  };
  // Ajv's order (vocabularies/core/ref.ts, compile/index.ts resolveRef): "#"
  // from the compiled root's own base; then an exact registry key (a top-level
  // resource, or a nested ID or anchor alias); then resolveSchema; then the
  // compiled root's local anchors. Anything else is unresolved, as at runtime.
  const ajvTarget = (scope: { base: string; top: string }, reference: string): unknown => {
    if ((reference === "#" || reference === "#/") && scope.base === (privateKeys.has(scope.top) ? sharedBase : scope.top)) return resourceRoots.get(scope.top);
    const address = resolveUri(scope.base, reference.replace(/#$/, ""));
    if (address === undefined) throw invalidCatalog("Invalid schema reference URI");
    if (ambiguousKeys.has(address)) throw invalidCatalog("Ambiguous schema resource ID");
    const alias = ajvAliases.get(address);
    const hash = address.indexOf("#");
    const target = alias ? ajvAlias(alias, scope.top) : ajvResource(address) ??
      ajvSchema(ajvPath(address), hash < 0 ? undefined : fragment(address), scope.top);
    return target ?? localAnchors.get(`${scope.top}${address}`);
  };
  const referenceTarget = (schema: Record<string, unknown>): unknown => {
    const reference = schema.$ref as string;
    const scope = scopes.get(schema) ?? { base: sharedBase, local: rootKey, top: rootKey };
    if (literalRootIds) {
      const target = ajvTarget(scope, reference);
      if (target === undefined) throw invalidCatalog(/#(?!\/|$)/.test(reference) ? "Unresolved named schema anchor" : "Unresolved schema reference");
      return assertReachable(target);
    }
    // The edge runtime resolves every reference against one base. Fragment-only
    // and anonymous self references stay in the current resource.
    const self = reference.startsWith("#") ? reference : selfReference(reference, scope.local);
    const address = self !== undefined ? `${scope.local}${self}` : resolveUri(scope.base, reference);
    if (address === undefined) throw invalidCatalog("Invalid schema reference URI");
    const pointer = fragment(address);
    const key = resourceKey(address);
    if (ambiguousKeys.has(key)) throw invalidCatalog("Ambiguous schema resource ID");
    if (pointer && !pointer.startsWith("/")) {
      const anchored = ids.get(`${key}#${pointer}`);
      if (anchored) return assertReachable(anchored);
      throw invalidCatalog("Unresolved named schema anchor");
    }
    let target: unknown = resourceRoots.get(key);
    if (!target) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Unresolved embedded schema reference");
    for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      target = target && typeof target === "object" && Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;
    }
    if (target === undefined) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Unresolved schema reference");
    return assertReachable(target);
  };
  // Compare referenced schemas as well as pointer strings. Track resource targets
  // rather than fragment text: identical fragments can name different resources.
  const resolveProperty = (value: unknown, refs = new Set<unknown>()): unknown => {
    if (Array.isArray(value)) return value.map(child => resolveProperty(child, refs));
    if (!value || typeof value !== "object") return value;
    const schema = value as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(schema).map(([key, child]) => [key, mapSchemaKeyword(key, child, item => resolveProperty(item, refs), modernDialect(schema))]));
    if (typeof schema.$ref === "string") {
      const target = referenceTarget(schema);
      if (!refs.has(target)) result.$ref = resolveProperty(target, new Set([...refs, target]));
    }
    return result;
  };
  // Sort whole branches, retaining the association between their fields and constraints.
  const branchKey = (value: unknown): string => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return canonicalJson(value);
    const schema = value as Record<string, unknown>;
    const shape: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema)) {
      if (typeof schema.$ref === "string" && !modernDialect(schema) && key !== "$ref") continue;
      if (["title", "description", "$comment", "examples", "$defs", "definitions"].includes(key)) continue;
      if (key === "properties" && child && typeof child === "object") {
        shape[key] = Object.fromEntries(Object.entries(child).filter(([name]) => !owned.has(name)).map(([name, item]) => [name, resolveProperty(item)]));
      } else if (key === "required" && Array.isArray(child)) {
        shape[key] = child.filter(name => !owned.has(name)).sort(compareCodeUnits);
      } else if (key === "allOf" && Array.isArray(child)) {
        shape[key] = child.map(branchKey).sort(compareCodeUnits);
      } else if (key === "$ref") shape[key] = resolveProperty(referenceTarget(schema));
      else shape[key] = child;
    }
    return canonicalJson(shape);
  };
  const visit = (value: unknown, path = "root") => {
    if (typeof value === "boolean") { constraints.add(canonicalJson({ path, booleanSchema: value })); return; }
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    const schema = value as Record<string, unknown>;
    const ignoredRefSiblings = typeof schema.$ref === "string" && !modernDialect(schema);
    if (!ignoredRefSiblings && schema.additionalProperties === false) {
      for (const name of owned) {
        const properties = schema.properties as Record<string, unknown> | undefined;
        const patterns = Object.keys((schema.patternProperties ?? {}) as object);
        if (!Object.hasOwn(properties ?? {}, name) && !patterns.some(pattern => {
          try { return new RegExp(pattern, "u").test(name); }
          catch { throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Invalid patternProperties expression"); }
        })) prohibited.add(name);
      }
    }
    const branchProperties = !ignoredRefSiblings && schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties).filter(name => !owned.has(name)).sort(compareCodeUnits) : [];
    const branchRequired = !ignoredRefSiblings && Array.isArray(schema.required) ? schema.required.filter(name => typeof name === "string" && !owned.has(name)).sort(compareCodeUnits) : [];
    constraints.add(canonicalJson({ path, properties: branchProperties, required: branchRequired }));
    for (const [key, value] of Object.entries(schema)) {
      if (ignoredRefSiblings && key !== "$ref") continue;
      if (["dependencies", "dependentRequired", "dependentSchemas", "if", "then", "else", "anyOf", "oneOf", "not", "const", "enum", "minProperties", "maxProperties", "unevaluatedProperties"].includes(key)) ownershipSensitive = true;
      if (!["properties", "required", "allOf", "$ref", "$defs", "definitions", "title", "description", "$comment", "examples"].includes(key)) {
        constraints.add(canonicalJson({ path, [key]: mapSchemaKeyword(key, value, resolveProperty, modernDialect(schema)) }));
      }
    }
    if (typeof schema.$ref === "string") {
      visit(referenceTarget(schema), `${path}/$ref`);
    }
    if (!ignoredRefSiblings && schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) {
        const resolved = resolveProperty(child);
        if (Object.hasOwn(properties, name) && canonicalJson(properties[name]) !== canonicalJson(resolved)) {
          properties[name] = { allOf: [properties[name], resolved] };
        } else properties[name] = resolved;
      }
    }
    if (!ignoredRefSiblings && Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === "string") required.add(name);
    if (!ignoredRefSiblings && Array.isArray(schema.allOf)) [...schema.allOf].sort((left, right) => compareCodeUnits(branchKey(left), branchKey(right))).forEach((child, index) => visit(child, `${path}/allOf/${index}`));
    seen.delete(value);
  };
  visit(root);
  return { properties, required, constraints: [...constraints].sort(compareCodeUnits), ownershipSensitive, prohibited };
}
