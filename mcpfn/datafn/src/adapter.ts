import {
  getCapabilityFields,
  resolveCapabilities,
  type DatafnFieldSchema,
  type DatafnResourceSchema,
  type DatafnSchema,
} from "@datafn/core";
import {
  McpFnRegistry,
  McpFnValidationError,
  structuredResult,
  type McpFnJsonSchema,
  type McpFnToolDefinition,
} from "@mcpfn/core";

import { ScopeGate, validateNeededScopes } from "./scopes.js";
import type {
  CreateDatafnMcpRegistryOptions,
  DatafnListToolOptions,
  DatafnMcpAdapter,
  DatafnReadToolOptions,
  DatafnResourceExposure,
  DatafnWriteToolOptions,
} from "./types.js";

type Operation = "list" | "get" | "create" | "update" | "delete";

function validateFieldList(label: string, fields: string[]): void {
  if (
    fields.length === 0 ||
    new Set(fields).size !== fields.length ||
    fields.some((field) => typeof field !== "string" || !field)
  ) {
    throw new McpFnValidationError(`${label} must be a non-empty, unique field list`);
  }
}

function validateLimit(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new McpFnValidationError(`${label} must be a positive safe integer`);
  }
}

async function resolveClientId<TMcpContext, TDatafnContext>(
  options: CreateDatafnMcpRegistryOptions<TMcpContext, TDatafnContext>,
  context: TMcpContext,
): Promise<string> {
  const clientId = typeof options.clientId === "string"
    ? options.clientId
    : await options.clientId(context);
  if (typeof clientId !== "string" || !clientId.trim()) {
    throw new McpFnValidationError("DataFn clientId must resolve to a non-empty string");
  }
  return clientId;
}

function safeSegment(value: string): string {
  let segment = "";
  let needsSeparator = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === "_" || character === "." || character === "-";
    if (allowed) {
      if (needsSeparator && segment) segment += "_";
      segment += character;
      needsSeparator = false;
    } else {
      needsSeparator = true;
    }
  }
  let start = 0;
  let end = segment.length;
  while (start < end && segment[start] === "_") start += 1;
  while (end > start && segment[end - 1] === "_") end -= 1;
  return segment.slice(start, end);
}

function resourceDefaults(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
) {
  if (resource.permissions !== undefined || resource.defaultPermissions === false) {
    return undefined;
  }
  return schema.defaultPermissions;
}

function fieldSchema(field: DatafnFieldSchema): McpFnJsonSchema {
  const base: McpFnJsonSchema = (() => {
    switch (field.type) {
      case "number": return { type: "number" };
      case "boolean": return { type: "boolean" };
      case "array": return { type: "array", items: {} };
      case "object": return { type: "object", additionalProperties: true };
      case "json": return { type: ["string", "number", "boolean", "object", "array"] };
      case "date": return { type: ["string", "number"], format: "date-time" };
      case "file": return { type: "string" };
      default: return { type: "string" };
    }
  })();
  if (field.enum) base.enum = field.enum;
  if (field.min !== undefined) base.minimum = field.min;
  if (field.max !== undefined) base.maximum = field.max;
  if (field.minLength !== undefined) base.minLength = field.minLength;
  if (field.maxLength !== undefined) base.maxLength = field.maxLength;
  if (field.pattern !== undefined) base.pattern = field.pattern;
  if (field.nullable) {
    const currentTypes = Array.isArray(base.type) ? base.type : [base.type];
    base.type = [...new Set([...currentTypes, "null"])];
    if (Array.isArray(base.enum) && !base.enum.includes(null)) {
      base.enum = [...base.enum, null];
    }
  }
  return base;
}

function scalarFilterSchema(field: DatafnFieldSchema): McpFnJsonSchema | undefined {
  const schema = fieldSchema(field);
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type])
    .filter((type) => type !== "object" && type !== "array");
  if (!types.some((type) => type !== "null")) return undefined;
  const { items: _items, additionalProperties: _additional, ...rest } = schema;
  return { ...rest, type: types.length === 1 ? types[0] : types };
}

function capabilitiesFor(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
) {
  return getCapabilityFields(
    resolveCapabilities(schema.capabilities as never, resource.capabilities as never) as never,
  );
}

function fieldMaps(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
) {
  const schemaFields = new Map(resource.fields.map((field) => [field.name, field]));
  for (const field of capabilitiesFor(schema, resource)) {
    schemaFields.set(field.name, field as DatafnFieldSchema);
  }
  const defaults = resourceDefaults(schema, resource);
  const readDefault = typeof defaults === "string" ? defaults : defaults?.read;
  const writeDefault = typeof defaults === "string" ? defaults : defaults?.write;
  const defaultFields = ["id", ...resource.fields.map((field) => field.name)];
  const readable = new Set([
    "id",
    ...(resource.permissions?.read?.fields ??
      (readDefault === "allResourceFields" ? defaultFields : [])),
  ]);
  for (const field of capabilitiesFor(schema, resource)) readable.add(field.name);
  const writable = new Set(
    resource.permissions?.write?.fields ??
      (writeDefault === "allResourceFields" ? defaultFields : []),
  );
  return { schemaFields, readable, writable };
}

function validateReadFields(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
  fields: string[],
): void {
  const defaults = resourceDefaults(schema, resource);
  const readDefault = typeof defaults === "string" ? defaults : defaults?.read;
  if (!resource.permissions?.read && readDefault !== "allResourceFields") {
    throw new McpFnValidationError(
      `DataFn resource ${resource.name} has no read policy and cannot be exposed`,
    );
  }
  const { schemaFields, readable } = fieldMaps(schema, resource);
  for (const field of fields) {
    if (field !== "id" && !schemaFields.has(field)) {
      throw new McpFnValidationError(
        `Unknown exposed field ${resource.name}.${field}`,
      );
    }
    if (!readable.has(field)) {
      throw new McpFnValidationError(
        `Field ${resource.name}.${field} is not readable by DataFn policy`,
      );
    }
  }
}

function validateWriteFields(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
  fields: string[],
): void {
  const defaults = resourceDefaults(schema, resource);
  const writeDefault = typeof defaults === "string" ? defaults : defaults?.write;
  if (!resource.permissions?.write && writeDefault !== "allResourceFields") {
    throw new McpFnValidationError(
      `DataFn resource ${resource.name} has no write policy and cannot expose mutations`,
    );
  }
  const { schemaFields, writable } = fieldMaps(schema, resource);
  for (const field of fields) {
    const definition = schemaFields.get(field);
    if (!definition) {
      throw new McpFnValidationError(`Unknown write field ${resource.name}.${field}`);
    }
    if (definition.readonly || !writable.has(field)) {
      throw new McpFnValidationError(
        `Field ${resource.name}.${field} is not writable by DataFn policy`,
      );
    }
  }
}

function operationOptions<T>(value: boolean | T | undefined, enabledByDefault: boolean): T | undefined {
  if (value === false) return undefined;
  if (value === true) return {} as T;
  if (value === undefined) return enabledByDefault ? ({} as T) : undefined;
  return value;
}

function outputSchema() {
  return {
    type: "object" as const,
    properties: {
      resource: { type: "string" },
      operation: { type: "string" },
      result: {},
    },
    required: ["resource", "operation", "result"],
    additionalProperties: false,
  };
}

function defaultName(prefix: string, resource: string, operation: Operation): string {
  return [prefix, safeSegment(resource), operation].filter(Boolean).join("_");
}

function assertUniqueToolNames<TMcpContext>(
  registry: McpFnRegistry<TMcpContext>,
  expose: Record<string, DatafnResourceExposure>,
  prefix: string,
): void {
  const owners = new Map<string, string>();
  for (const resourceName of Object.keys(expose).sort()) {
    const exposure = expose[resourceName]!;
    const operations: Array<[Operation, DatafnReadToolOptions | DatafnWriteToolOptions | undefined]> = [
      ["list", operationOptions<DatafnListToolOptions>(exposure.list, true)],
      ["get", operationOptions<DatafnReadToolOptions>(exposure.get, true)],
      ["create", exposure.create || undefined],
      ["update", exposure.update || undefined],
      ["delete", operationOptions<Omit<DatafnWriteToolOptions, "fields">>(exposure.delete, false)],
    ];
    for (const [operation, config] of operations) {
      if (!config) continue;
      const name = config.name ?? defaultName(prefix, resourceName, operation);
      const owner = `${resourceName}.${operation}`;
      const existing = owners.get(name);
      if (existing || registry.has(name)) {
        throw new McpFnValidationError(
          `DataFn tool name collision for ${name}: ${existing ?? "existing registry tool"} and ${owner}`,
        );
      }
      owners.set(name, owner);
    }
  }
}

/** Locale-independent string order, so tool registration order never varies by host. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Resolves the scopes each exposed resource's read and write tools need,
 * before any tool is registered. Without `sessionScopes` no resource may
 * declare scopes; with it, every enabled operation must.
 */
function resolveResourceScopes<TMcpContext, TDatafnContext>(
  options: CreateDatafnMcpRegistryOptions<TMcpContext, TDatafnContext>,
): Map<string, { read?: string[]; write?: string[] }> {
  const scopes = new Map<string, { read?: string[]; write?: string[] }>();
  if (options.sessionScopes !== undefined && typeof options.sessionScopes !== "function") {
    throw new McpFnValidationError("DataFn sessionScopes must be a function");
  }
  for (const resourceName of Object.keys(options.expose).sort(compareCodeUnits)) {
    const exposure = options.expose[resourceName]!;
    const declared = exposure.scopes;
    if (!options.sessionScopes) {
      if (declared !== undefined) {
        throw new McpFnValidationError(
          `DataFn resource ${resourceName} declares scopes, which need a sessionScopes resolver`,
        );
      }
      continue;
    }
    const reads = Boolean(
      operationOptions<DatafnListToolOptions>(exposure.list, true) ||
      operationOptions<DatafnReadToolOptions>(exposure.get, true),
    );
    const writes = Boolean(
      exposure.create ||
      exposure.update ||
      operationOptions<Omit<DatafnWriteToolOptions, "fields">>(exposure.delete, false),
    );
    const label = `DataFn resource ${resourceName} scopes`;
    const read = reads || declared?.read !== undefined
      ? validateNeededScopes(`${label}.read`, declared?.read)
      : undefined;
    const write = writes || declared?.write !== undefined
      ? validateNeededScopes(`${label}.write`, declared?.write)
      : undefined;
    scopes.set(resourceName, { read, write });
  }
  return scopes;
}

/**
 * Builds the DataFn tools and the scope gate that goes with them. Pass
 * `toolVisibility` to `createMcpFnServer` so tools the session's scopes do
 * not allow are hidden from `tools/list`; their handlers answer
 * `insufficient_scope` whether or not the hook is installed.
 */
export function createDatafnMcpAdapter<TMcpContext, TDatafnContext>(
  options: CreateDatafnMcpRegistryOptions<TMcpContext, TDatafnContext>,
): DatafnMcpAdapter<TMcpContext> {
  const registry = options.registry ?? new McpFnRegistry<TMcpContext>();
  const gate = new ScopeGate<TMcpContext>(options.sessionScopes);
  const register = (
    definition: McpFnToolDefinition<TMcpContext>,
    scopes: readonly string[] | undefined,
  ) => {
    if (!scopes) {
      registry.register(definition);
      return;
    }
    const gated = gate.wrap(definition, scopes);
    registry.register(gated);
    gate.record(gated.name, scopes);
  };
  const schema = options.executor.schema;
  const prefix = safeSegment(options.toolPrefix ?? "datafn");
  if (typeof options.clientId === "string" && !options.clientId.trim()) {
    throw new McpFnValidationError("DataFn clientId must be a non-empty string");
  }
  assertUniqueToolNames(registry, options.expose, prefix);
  const resourceScopes = resolveResourceScopes(options);
  if (
    typeof options.clientId === "string" &&
    options.allowSharedClientId !== true &&
    Object.values(options.expose).some((exposure) => exposure.create || exposure.update || exposure.delete)
  ) {
    throw new McpFnValidationError(
      "DataFn mutation tools need a per-credential clientId resolver; a fixed string shares idempotency records between users (set allowSharedClientId to accept it)",
    );
  }

  // Refuse non-scalar filters before registering any tool, so this check
  // never leaves a supplied registry partly populated. (The registration
  // loop's other validation errors, which predate it, can still stop part-way.)
  for (const [resourceName, exposure] of Object.entries(options.expose)) {
    const list = operationOptions<DatafnListToolOptions>(exposure.list, true);
    const resource = schema.resources.find((candidate) => candidate.name === resourceName);
    if (!list?.filterFields || !resource) continue;
    const schemaFields = fieldMaps(schema, resource).schemaFields;
    for (const field of list.filterFields) {
      const definition = schemaFields.get(field);
      if (field !== "id" && definition && !scalarFilterSchema(definition)) {
        throw new McpFnValidationError(
          `DataFn resource ${resourceName} cannot filter on non-scalar field ${field}`,
        );
      }
    }
  }

  for (const resourceName of Object.keys(options.expose).sort(compareCodeUnits)) {
    const exposure = options.expose[resourceName]!;
    const resource = schema.resources.find((candidate) => candidate.name === resourceName);
    if (!resource) {
      throw new McpFnValidationError(`Unknown DataFn resource: ${resourceName}`);
    }
    const list = operationOptions<DatafnListToolOptions>(exposure.list, true);
    const get = operationOptions<DatafnReadToolOptions>(exposure.get, true);
    validateFieldList(`DataFn resource ${resourceName} projection`, exposure.fields);
    if (list || get) validateReadFields(schema, resource, exposure.fields);
    const maps = fieldMaps(schema, resource);
    const scopes = resourceScopes.get(resourceName);

    if (list) {
      const filterFields = list.filterFields ?? exposure.fields;
      const sortFields = list.sortFields ?? ["id"];
      validateFieldList(`DataFn resource ${resourceName} filterFields`, filterFields);
      validateFieldList(`DataFn resource ${resourceName} sortFields`, sortFields);
      validateReadFields(schema, resource, [...filterFields, ...sortFields]);
      // Filters take scalar values only: DataFn reads an object as an
      // operator expression, which the model should not choose.
      const filterProperties: Record<string, McpFnJsonSchema> = {};
      for (const field of filterFields) {
        const filter = field === "id" ? { type: "string" } : scalarFilterSchema(maps.schemaFields.get(field)!);
        if (filter) filterProperties[field] = filter;
        else if (list.filterFields) {
          throw new McpFnValidationError(
            `DataFn resource ${resourceName} cannot filter on non-scalar field ${field}`,
          );
        }
      }
      const maxLimit = list.maxLimit ?? 100;
      validateLimit(`DataFn resource ${resourceName} maxLimit`, maxLimit);
      const defaultLimit = list.defaultLimit ?? Math.min(50, maxLimit);
      validateLimit(`DataFn resource ${resourceName} defaultLimit`, defaultLimit);
      if (defaultLimit > maxLimit) {
        throw new McpFnValidationError(
          `DataFn resource ${resourceName} defaultLimit cannot exceed maxLimit`,
        );
      }
      const definition: McpFnToolDefinition<TMcpContext> = {
        name: list.name ?? defaultName(prefix, resourceName, "list"),
        description:
          list.description ?? `List ${resourceName} records visible to the authenticated DataFn context.`,
        inputSchema: {
          type: "object",
          properties: {
            filters: {
              type: "object",
              properties: filterProperties,
              additionalProperties: false,
            },
            sort: {
              type: "array",
              items: {
                type: "string",
                enum: sortFields.flatMap((field) => [`${field}:asc`, `${field}:desc`]),
              },
              maxItems: Math.max(1, sortFields.length),
            },
            cursor: { type: "object", additionalProperties: true },
            limit: { type: "integer", minimum: 1, maximum: maxLimit },
          },
          additionalProperties: false,
        },
        outputSchema: outputSchema(),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        metadata: { "mcpfn/datafn": { resource: resourceName, operation: "list" } },
        handler: async (args, context) => {
          const requestedSort = args.sort as string[] | undefined;
          const querySort = requestedSort?.length
            ? [
                ...requestedSort.filter((term) => !term.startsWith("id:")),
                requestedSort.find((term) => term.startsWith("id:")) ?? "id:asc",
              ]
            : undefined;
          const result = await options.executor.query(
            {
              resource: resourceName,
              version: String(resource.version),
              select: exposure.fields,
              ...(args.filters ? { filters: args.filters } : {}),
              ...(querySort ? { sort: querySort } : {}),
              ...(args.cursor ? { cursor: args.cursor } : {}),
              limit: Math.min(Number(args.limit ?? defaultLimit), maxLimit),
            },
            await options.context(context),
          );
          return structuredResult({ resource: resourceName, operation: "list", result });
        },
      };
      register(definition, scopes?.read);
    }

    if (get) {
      register({
        name: get.name ?? defaultName(prefix, resourceName, "get"),
        description: get.description ?? `Get one ${resourceName} record by ID.`,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
        outputSchema: outputSchema(),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        metadata: { "mcpfn/datafn": { resource: resourceName, operation: "get" } },
        handler: async ({ id }, context) => {
          const result = await options.executor.query(
            {
              resource: resourceName,
              version: String(resource.version),
              select: exposure.fields,
              filters: { id },
              limit: 1,
            },
            await options.context(context),
          );
          return structuredResult({ resource: resourceName, operation: "get", result });
        },
      }, scopes?.read);
    }

    const registerWrite = (
      operation: "create" | "update",
      config: DatafnWriteToolOptions,
    ) => {
      validateFieldList(
        `DataFn resource ${resourceName} ${operation} fields`,
        config.fields,
      );
      validateWriteFields(schema, resource, config.fields);
      const requiredCreateFields = [...maps.schemaFields.values()]
        .filter((field) =>
          field.name !== "id" &&
          field.required &&
          field.default === undefined &&
          !field.readonly)
        .map((field) => field.name)
        .sort();
      if (operation === "create") {
        const missingRequiredFields = requiredCreateFields.filter(
          (field) => !config.fields.includes(field),
        );
        if (missingRequiredFields.length) {
          throw new McpFnValidationError(
            `DataFn resource ${resourceName} create fields omit required writable fields: ${missingRequiredFields.join(", ")}`,
          );
        }
      }
      const properties = Object.fromEntries(
        config.fields.map((field) => [field, fieldSchema(maps.schemaFields.get(field)!)]),
      );
      const recordRequired = operation === "create"
        ? requiredCreateFields
        : [];
      register({
        name: config.name ?? defaultName(prefix, resourceName, operation),
        description: config.description ?? `${operation === "create" ? "Create" : "Update"} one ${resourceName} record.`,
        inputSchema: {
          type: "object",
          properties: {
            ...(operation === "create" ? { id: { type: "string", minLength: 1 } } : {}),
            ...(operation === "update" ? { id: { type: "string", minLength: 1 } } : {}),
            mutationId: { type: "string", minLength: 1 },
            record: {
              type: "object",
              properties,
              ...(recordRequired.length ? { required: recordRequired } : {}),
              additionalProperties: false,
            },
          },
          required: ["mutationId", "record", ...(operation === "update" ? ["id"] : [])],
          additionalProperties: false,
        },
        outputSchema: outputSchema(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        metadata: { "mcpfn/datafn": { resource: resourceName, operation } },
        handler: async (args, context) => {
          const clientId = await resolveClientId(options, context);
          const result = await options.executor.mutate(
            {
              resource: resourceName,
              version: String(resource.version),
              operation: operation === "create" ? "insert" : "merge",
              clientId,
              mutationId: args.mutationId,
              ...(args.id ? { id: args.id } : {}),
              record: args.record,
            },
            await options.context(context),
          );
          return structuredResult({ resource: resourceName, operation, result });
        },
      }, scopes?.write);
    };

    if (exposure.create) registerWrite("create", exposure.create);
    if (exposure.update) registerWrite("update", exposure.update);
    const remove = operationOptions<Omit<DatafnWriteToolOptions, "fields">>(
      exposure.delete,
      false,
    );
    if (remove) {
      const config = remove;
      const defaults = resourceDefaults(schema, resource);
      const writeDefault = typeof defaults === "string" ? defaults : defaults?.write;
      if (!resource.permissions?.write && writeDefault !== "allResourceFields") {
        throw new McpFnValidationError(
          `DataFn resource ${resourceName} has no write policy and cannot expose delete`,
        );
      }
      register({
        name: config.name ?? defaultName(prefix, resourceName, "delete"),
        description: config.description ?? `Delete one ${resourceName} record by ID.`,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            mutationId: { type: "string", minLength: 1 },
          },
          required: ["id", "mutationId"],
          additionalProperties: false,
        },
        outputSchema: outputSchema(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        metadata: { "mcpfn/datafn": { resource: resourceName, operation: "delete" } },
        handler: async ({ id, mutationId }, context) => {
          const clientId = await resolveClientId(options, context);
          const result = await options.executor.mutate(
            {
              resource: resourceName,
              version: String(resource.version),
              operation: "delete",
              clientId,
              mutationId,
              id,
            },
            await options.context(context),
          );
          return structuredResult({ resource: resourceName, operation: "delete", result });
        },
      }, scopes?.write);
    }
  }

  const adapter: DatafnMcpAdapter<TMcpContext> = {
    registry,
    toolVisibility: (input) => gate.visible(input),
    registerTool(definition, toolOptions = {}) {
      if (toolOptions.scopes === undefined) {
        register(definition, undefined);
        return adapter;
      }
      if (!gate.enabled) {
        throw new McpFnValidationError(
          `Tool ${String(definition.name)} declares scopes, which need a sessionScopes resolver`,
        );
      }
      register(
        definition,
        validateNeededScopes(`Tool ${String(definition.name)} scopes`, toolOptions.scopes),
      );
      return adapter;
    },
    requiredScopes: (toolName) => gate.requiredScopes(toolName),
  };
  return adapter;
}

/**
 * Builds the DataFn tools into a registry. Scope-gated tools still answer
 * `insufficient_scope` when called without their scopes; use
 * `createDatafnMcpAdapter` for the visibility hook that hides them from
 * `tools/list`.
 */
export function createDatafnMcpRegistry<TMcpContext, TDatafnContext>(
  options: CreateDatafnMcpRegistryOptions<TMcpContext, TDatafnContext>,
): McpFnRegistry<TMcpContext> {
  return createDatafnMcpAdapter(options).registry;
}
