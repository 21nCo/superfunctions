import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  createSchemaCompiler,
  validateSchemaCollection,
  type CompiledSchema,
  type SchemaCompiler,
  type SchemaIssue,
} from "./validation.js";
import { registryInternals } from "./registry-internals.js";
import type {
  CallToolResult,
  CompleteResult,
  CreateTaskResult,
  GetPromptResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { McpFnOutputValidationError, McpFnValidationError } from "./errors.js";
import { compareCodeUnits } from "./canonical.js";
import { formatMcpFnSchemaIssues } from "./validation.js";
import {
  unsupportedUriTemplateOperator,
  uriTemplatesOverlap,
} from "./uri-template.js";
import type {
  McpFnListedTool,
  McpFnObjectSchema,
  McpFnPromptDefinition,
  McpFnRequestExtra,
  McpFnResourceDefinition,
  McpFnResourceTemplateDefinition,
  McpFnTaskRequestExtra,
  McpFnToolLifecycleObserver,
  McpFnToolDefinition,
} from "./types.js";

interface RegisteredTool<TContext> {
  /** The caller's definition, the receiver its handlers are bound to. */
  definition: McpFnToolDefinition<TContext>;
  /**
   * What the registry advertises, validates against and calls: the fields read
   * once at registration, with its schema snapshots and handlers bound to the
   * caller's definition.
   */
  view: McpFnToolDefinition<TContext>;
  validateInput: CompiledSchema;
  validateOutput?: CompiledSchema;
}

interface RegisteredPrompt<TContext> {
  /** The caller's definition, the receiver get() is bound to. */
  definition: McpFnPromptDefinition<TContext>;
  /** What the registry advertises and calls, like RegisteredTool.view. */
  view: McpFnPromptDefinition<TContext>;
  validateArguments: CompiledSchema;
}

/** The deep-frozen schema snapshots one tool registration declares. */
interface ToolSchemas {
  inputSchema: McpFnToolDefinition<unknown>["inputSchema"];
  outputSchema?: NonNullable<McpFnToolDefinition<unknown>["outputSchema"]>;
}

/** The deep-frozen argument snapshots one prompt registration declares. */
interface PromptSchemas {
  arguments?: NonNullable<McpFnPromptDefinition<unknown>["arguments"]>;
  argumentsSchema?: McpFnObjectSchema;
  /** The arguments JSON Schema the registry compiles and advertises. */
  schema: object;
}

/**
 * An accepted schema snapshot and the validator compiled from it. An entry is
 * reused only for the same object: the snapshot itself (registry-issued, as in
 * definitions() and promptDefinitions()) or the caller object it was taken
 * from, while that object's JSON is unchanged. Any other schema, even an equal
 * one, is compiled, so the engine accepts or rejects it exactly as it would a
 * new schema object (a second declaration of a root `$id` fails, as on dev).
 */
interface SchemaEntry {
  snapshot: object;
  validator: CompiledSchema;
  source?: object;
  // For a custom compiler's validator: the `kind:name` of the registration
  // it was compiled for.
  retryKey?: string;
}

const snapshotTexts = new WeakMap<object, string>();

function snapshotText(snapshot: object): string {
  let text = snapshotTexts.get(snapshot);
  if (text === undefined) {
    text = JSON.stringify(snapshot);
    snapshotTexts.set(snapshot, text);
  }
  return text;
}

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const key of Reflect.ownKeys(current)) {
      stack.push((current as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

// The plain-data checks recognise another realm's built-in prototypes by shape,
// not identity: a realm's Object.prototype is the object whose own prototype is
// null, and its Array.prototype is an array whose prototype is that object. A
// subclass, Date, Map, RegExp, typed array or class instance from any realm has
// a different chain and fails. An own Symbol.toStringTag is refused unread, so
// no caller accessor runs while the tag is checked.
function isPlainArray(value: unknown[]): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype === Array.prototype) return true;
  if (prototype === null || !Array.isArray(prototype)) return false;
  const realmObject = Object.getPrototypeOf(prototype) as unknown;
  return realmObject !== null && Object.getPrototypeOf(realmObject) === null;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  if (Object.getOwnPropertyDescriptor(value, Symbol.toStringTag)) return false;
  // The built-in tag catches an exotic object (arguments, or a Date, RegExp or
  // Error whose prototype was reset) that sits directly on Object.prototype.
  return Object.prototype.toString.call(value) === "[object Object]";
}

type CopyJson = (value: unknown, path: string) => unknown;

function copyJsonArray(value: unknown[], path: string, copy: CopyJson): unknown[] {
  if (!isPlainArray(value)) throw new Error(`${path} is not a plain array`);
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) {
      throw new Error(`${path}[${index}] is not JSON data`);
    }
    items.push(copy(descriptor.value, `${path}[${index}]`));
  }
  return items;
}

function copyJsonObject(value: object, path: string, copy: CopyJson): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${path} is not a plain object`);
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!("value" in descriptor)) throw new Error(`${path}.${key} is an accessor`);
    if (descriptor.value === undefined) continue;
    defineField(entries, key, copy(descriptor.value, `${path}.${key}`));
  }
  return entries;
}

/**
 * A deep-frozen copy of caller-owned schema data. Only JSON data is accepted:
 * plain objects (prototype null or any realm's Object.prototype) with data
 * properties, plain arrays (any realm's Array.prototype), strings, finite
 * numbers, booleans and null. Data from another realm (vm, an iframe) is
 * accepted like local data; the snapshot is always built in this realm. An object property whose
 * value is undefined is left out, as JSON.stringify does. Anything else (a
 * Date, Map, RegExp, typed array, class instance, function, accessor, cycle or
 * undefined array item) fails, because a frozen view of it could still change
 * (a Date's time, a Map's entries) while the validator compiled from it could
 * not. The check applies to the root as well. The registry compiles, validates with, advertises and copies only these
 * snapshots, so editing the caller's object after registration changes nothing.
 */
function snapshotJson<T>(value: T, label: string): T {
  // Only an absent optional field skips the check: a function, symbol, bigint
  // or non-finite root fails like the same value nested inside an object.
  if (value === undefined) return value;
  const copies = new Map<object, unknown>();
  const active = new Set<object>();
  const copy = (current: unknown, path: string): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) return current;
      throw new Error(`${path} is not a finite number`);
    }
    if (typeof current !== "object") throw new Error(`${path} is a ${typeof current}`);
    const done = copies.get(current);
    if (done !== undefined) return done;
    if (active.has(current)) throw new Error(`${path} is circular`);
    active.add(current);
    const result = Array.isArray(current)
      ? copyJsonArray(current, path, copy)
      : copyJsonObject(current, path, copy);
    active.delete(current);
    copies.set(current, result);
    return result;
  };
  let snapshot: unknown;
  try {
    snapshot = copy(value, "value");
  } catch (error) {
    throw new McpFnValidationError(`${label} must be JSON data`, {
      cause: isStackOverflow(error) ? "value is nested too deeply" : errorMessage(error),
    });
  }
  return deepFreeze(snapshot as T);
}

function assertTaskSupport(
  tool: McpFnToolDefinition<unknown>,
  execution: McpFnToolDefinition<unknown>["execution"],
): void {
  const taskSupport = execution?.taskSupport ?? "forbidden";
  if (!["forbidden", "optional", "required"].includes(taskSupport)) {
    throw new McpFnValidationError(
      `Tool ${tool.name} has invalid taskSupport=${String(taskSupport)}`,
    );
  }
  if (taskSupport !== "forbidden" && !tool.taskHandler) {
    throw new McpFnValidationError(
      `Tool ${tool.name} declares taskSupport=${taskSupport} but has no taskHandler`,
    );
  }
  if (taskSupport === "forbidden" && tool.taskHandler) {
    throw new McpFnValidationError(
      `Tool ${tool.name} has a taskHandler but forbids task execution`,
    );
  }
}

function assertPromptArgumentList(
  name: string,
  declared: Pick<McpFnPromptDefinition<unknown>, "arguments">,
): void {
  if (
    declared.arguments !== undefined &&
    (!Array.isArray(declared.arguments) ||
      declared.arguments.some(
        (argument) =>
          !argument ||
          typeof argument !== "object" ||
          Array.isArray(argument) ||
          typeof argument.name !== "string",
      ))
  ) {
    throw new McpFnValidationError(`Prompt ${name} arguments must be an array`);
  }
  for (const argument of declared.arguments ?? []) {
    assertName("prompt argument", argument.name);
    if (argument.description !== undefined && typeof argument.description !== "string") {
      throw new McpFnValidationError(
        `Prompt ${name} argument ${argument.name} description must be a string`,
      );
    }
    if (argument.required !== undefined && typeof argument.required !== "boolean") {
      throw new McpFnValidationError(
        `Prompt ${name} argument ${argument.name} required must be a boolean`,
      );
    }
  }
}

function assertPromptArgumentsAgree(
  name: string,
  declared: Pick<McpFnPromptDefinition<unknown>, "arguments" | "argumentsSchema">,
): void {
  if (!declared.arguments || !declared.argumentsSchema) return;
  const listed = declared.arguments
    .map(({ name: argument, required }) => ({ name: argument, required: required === true }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const schemaDeclared = schemaPromptArguments(declared)!.map(
    ({ name: argument, required }) => ({ name: argument, required: required === true }),
  );
  if (JSON.stringify(listed) !== JSON.stringify(schemaDeclared)) {
    throw new McpFnValidationError(`Prompt ${name} arguments and argumentsSchema disagree`);
  }
}

/**
 * Why the built-in engine's schema collection does not resolve on its own, or
 * undefined. A registry with a custom compileSchema has no such check: the
 * compiler accepted every schema in the collection, and its acceptance is the
 * proof that the schema's references resolve.
 */
function collectionError(schemas: object[]): unknown {
  try {
    validateSchemaCollection(schemas);
    return undefined;
  } catch (error) {
    return error ?? new Error("schema collection is invalid");
  }
}

/**
 * Validators a custom compiler returned to registrations that did not stay
 * registered, by `kind:name`. Such a compiler may hold state the registry
 * cannot roll back (an Ajv instance keeps each compiled `$id`), so the retry
 * of that registration takes each parked validator once for an equal schema.
 * A registration that fails parks its compiles on its registry. A server
 * declaration that fails parks its copy's compiles on the declared registry,
 * for the next declaration over that registry only. Any other registration,
 * a sibling copy and an independent registry reach the compiler.
 */
type ParkedCompiles = Map<string, SchemaEntry[]>;

/** JSON value equality that tells 0 from -0, unlike comparing JSON text. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) =>
    Object.hasOwn(right, key) && sameJson((left as Record<string, unknown>)[key], rightRecord[key]));
}

/** A registry-issued tool or prompt view and the caller definition behind it. */
interface DefinitionRecord {
  kind: "tool" | "prompt";
  /** The caller's definition: the only receiver for handlers and get(). */
  definition: object;
  /** The schema snapshots the view advertises. */
  schemas: ToolSchemas | PromptSchemas;
}

// Every view any registry issued, so registering a view again (a clone, or the
// upstream replay of definitions() into cloneEmpty()) uses the record it came
// from instead of re-reading the view as a new caller definition. A view is
// frozen data, so the mapping holds for every registry.
const viewRecords = new WeakMap<object, DefinitionRecord>();

const TOOL_FIELDS = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "execution",
  "icons",
  "metadata",
  "handler",
  "taskHandler",
  "handleInvalidArguments",
] as const;

const PROMPT_FIELDS = [
  "name",
  "title",
  "description",
  "arguments",
  "argumentsSchema",
  "icons",
  "metadata",
  "get",
  "complete",
] as const;

// Methods called with the caller definition as `this`, so a view's copy works
// when called directly (a class method using private fields, for example).
const BOUND_FIELDS = new Set<PropertyKey>(["handler", "handleInvalidArguments", "get"]);

/** Define an own enumerable data property, even for a key such as __proto__. */
function defineField(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Read a caller definition once, through the caller as receiver: its own
 * enumerable fields and every known definition field (own or inherited, such
 * as a class getter). Every check and the view use only these values, so no
 * later read, and no code on the caller's prototype, can change them.
 */
function readDefinition(
  definition: object,
  known: readonly string[],
): Record<PropertyKey, unknown> {
  const source = definition as Record<PropertyKey, unknown>;
  const fields: Record<PropertyKey, unknown> = {};
  const keys: PropertyKey[] = Reflect.ownKeys(definition).filter(key =>
    Object.prototype.propertyIsEnumerable.call(definition, key));
  for (const key of known) if (!keys.includes(key)) keys.push(key);
  for (const key of keys) {
    const value = source[key];
    if (value === undefined && !Object.hasOwn(definition, key)) continue;
    defineField(fields, key, captureField(definition, key, value));
  }
  return fields;
}

/**
 * The value a view keeps for one definition field. Methods are bound to the
 * caller definition. The nested handler tables (taskHandler, complete) are
 * read once into frozen copies whose functions stay bound to the caller's
 * table, so adding, replacing or removing a nested handler after
 * registration changes neither execution, completion nor clone().
 */
function captureField(definition: object, key: PropertyKey, value: unknown): unknown {
  if (key === "taskHandler" && isObject(value)) {
    const createTask = (value as { createTask?: unknown }).createTask;
    return Object.freeze(createTask === undefined ? {} : {
      createTask: typeof createTask === "function" ? createTask.bind(value) : createTask,
    });
  }
  if (key === "complete" && isObject(value)) {
    // Every own string key, keeping its enumerability: registration checks the
    // enumerable names and dispatch any own name, exactly as on the caller's table.
    const table: Record<string, unknown> = {};
    for (const name of Object.getOwnPropertyNames(value)) {
      const handler = (value as Record<string, unknown>)[name];
      Object.defineProperty(table, name, {
        value: typeof handler === "function" ? handler.bind(value) : handler,
        enumerable: Object.prototype.propertyIsEnumerable.call(value, name),
      });
    }
    return Object.freeze(table);
  }
  if (typeof value === "function" && BOUND_FIELDS.has(key)) return value.bind(definition);
  return value;
}

/**
 * The frozen view the registry advertises: a plain object whose every field is
 * an own data property (the read fields, with each schema field holding the
 * registry's snapshot or undefined), so listing it runs no caller code.
 */
function issueView<T>(
  fields: Record<PropertyKey, unknown>,
  snapshots: Record<string, unknown>,
  record: DefinitionRecord,
): T {
  const view: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(fields)) defineField(view, key, fields[key]);
  for (const key of Object.keys(snapshots)) defineField(view, key, snapshots[key]);
  Object.freeze(view);
  viewRecords.set(view, record);
  return view as T;
}

/** One failure reported by a {@link McpFnSchemaValidator}. */
export interface McpFnSchemaValidationIssue {
  instancePath?: string;
  message?: string;
  keyword: string;
}

/**
 * A validator returned by a {@link McpFnSchemaCompiler}. Like an Ajv validate
 * function, it returns whether `data` is valid and, on failure, sets `errors`.
 */
export interface McpFnSchemaValidator {
  (data: unknown): boolean;
  errors?: readonly McpFnSchemaValidationIssue[] | null;
}

/** Compile a JSON Schema into a validator; throw when the schema is invalid. */
export type McpFnSchemaCompiler = (schema: object) => McpFnSchemaValidator;

export interface McpFnRegistryOptions {
  /**
   * Replace the built-in schema engine (Ajv, or @cfworker/json-schema where
   * code generation is unavailable). Clones of this registry, including the
   * copy a server declaration makes, keep using it. The compiler decides the
   * dialect, schema syntax, reference resolution and `$id` uniqueness: each
   * registration of a schema reaches it, except the retry of a registration
   * that failed on this registry, or of a server declaration that failed over
   * it (the same tool or prompt name), which reuses that attempt's validators
   * for equal schemas. The compiler's acceptance is the
   * only self-containment check: the registry, its clones and a server
   * declaration's copy list whatever it accepted.
   */
  compileSchema?: McpFnSchemaCompiler;
}

const MAX_CUSTOM_SCHEMA_ISSUES = 100;

function customSchemaIssue(error: unknown): SchemaIssue {
  const issue = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  return {
    instancePath: typeof issue.instancePath === "string" ? issue.instancePath : "",
    message: typeof issue.message === "string" ? issue.message : undefined,
    keyword: typeof issue.keyword === "string" ? issue.keyword : "schema",
  };
}

function customSchemaIssues(errors: unknown): SchemaIssue[] {
  const issues = Array.isArray(errors)
    ? errors.slice(0, MAX_CUSTOM_SCHEMA_ISSUES).map(customSchemaIssue)
    : [];
  // A rejection must always carry a diagnostic, even from a terse validator.
  return issues.length > 0
    ? issues
    : [{ instancePath: "", message: "Schema validation failed", keyword: "schema" }];
}

function isThenable(value: unknown): boolean {
  try {
    return (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function"
    );
  } catch {
    // A throwing `then` getter is not a usable synchronous result either.
    return true;
  }
}

const ignore = (): undefined => undefined;

/**
 * Mark a genuine native promise's rejection as handled, whichever realm created
 * it (a vm-context promise fails `instanceof Promise`). The intrinsic
 * Promise.prototype.then brand-checks its receiver before running any code, so
 * any other thenable (including a Proxy around a promise) throws a TypeError
 * here and its own then() is never called: foreign then() code could create a
 * new rejected promise on every call, so the registry only fails closed on it.
 *
 * Limit: the intrinsic then() reads the promise's `constructor` (and its
 * Symbol.species) before it attaches a reaction. A promise whose constructor or
 * species getter throws therefore cannot be marked handled by any JavaScript
 * code; the registry still fails closed on it with the same diagnostic.
 */
function attachIgnore(value: object): void {
  void Promise.prototype.then.call(value, undefined, ignore);
}

function ignoreRejection(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  try {
    attachIgnore(value);
  } catch {
    // Not a native promise of any realm: nothing of ours can reject unhandled.
  }
}

function adaptSchemaCompiler(
  compileSchema: McpFnSchemaCompiler,
): (schema: object) => CompiledSchema {
  return (schema) => {
    const validate: unknown = compileSchema(schema);
    if (typeof validate !== "function") {
      ignoreRejection(validate);
      throw new TypeError("compileSchema must return a validator function");
    }
    const validator = validate as McpFnSchemaValidator;
    const compiled = ((data: unknown): boolean => {
      const result: unknown = validator(data);
      // Fail closed: only an explicit `true` accepts the value. Any other
      // result goes to the intrinsic then() once, whatever its own `then`
      // property says (a genuine promise can shadow it), so no promise of any
      // realm or supported subclass is left to reject unhandled.
      if (result !== true) ignoreRejection(result);
      if (isThenable(result)) {
        // A validator must answer synchronously.
        compiled.errors = [{
          instancePath: "",
          message: "compileSchema validators must be synchronous",
          keyword: "schema",
        }];
        return false;
      }
      const valid = result === true;
      compiled.errors = valid ? null : customSchemaIssues(validator.errors);
      return valid;
    }) as CompiledSchema;
    compiled.errors = null;
    return compiled;
  };
}

interface RegisteredTemplate<TContext> {
  definition: McpFnResourceTemplateDefinition<TContext>;
  template: UriTemplate;
}

type ResourceMatch<TContext> =
  | { kind: "resource"; definition: McpFnResourceDefinition<TContext> }
  | {
      kind: "template";
      definition: McpFnResourceTemplateDefinition<TContext>;
      variables: Record<string, string | string[]>;
    };

function assertName(kind: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new McpFnValidationError(
      `Invalid MCP ${kind} name ${JSON.stringify(name)}`,
    );
  }
}

function assertSubscriptionCallbacks(
  kind: "Resource" | "Resource template",
  name: string,
  subscribe: unknown,
  unsubscribe: unknown,
): void {
  if (
    (subscribe === undefined) !== (unsubscribe === undefined) ||
    (subscribe !== undefined && typeof subscribe !== "function") ||
    (unsubscribe !== undefined && typeof unsubscribe !== "function")
  ) {
    throw new McpFnValidationError(
      `${kind} ${name} must define subscribe and unsubscribe together as functions`,
    );
  }
}

function assertUri(kind: string, uri: string): void {
  try {
    new URL(uri);
  } catch {
    throw new McpFnValidationError(
      `Invalid MCP ${kind} URI ${JSON.stringify(uri)}`,
    );
  }
}

interface PromptSchemaInventory {
  descriptions: Map<string, string>;
  propertySchemas: Map<string, unknown[]>;
  required: Set<string>;
}

function mergePromptSchemaInventory(
  target: PromptSchemaInventory,
  source: PromptSchemaInventory,
): void {
  for (const [name, description] of source.descriptions) {
    if (!target.descriptions.has(name))
      target.descriptions.set(name, description);
  }
  for (const [name, schemas] of source.propertySchemas) {
    target.propertySchemas.set(name, [
      ...(target.propertySchemas.get(name) ?? []),
      ...schemas,
    ]);
  }
  for (const name of source.required) target.required.add(name);
}

function resolveLocalSchemaReference(
  root: McpFnObjectSchema,
  reference: string,
): unknown {
  if (!reference.startsWith("#")) return undefined;
  // A URI fragment holds a percent-encoded JSON Pointer: decode the fragment
  // first, then split it and unescape ~1 and ~0 in each token.
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object" || Array.isArray(current))
        return undefined;
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      return (current as Record<string, unknown>)[key];
    }, root);
}

function derivePromptSchemaInventory(
  schema: unknown,
  root: McpFnObjectSchema,
  references = new Set<string>(),
): PromptSchemaInventory | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return undefined;
  const value = schema as Record<string, unknown>;
  const nonFlatKeywords = [
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "patternProperties",
    "dependentSchemas",
    "propertyNames",
  ];
  if (nonFlatKeywords.some((keyword) => Object.hasOwn(value, keyword)))
    return undefined;
  const inventory: PromptSchemaInventory = {
    descriptions: new Map(),
    propertySchemas: new Map(),
    required: new Set(),
  };
  if (value.$ref !== undefined) {
    if (typeof value.$ref !== "string" || references.has(value.$ref))
      return undefined;
    const referenced = resolveLocalSchemaReference(root, value.$ref);
    if (!referenced) return undefined;
    const nextReferences = new Set(references).add(value.$ref);
    const referencedInventory = derivePromptSchemaInventory(
      referenced,
      root,
      nextReferences,
    );
    if (!referencedInventory) return undefined;
    mergePromptSchemaInventory(inventory, referencedInventory);
  }
  if (value.allOf !== undefined) {
    if (!Array.isArray(value.allOf)) return undefined;
    for (const member of value.allOf) {
      const memberInventory = derivePromptSchemaInventory(
        member,
        root,
        references,
      );
      if (!memberInventory) return undefined;
      mergePromptSchemaInventory(inventory, memberInventory);
    }
  }
  const properties = value.properties;
  if (
    properties !== undefined &&
    (typeof properties !== "object" ||
      properties === null ||
      Array.isArray(properties))
  )
    return undefined;
  if (value.required !== undefined && !Array.isArray(value.required))
    return undefined;
  const required = Array.isArray(value.required)
    ? value.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  for (const name of required) inventory.required.add(name);
  const propertySchemas = (properties ?? {}) as Record<string, unknown>;
  for (const [name, propertySchema] of Object.entries(propertySchemas)) {
    inventory.propertySchemas.set(name, [
      ...(inventory.propertySchemas.get(name) ?? []),
      propertySchema,
    ]);
    if (
      propertySchema &&
      typeof propertySchema === "object" &&
      !Array.isArray(propertySchema) &&
      typeof (propertySchema as { description?: unknown }).description ===
        "string"
    ) {
      inventory.descriptions.set(
        name,
        (propertySchema as { description: string }).description,
      );
    }
  }
  return inventory;
}

function intersectStringCandidates(
  left: Set<string> | undefined,
  right: Set<string> | undefined,
): Set<string> | undefined {
  if (!left) return right;
  if (!right) return left;
  return new Set([...left].filter((candidate) => right.has(candidate)));
}

function finiteStringCandidates(
  schema: unknown,
  root: McpFnObjectSchema,
  references = new Set<string>(),
): Set<string> | undefined {
  if (typeof schema === "boolean") return schema ? undefined : new Set();
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return new Set();
  const value = schema as Record<string, unknown>;
  let candidates: Set<string> | undefined;
  if (typeof value.type === "string" && value.type !== "string")
    return new Set();
  if (Array.isArray(value.type) && !value.type.includes("string"))
    return new Set();
  if (Object.hasOwn(value, "const")) {
    candidates =
      typeof value.const === "string" ? new Set([value.const]) : new Set();
  }
  if (Array.isArray(value.enum)) {
    candidates = intersectStringCandidates(
      candidates,
      new Set(
        value.enum.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      ),
    );
  }
  if (value.$ref !== undefined) {
    if (typeof value.$ref !== "string" || references.has(value.$ref))
      return new Set();
    const referenced = resolveLocalSchemaReference(root, value.$ref);
    if (!referenced) return new Set();
    candidates = intersectStringCandidates(
      candidates,
      finiteStringCandidates(
        referenced,
        root,
        new Set(references).add(value.$ref),
      ),
    );
  }
  if (Array.isArray(value.allOf)) {
    for (const member of value.allOf) {
      candidates = intersectStringCandidates(
        candidates,
        finiteStringCandidates(member, root, references),
      );
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(value[keyword])) continue;
    let union: Set<string> | undefined = new Set();
    for (const member of value[keyword]) {
      const memberCandidates = finiteStringCandidates(member, root, references);
      if (!memberCandidates) {
        union = undefined;
        break;
      }
      for (const candidate of memberCandidates) union.add(candidate);
    }
    candidates = intersectStringCandidates(candidates, union);
  }
  return candidates;
}

function schemaMayAcceptString(
  schema: unknown,
  root: McpFnObjectSchema,
  references = new Set<string>(),
): boolean {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return false;
  const value = schema as Record<string, unknown>;
  const finiteCandidates = finiteStringCandidates(schema, root, references);
  if (finiteCandidates?.size === 0) return false;
  if (value.$ref !== undefined) {
    if (typeof value.$ref !== "string" || references.has(value.$ref))
      return false;
    const referenced = resolveLocalSchemaReference(root, value.$ref);
    if (!referenced) return false;
    const nextReferences = new Set(references).add(value.$ref);
    if (!schemaMayAcceptString(referenced, root, nextReferences)) return false;
  }
  if (typeof value.type === "string" && value.type !== "string") return false;
  if (Array.isArray(value.type) && !value.type.includes("string")) return false;
  if (Object.hasOwn(value, "const") && typeof value.const !== "string")
    return false;
  if (
    Array.isArray(value.enum) &&
    !value.enum.some((entry) => typeof entry === "string")
  ) {
    return false;
  }
  if (
    Array.isArray(value.allOf) &&
    !value.allOf.every((member) =>
      schemaMayAcceptString(member, root, references),
    )
  )
    return false;
  if (
    Array.isArray(value.anyOf) &&
    !value.anyOf.some((member) =>
      schemaMayAcceptString(member, root, references),
    )
  )
    return false;
  if (
    Array.isArray(value.oneOf) &&
    !value.oneOf.some((member) =>
      schemaMayAcceptString(member, root, references),
    )
  )
    return false;
  return true;
}

export function assertPromptSchemaSupportsStringValues(
  schema: McpFnObjectSchema,
  label: string,
): void {
  const inventory = derivePromptSchemaInventory(schema, schema);
  if (!inventory) {
    throw new McpFnValidationError(
      `${label} must use derivable properties, allOf, or local $ref declarations`,
    );
  }
  for (const [name, schemas] of inventory.propertySchemas) {
    const finiteCandidates = finiteStringCandidates({ allOf: schemas }, schema);
    let hasStringWitness = schemas.every((propertySchema) =>
      schemaMayAcceptString(propertySchema, schema),
    );
    if (hasStringWitness && finiteCandidates) {
      const candidateSchema = {
        ...(schema.$defs && typeof schema.$defs === "object"
          ? { $defs: schema.$defs }
          : {}),
        ...(schema.definitions && typeof schema.definitions === "object"
          ? { definitions: schema.definitions }
          : {}),
        allOf: schemas,
      };
      let validate: CompiledSchema | undefined;
      try {
        validate = createSchemaCompiler().compile(candidateSchema);
      } catch {
        hasStringWitness = false;
      }
      if (validate) {
        hasStringWitness = [...finiteCandidates].some((candidate) =>
          validate!(candidate),
        );
      }
    }
    if (!hasStringWitness) {
      throw new McpFnValidationError(
        `${label} argument ${name} must accept string values`,
      );
    }
  }
}

export function schemaPromptArguments(definition: {
  argumentsSchema?: McpFnObjectSchema;
}) {
  const schema = definition.argumentsSchema;
  if (!schema) return undefined;
  const inventory = derivePromptSchemaInventory(schema, schema);
  if (!inventory) return undefined;
  const names = [
    ...new Set([...inventory.propertySchemas.keys(), ...inventory.required]),
  ].sort(compareCodeUnits);
  return names.map((name) => {
    return {
      name,
      ...(inventory.descriptions.has(name)
        ? { description: inventory.descriptions.get(name)! }
        : {}),
      ...(inventory.required.has(name) ? { required: true } : {}),
    };
  });
}

function promptSchema<TContext>(
  definition: Pick<McpFnPromptDefinition<TContext>, "arguments" | "argumentsSchema">,
) {
  if (definition.argumentsSchema) return definition.argumentsSchema;
  const properties = Object.fromEntries(
    (definition.arguments ?? []).map((argument) => [
      argument.name,
      {
        type: "string",
        ...(argument.description ? { description: argument.description } : {}),
      },
    ]),
  );
  return {
    type: "object" as const,
    properties,
    required: (definition.arguments ?? [])
      .filter((argument) => argument.required)
      .map((argument) => argument.name),
    additionalProperties: false,
  };
}

export function promptArguments<TContext>(
  definition: Pick<McpFnPromptDefinition<TContext>, "arguments" | "argumentsSchema">,
) {
  return Array.isArray(definition.arguments)
    ? definition.arguments
    : schemaPromptArguments(definition);
}

/** Most values (objects, arrays and scalars together) one tool call may carry. */
const MAX_ARGUMENT_NODES = 100_000;

function exceedsJsonNodes(value: unknown, limit: number): boolean {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    count += 1;
    if (count > limit) return true;
    if (Array.isArray(current)) {
      if (count + stack.length + current.length > limit) return true;
      for (const item of current) stack.push(item);
    } else if (current && typeof current === "object") {
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        if (count + stack.length + 1 > limit) return true;
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
  }
  return false;
}

export class McpFnRegistry<TContext = undefined> {
  private readonly options: McpFnRegistryOptions;
  private readonly customCompile: ((schema: object) => CompiledSchema) | undefined;
  // The built-in engine. Its state is exactly the accepted snapshots in
  // `entries`, in order: a failed registration replaces it (no residue).
  private builtIn: SchemaCompiler | undefined;
  private readonly registrations: Array<(target: McpFnRegistry<TContext>) => void> = [];
  private readonly schemas: object[] = [];
  // Accepted schema entries (inherited and own), in compile order.
  private readonly entries: SchemaEntry[] = [];
  // Accepted entries by snapshot and by the caller object they were taken from.
  private readonly issued = new WeakMap<object, SchemaEntry>();
  private readonly sources = new WeakMap<object, SchemaEntry>();
  // Entries compiled by the registration in progress, committed on success.
  private pending: SchemaEntry[] | undefined;
  // A registry derived from a registry whose collection was closed (or from
  // one that was itself gated) never exposes an unclosed collection.
  private requireClosed = false;
  private closure: { count: number; error: unknown } | undefined;
  // Set for the whole of one registration, so nothing the registration runs
  // (a compiler, a schema or definition getter) can register on this registry
  // in the middle of it.
  private registering = false;
  private compileAttempts = 0;
  // The custom compiler's parked validators for retries on this registry,
  // and for declarations over it (see ParkedCompiles); how many entries this
  // registry inherited; the `kind:name` of the registration in progress.
  private parked: ParkedCompiles = new Map();
  private declarationParked: ParkedCompiles | undefined;
  private inherited = 0;
  private retryKey: string | undefined;

  static {
    registryInternals.declarationCopy = (registry) => {
      const copy = registry.clone();
      copy.parked = registry.declarationParked ??= new Map();
      return copy;
    };
    registryInternals.abandonCopy = (registry) => {
      if (registry instanceof McpFnRegistry) registry.abandon();
    };
  }

  /** Park the validators this copy compiled itself, for a retry to reuse. */
  private abandon(): void {
    for (const entry of this.entries.slice(this.inherited)) this.park(entry);
    this.inherited = this.entries.length;
  }

  private park({ snapshot, validator, retryKey }: SchemaEntry): void {
    if (retryKey === undefined) return;
    const parked = this.parked.get(retryKey);
    if (parked) parked.push({ snapshot, validator, retryKey });
    else this.parked.set(retryKey, [{ snapshot, validator, retryKey }]);
  }

  /**
   * Clone in successful registration order, preserving cross-definition
   * references. Each successful tool or prompt registration is replayed from
   * its record: the frozen view the source advertises (fields read once at
   * registration, schema snapshots) and the caller definition its handlers are
   * bound to. No caller code runs, so the clone advertises exactly the source's
   * contract. A built-in compiler is a fresh instance holding the source's
   * accepted snapshots; a custom `compileSchema` is shared as-is and is not
   * called again for them (the clone reuses the source validators).
   */
  clone(): McpFnRegistry<TContext> {
    this.assertClosed();
    const target = this.derive();
    for (const register of this.registrations) register(target);
    return target;
  }

  /**
   * An empty registry with this registry's options and no definitions. A
   * view from definitions() or promptDefinitions() registered on it keeps its
   * record (the same fields and handler receiver). It
   * inherits the schemas this registry accepted so far (not later ones):
   * registering the same schema object again (a snapshot from definitions()
   * or promptDefinitions(), or the unchanged caller object), in any order,
   * reuses the source snapshot and validator without compiling, so a `$ref`
   * resolves whichever kind or name order the copy registers in. A built-in
   * engine holds the inherited snapshots, so any other schema is accepted or
   * rejected exactly as the source would. When this registry's schema
   * collection is self-contained (or this registry is itself such a copy), the
   * copy's listings and clones throw unless its own collection is
   * self-contained too, so its manifest stays valid on its own.
   */
  cloneEmpty(): McpFnRegistry<TContext> {
    return this.derive();
  }

  /** Registered schema resources for catalog projections, including hidden tools and prompts. */
  schemaDefinitions(): object[] {
    this.assertClosed();
    return [...this.schemas];
  }

  private derive(): McpFnRegistry<TContext> {
    const target = new McpFnRegistry<TContext>(this.options);
    target.requireClosed = this.requireClosed || this.closureError() === undefined;
    for (const entry of this.entries) {
      let validator = entry.validator;
      if (target.builtIn) {
        try {
          validator = target.builtIn.compile(entry.snapshot);
        } catch (error) {
          throw new McpFnValidationError("Registry schema replay failed", {
            cause: errorMessage(error),
          });
        }
      }
      target.accept({ ...entry, validator });
    }
    target.inherited = target.entries.length;
    return target;
  }

  private accept(entry: SchemaEntry): void {
    this.entries.push(entry);
    this.issued.set(entry.snapshot, entry);
    if (entry.source) this.sources.set(entry.source, entry);
  }

  /**
   * Whether this registry's schema collection resolves on its own. A custom
   * compileSchema already accepted each schema, so its collection does.
   */
  private closureError(): unknown {
    if (this.customCompile) return undefined;
    if (this.closure?.count !== this.registrations.length) {
      let error: unknown;
      try {
        error = collectionError([...new Set(this.schemas)]);
      } catch (error_) {
        error = error_ ?? new Error("schema collection is invalid");
      }
      this.closure = { count: this.registrations.length, error };
    }
    return this.closure.error;
  }

  private assertClosed(): void {
    if (!this.requireClosed) return;
    const error = this.closureError();
    if (error !== undefined) {
      throw new McpFnValidationError(
        "Registry schema collection is not self-contained",
        { cause: errorMessage(error) },
      );
    }
  }

  /** The snapshot for a caller schema value: a registry-issued snapshot as-is. */
  private snapshotOf<T>(value: T, label: string): T {
    return isObject(value) && this.issued.has(value) ? value : snapshotJson(value, label);
  }

  /**
   * The entry for a schema snapshot taken from `source`: the entry for the
   * same snapshot object, or for the same caller object while its JSON is
   * unchanged (accepted, or earlier in this registration). Otherwise the
   * snapshot is compiled and stays pending until the registration succeeds.
   */
  private entryFor(snapshot: object, source: unknown): SchemaEntry {
    const pending = this.pending ?? [];
    const same = this.issued.get(snapshot) ?? pending.find(entry => entry.snapshot === snapshot);
    if (same) return same;
    if (isObject(source)) {
      const known = this.sources.get(source) ??
        pending.find(entry => entry.source === source);
      if (known && snapshotText(known.snapshot) === snapshotText(snapshot)) return known;
    }
    const retryKey = this.customCompile ? this.retryKey : undefined;
    const entry: SchemaEntry = {
      snapshot,
      validator: this.compile(snapshot, retryKey),
      ...(isObject(source) && source !== snapshot ? { source } : {}),
      ...(retryKey === undefined ? {} : { retryKey }),
    };
    pending.push(entry);
    return entry;
  }

  private compile(schema: object, retryKey: string | undefined): CompiledSchema {
    this.compileAttempts += 1;
    if (!this.customCompile) return this.builtIn!.compile(schema);
    // Only the retry of a registration that did not stay registered reuses
    // its validator; any other registration meets the compiler's own rules.
    const parked = retryKey === undefined ? undefined : this.parked.get(retryKey);
    const retried = parked?.findIndex((entry) => sameJson(entry.snapshot, schema)) ?? -1;
    if (retried < 0) return this.customCompile(schema);
    const [entry] = parked!.splice(retried, 1);
    if (parked!.length === 0) this.parked.delete(retryKey!);
    return entry.validator;
  }

  /** Run one registration body with nested registration on this registry refused. */
  private exclusive<T>(kind: string, body: () => T): T {
    if (this.registering) {
      throw new McpFnValidationError(
        `Cannot register an MCP ${kind} while this registry is registering another definition`,
      );
    }
    this.registering = true;
    try {
      return body();
    } finally {
      this.registering = false;
    }
  }

  /**
   * Run one registration: commit the schemas it compiled only when it
   * succeeds. When it fails after the built-in engine ran, replace the engine
   * with a fresh one that holds exactly the accepted snapshots, in order.
   */
  private transact(kind: string, body: () => void): this {
    return this.exclusive(kind, () => {
      const attempts = this.compileAttempts;
      const pending: SchemaEntry[] = [];
      this.pending = pending;
      try {
        body();
      } catch (error) {
        if (this.builtIn && this.compileAttempts !== attempts) this.resetBuiltIn();
        for (const entry of pending) this.park(entry);
        throw error;
      } finally {
        this.pending = undefined;
        this.retryKey = undefined;
      }
      for (const entry of pending) this.accept(entry);
      return this;
    });
  }

  private resetBuiltIn(): void {
    const compiler = createSchemaCompiler();
    try {
      for (const { snapshot } of this.entries) compiler.compile(snapshot);
    } catch (error) {
      throw new McpFnValidationError("Registry schema replay failed", {
        cause: errorMessage(error),
      });
    }
    this.builtIn = compiler;
  }

  private readonly tools = new Map<string, RegisteredTool<TContext>>();
  private readonly resources = new Map<
    string,
    McpFnResourceDefinition<TContext>
  >();
  private readonly resourceTemplates = new Map<
    string,
    RegisteredTemplate<TContext>
  >();
  private readonly prompts = new Map<string, RegisteredPrompt<TContext>>();

  constructor(options: McpFnRegistryOptions = {}) {
    const { compileSchema } = options;
    if (compileSchema !== undefined && typeof compileSchema !== "function") {
      throw new TypeError("McpFnRegistry compileSchema must be a function");
    }
    this.options = { compileSchema };
    if (compileSchema) {
      this.customCompile = adaptSchemaCompiler(compileSchema);
    } else {
      this.builtIn = createSchemaCompiler();
    }
  }

  register<TDefinition extends McpFnToolDefinition<TContext>>(
    definition: TDefinition,
  ): this {
    return this.transact("tool", () => this.addTool(definition));
  }

  /**
   * The definition a registration reads: for a registry-issued view, its
   * frozen fields and the record it came from (no caller code runs); for a
   * caller definition, its fields read once through the caller as receiver.
   */
  private readRegistration(
    input: object,
    kind: DefinitionRecord["kind"],
    known: readonly string[],
  ): { definition: object; fields: Record<PropertyKey, unknown>; record?: DefinitionRecord } {
    const record = viewRecords.get(input);
    if (record?.kind === kind) {
      const fields: Record<PropertyKey, unknown> = {};
      for (const key of Reflect.ownKeys(input)) {
        defineField(fields, key, (input as Record<PropertyKey, unknown>)[key]);
      }
      return { definition: record.definition, fields, record };
    }
    return { definition: input, fields: readDefinition(input, known) };
  }

  private addTool(given: McpFnToolDefinition<TContext>): void {
    const { definition, fields, record } = this.readRegistration(given, "tool", TOOL_FIELDS);
    const tool = fields as unknown as McpFnToolDefinition<TContext>;
    assertName("tool", tool.name);
    this.retryKey = `tool:${tool.name}`;
    if (this.tools.has(tool.name)) {
      throw new McpFnValidationError(`Duplicate MCP tool: ${tool.name}`);
    }
    if (!tool.description.trim()) {
      throw new McpFnValidationError(
        `Tool ${tool.name} requires a non-empty description`,
      );
    }
    if (typeof tool.handler !== "function") {
      throw new McpFnValidationError(
        `Tool ${tool.name} requires a handler function`,
      );
    }
    const sourceInput = tool.inputSchema;
    const sourceOutput = tool.outputSchema;
    const inputSchema = this.snapshotOf(sourceInput, `Tool ${tool.name} inputSchema`);
    const outputSchema = sourceOutput !== undefined
      ? this.snapshotOf(sourceOutput, `Tool ${tool.name} outputSchema`)
      : undefined;
    if (inputSchema.type !== "object") {
      throw new McpFnValidationError(
        `Tool ${tool.name} inputSchema must be an object schema`,
      );
    }
    if (
      outputSchema !== undefined &&
      (outputSchema === null ||
        typeof outputSchema !== "object" ||
        Array.isArray(outputSchema) ||
        outputSchema.type !== "object")
    ) {
      throw new McpFnValidationError(
        `Tool ${tool.name} outputSchema must be an object schema`,
      );
    }
    // The execution contract decides task support, so the registry keeps its
    // own frozen copy (a view's copy is already frozen).
    const execution = record || tool.execution === undefined
      ? tool.execution
      : snapshotJson(tool.execution, `Tool ${tool.name} execution`);
    assertTaskSupport(tool, execution);

    let input: SchemaEntry;
    let output: SchemaEntry | undefined;
    try {
      input = this.entryFor(inputSchema, sourceInput);
      output = outputSchema !== undefined ? this.entryFor(outputSchema, sourceOutput) : undefined;
    } catch (error) {
      throw new McpFnValidationError(
        `Tool ${tool.name} contains an invalid JSON Schema`,
        { cause: errorMessage(error) },
      );
    }

    const schemas: ToolSchemas = {
      inputSchema: input.snapshot as ToolSchemas["inputSchema"],
      outputSchema: output?.snapshot as ToolSchemas["outputSchema"],
    };
    // A view whose snapshots this registry holds is reused as-is, so a clone
    // advertises the source's own view objects.
    const view = record &&
        tool.inputSchema === schemas.inputSchema &&
        tool.outputSchema === schemas.outputSchema
      ? given
      : issueView<McpFnToolDefinition<TContext>>(fields, { ...schemas, execution }, {
        kind: "tool",
        definition,
        schemas,
      });
    this.tools.set(tool.name, {
      definition: definition as McpFnToolDefinition<TContext>,
      view,
      validateInput: input.validator,
      validateOutput: output?.validator,
    });
    this.schemas.push(input.snapshot, ...(output ? [output.snapshot] : []));
    this.registrations.push(target => { target.register(view); });
  }

  registerAll(definitions: McpFnToolDefinition<TContext>[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  registerResource(definition: McpFnResourceDefinition<TContext>): this {
    return this.exclusive("resource", () => this.addResource(definition));
  }

  private addResource(definition: McpFnResourceDefinition<TContext>): this {
    assertUri("resource", definition.uri);
    assertName("resource", definition.name);
    if (typeof definition.read !== "function") {
      throw new McpFnValidationError(
        `Resource ${definition.name} requires a read handler function`,
      );
    }
    if (this.resources.has(definition.uri)) {
      throw new McpFnValidationError(
        `Duplicate MCP resource: ${definition.uri}`,
      );
    }
    assertSubscriptionCallbacks(
      "Resource",
      definition.name,
      definition.subscribe,
      definition.unsubscribe,
    );
    this.resources.set(definition.uri, definition);
    this.registrations.push(target => { target.registerResource(definition); });
    return this;
  }

  registerResourceTemplate(
    definition: McpFnResourceTemplateDefinition<TContext>,
  ): this {
    return this.exclusive("resource template", () => this.addResourceTemplate(definition));
  }

  private addResourceTemplate(
    definition: McpFnResourceTemplateDefinition<TContext>,
  ): this {
    assertName("resource template", definition.name);
    if (typeof definition.read !== "function") {
      throw new McpFnValidationError(
        `Resource template ${definition.name} requires a read handler function`,
      );
    }
    if (this.resourceTemplates.has(definition.name)) {
      throw new McpFnValidationError(
        `Duplicate MCP resource template: ${definition.name}`,
      );
    }
    if (typeof definition.uriTemplate !== "string") {
      throw new McpFnValidationError(
        `Invalid resource URI template ${JSON.stringify(definition.uriTemplate)}`,
      );
    }
    const unsupportedOperator = unsupportedUriTemplateOperator(
      definition.uriTemplate,
    );
    if (unsupportedOperator) {
      throw new McpFnValidationError(
        `Resource template ${definition.name} uses unsupported URI template operator ${unsupportedOperator}`,
      );
    }
    let template: UriTemplate;
    try {
      template = new UriTemplate(definition.uriTemplate);
    } catch (error) {
      throw new McpFnValidationError(
        `Invalid resource URI template ${JSON.stringify(definition.uriTemplate)}`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!template.variableNames.length) {
      throw new McpFnValidationError(
        `Resource template ${definition.name} must contain at least one variable`,
      );
    }
    assertSubscriptionCallbacks(
      "Resource template",
      definition.name,
      definition.subscribe,
      definition.unsubscribe,
    );
    if (
      [...this.resourceTemplates.values()].some(({ definition: registered }) =>
        uriTemplatesOverlap(registered.uriTemplate, definition.uriTemplate),
      )
    ) {
      throw new McpFnValidationError(
        `Ambiguous MCP resource URI template: ${definition.uriTemplate}`,
      );
    }
    for (const name of Object.keys(definition.complete ?? {})) {
      if (!template.variableNames.includes(name)) {
        throw new McpFnValidationError(
          `Resource template ${definition.name} has a completer for unknown variable ${name}`,
        );
      }
    }
    this.resourceTemplates.set(definition.name, { definition, template });
    this.registrations.push(target => { target.registerResourceTemplate(definition); });
    return this;
  }

  registerPrompt(definition: McpFnPromptDefinition<TContext>): this {
    return this.transact("prompt", () => this.addPrompt(definition));
  }

  private addPrompt(given: McpFnPromptDefinition<TContext>): void {
    const { definition, fields, record } = this.readRegistration(given, "prompt", PROMPT_FIELDS);
    const prompt = fields as unknown as McpFnPromptDefinition<TContext>;
    const accepted = record?.schemas as PromptSchemas | undefined;
    assertName("prompt", prompt.name);
    this.retryKey = `prompt:${prompt.name}`;
    if (this.prompts.has(prompt.name)) {
      throw new McpFnValidationError(
        `Duplicate MCP prompt: ${prompt.name}`,
      );
    }
    if (typeof prompt.get !== "function") {
      throw new McpFnValidationError(
        `Prompt ${prompt.name} requires a get handler function`,
      );
    }
    // Every check, compile and listing below reads these snapshots only.
    const sourceSchema = prompt.argumentsSchema;
    const declared: Pick<McpFnPromptDefinition<TContext>, "arguments" | "argumentsSchema"> = {
      arguments: accepted
        ? accepted.arguments
        : snapshotJson(prompt.arguments, `Prompt ${prompt.name} arguments`),
      argumentsSchema: this.snapshotOf(sourceSchema, `Prompt ${prompt.name} argumentsSchema`),
    };
    assertPromptArgumentList(prompt.name, declared);
    if (
      declared.argumentsSchema !== undefined &&
      (!declared.argumentsSchema ||
        typeof declared.argumentsSchema !== "object" ||
        Array.isArray(declared.argumentsSchema) ||
        declared.argumentsSchema.type !== "object")
    ) {
      throw new McpFnValidationError(
        `Prompt ${prompt.name} argumentsSchema must be an object schema`,
      );
    }
    let compiled: SchemaEntry;
    try {
      compiled = declared.argumentsSchema
        ? this.entryFor(declared.argumentsSchema, sourceSchema)
        : this.entryFor(accepted?.schema ?? deepFreeze(promptSchema(declared)), undefined);
    } catch (error) {
      throw new McpFnValidationError(
        `Prompt ${prompt.name} contains an invalid arguments JSON Schema`,
        { cause: errorMessage(error) },
      );
    }
    if (declared.argumentsSchema) {
      assertPromptSchemaSupportsStringValues(
        declared.argumentsSchema,
        `Prompt ${prompt.name} argumentsSchema`,
      );
    }
    const argumentNames = (promptArguments(declared) ?? []).map(
      ({ name }) => name,
    );
    if (new Set(argumentNames).size !== argumentNames.length) {
      throw new McpFnValidationError(
        `Prompt ${prompt.name} has duplicate arguments`,
      );
    }
    assertPromptArgumentsAgree(prompt.name, declared);
    for (const name of Object.keys(prompt.complete ?? {})) {
      if (!argumentNames.includes(name)) {
        throw new McpFnValidationError(
          `Prompt ${prompt.name} has a completer for unknown argument ${name}`,
        );
      }
    }
    const schemas: PromptSchemas = {
      arguments: declared.arguments,
      argumentsSchema: declared.argumentsSchema !== undefined
        ? compiled.snapshot as McpFnObjectSchema
        : undefined,
      schema: compiled.snapshot,
    };
    const view = record &&
        prompt.arguments === schemas.arguments &&
        prompt.argumentsSchema === schemas.argumentsSchema &&
        accepted?.schema === schemas.schema
      ? given
      : issueView<McpFnPromptDefinition<TContext>>(fields, {
        arguments: schemas.arguments,
        argumentsSchema: schemas.argumentsSchema,
      }, { kind: "prompt", definition, schemas });
    this.prompts.set(prompt.name, {
      definition: definition as McpFnPromptDefinition<TContext>,
      view,
      validateArguments: compiled.validator,
    });
    this.schemas.push(compiled.snapshot);
    this.registrations.push(target => { target.registerPrompt(view); });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  hasOutputSchema(name: string): boolean {
    return Boolean(this.tools.get(name)?.validateOutput);
  }

  /**
   * Registered tools by name. Each carries the schema snapshots the registry
   * validates with, not the caller's (possibly later edited) schema objects.
   */
  definitions(): McpFnToolDefinition<TContext>[] {
    this.assertClosed();
    return this.toolViews();
  }

  private toolViews(): McpFnToolDefinition<TContext>[] {
    return [...this.tools.values()]
      .map(({ view }) => view)
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  resourceDefinitions(): McpFnResourceDefinition<TContext>[] {
    return [...this.resources.values()].sort((left, right) =>
      compareCodeUnits(left.uri, right.uri),
    );
  }

  resourceTemplateDefinitions(): McpFnResourceTemplateDefinition<TContext>[] {
    return [...this.resourceTemplates.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  /** Registered prompts by name, carrying the registry's argument snapshots. */
  promptDefinitions(): McpFnPromptDefinition<TContext>[] {
    this.assertClosed();
    return [...this.prompts.values()]
      .map(({ view }) => view)
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  capabilities(options: { listChanged?: boolean } = {}): ServerCapabilities {
    const capabilities: ServerCapabilities = {};
    if (this.tools.size)
      capabilities.tools = { listChanged: options.listChanged ?? true };
    if (this.resources.size || this.resourceTemplates.size) {
      capabilities.resources = {
        listChanged: options.listChanged ?? true,
        subscribe:
          [...this.resources.values()].some((value) => value.subscribe) ||
          [...this.resourceTemplates.values()].some(
            ({ definition }) => definition.subscribe,
          ),
      };
    }
    if (this.prompts.size)
      capabilities.prompts = { listChanged: options.listChanged ?? true };
    if (
      [...this.resourceTemplates.values()].some(
        ({ definition }) => definition.complete,
      ) ||
      [...this.prompts.values()].some(({ view }) => view.complete)
    )
      capabilities.completions = {};
    if (
      this.toolViews().some((definition) => {
        const support = definition.execution?.taskSupport;
        return support === "optional" || support === "required";
      })
    )
      capabilities.tasks = { requests: { tools: { call: {} } } };
    return capabilities;
  }

  listTools(): McpFnListedTool[] {
    return this.definitions().map((definition) => this.listedTool(definition));
  }

  getListedTool(name: string): McpFnListedTool | undefined {
    const view = this.tools.get(name)?.view;
    return view ? this.listedTool(view) : undefined;
  }

  private listedTool(definition: McpFnToolDefinition<TContext>): McpFnListedTool {
    return {
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      description: definition.description,
      inputSchema: definition.inputSchema as McpFnListedTool["inputSchema"],
      ...(definition.outputSchema
        ? {
            outputSchema:
              definition.outputSchema as McpFnListedTool["outputSchema"],
          }
        : {}),
      ...(definition.annotations
        ? { annotations: definition.annotations }
        : {}),
      ...(definition.execution ? { execution: definition.execution } : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    };
  }

  async listResources(
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<Resource[]> {
    const resources: Resource[] = this.resourceDefinitions().map(
      (definition) => ({
        uri: definition.uri,
        name: definition.name,
        ...(definition.title ? { title: definition.title } : {}),
        ...(definition.description
          ? { description: definition.description }
          : {}),
        ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
        ...(definition.annotations
          ? { annotations: definition.annotations }
          : {}),
        ...(definition.icons ? { icons: definition.icons } : {}),
        ...(definition.metadata ? { _meta: definition.metadata } : {}),
      }),
    );
    for (const { definition } of this.resourceTemplates.values()) {
      if (definition.list)
        resources.push(...(await definition.list(context, extra)).resources);
    }
    return resources.sort((left, right) =>
      compareCodeUnits(left.uri, right.uri),
    );
  }

  listResourceTemplates(): ResourceTemplate[] {
    return this.resourceTemplateDefinitions().map((definition) => ({
      uriTemplate: definition.uriTemplate,
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description
        ? { description: definition.description }
        : {}),
      ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
      ...(definition.annotations
        ? { annotations: definition.annotations }
        : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    }));
  }

  listPrompts() {
    return this.promptDefinitions().map((definition) => ({
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description
        ? { description: definition.description }
        : {}),
      ...(promptArguments(definition)
        ? { arguments: promptArguments(definition) }
        : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    }));
  }

  private normalizeAndValidateArgs(
    registered: RegisteredTool<TContext>,
    args: unknown,
  ): {
    args: Record<string, unknown>;
    issues?: ReturnType<typeof formatMcpFnSchemaIssues>;
  } {
    const normalizedArgs = args ?? {};
    // Bound validation work before any schema engine runs: @cfworker/json-schema
    // keeps reporting every extra property or tuple item even when it stops at
    // the first failure elsewhere.
    // Thrown, not returned: an oversized call never reaches
    // handleInvalidArguments, so it can't be turned into a success.
    if (exceedsJsonNodes(normalizedArgs, MAX_ARGUMENT_NODES)) {
      throw new McpFnValidationError(`Invalid arguments for ${registered.view.name}`, {
        issues: [{
          path: "/", instancePath: "/", schemaPath: "#", keyword: "maxNodes",
          message: `Tool arguments may contain at most ${MAX_ARGUMENT_NODES} values`,
        }],
      });
    }
    let issues: SchemaIssue[] | null | undefined;
    try {
      if (registered.validateInput(normalizedArgs)) {
        return { args: normalizedArgs as Record<string, unknown> };
      }
      issues = registered.validateInput.errors;
    } catch (error) {
      // A validator that recurses per instance (@cfworker/json-schema) can
      // overflow the stack on a deeply nested value: reject it as invalid input.
      if (!isStackOverflow(error)) throw error;
      issues = [{ instancePath: "", keyword: "depth", message: "must not nest too deeply to validate" }];
    }
    return {
      args:
        normalizedArgs &&
        typeof normalizedArgs === "object" &&
        !Array.isArray(normalizedArgs)
          ? (normalizedArgs as Record<string, unknown>)
          : {},
      issues: formatMcpFnSchemaIssues(issues),
    };
  }

  async callTool(
    name: string,
    args: unknown,
    context: TContext,
    extra: McpFnRequestExtra,
    observer: McpFnToolLifecycleObserver = {},
  ): Promise<CallToolResult> {
    const registered = this.tools.get(name);
    if (!registered)
      throw new McpFnValidationError(`Unknown MCP tool: ${name}`, { name });
    observer.onStage?.("input-validation");
    const normalized = this.normalizeAndValidateArgs(registered, args);
    if (normalized.issues) {
      if (registered.view.handleInvalidArguments) {
        observer.onStage?.("invalid-arguments-handler");
        const handled = await registered.view.handleInvalidArguments(
          normalized.args,
          normalized.issues,
          context,
          extra,
        );
        observer.onStage?.("output-validation");
        return this.finalizeResult(registered, handled);
      }
      throw new McpFnValidationError(`Invalid arguments for ${name}`, {
        issues: normalized.issues,
      });
    }
    observer.onStage?.("handler");
    const result = await registered.view.handler(
      normalized.args,
      context,
      extra,
    );
    observer.onStage?.("output-validation");
    return this.finalizeResult(registered, result);
  }

  taskSupport(name: string) {
    return (
      this.tools.get(name)?.view.execution?.taskSupport ?? "forbidden"
    );
  }

  async createToolTask(
    name: string,
    args: unknown,
    context: TContext,
    extra: McpFnTaskRequestExtra,
    observer: McpFnToolLifecycleObserver = {},
  ): Promise<CreateTaskResult> {
    const registered = this.tools.get(name);
    if (!registered)
      throw new McpFnValidationError(`Unknown MCP tool: ${name}`, { name });
    observer.onStage?.("input-validation");
    const normalized = this.normalizeAndValidateArgs(registered, args);
    if (normalized.issues) {
      throw new McpFnValidationError(`Invalid arguments for ${name}`, {
        issues: normalized.issues,
      });
    }
    if (!registered.view.taskHandler) {
      throw new McpFnValidationError(
        `Tool ${name} does not support task execution`,
      );
    }
    observer.onStage?.("handler");
    const taskStore = new Proxy(extra.taskStore, {
      get: (target, property, receiver) => {
        if (property === "storeTaskResult") {
          return async (
            taskId: string,
            status: "completed" | "failed",
            result: CallToolResult,
          ) => {
            observer.onStage?.("output-validation");
            let validated: CallToolResult;
            try {
              validated = this.finalizeResult(registered, status === "failed" ? { ...result, isError: true } : result);
            } catch (error) {
              await observer.onTaskOutput?.("failed", error);
              observer.onStage?.("handler");
              throw error;
            }
            await observer.onTaskOutput?.("succeeded");
            // Validation completed; storage and subsequent work belong to the handler.
            observer.onStage?.("handler");
            try {
              return await target.storeTaskResult(taskId, status, validated);
            } catch (error) {
              await observer.onTaskStorageFailure?.(error);
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return registered.view.taskHandler.createTask(
      normalized.args,
      context,
      { ...extra, taskStore },
    );
  }

  private matchResource(uri: string): ResourceMatch<TContext> | undefined {
    const exact = this.resources.get(uri);
    if (exact) return { kind: "resource", definition: exact };
    for (const { definition, template } of this.resourceTemplates.values()) {
      const variables = template.match(uri);
      if (variables) return { kind: "template", definition, variables };
    }
    return undefined;
  }

  async readResource(
    uri: string,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<ReadResourceResult> {
    const match = this.matchResource(uri);
    if (!match) throw new McpFnValidationError(`Unknown MCP resource: ${uri}`);
    const url = new URL(uri);
    return match.kind === "resource"
      ? match.definition.read(url, context, extra)
      : match.definition.read(url, match.variables, context, extra);
  }

  async changeSubscription(
    uri: string,
    subscribed: boolean,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<void> {
    const match = this.matchResource(uri);
    if (!match) throw new McpFnValidationError(`Unknown MCP resource: ${uri}`);
    const url = new URL(uri);
    if (match.kind === "resource") {
      const callback = subscribed
        ? match.definition.subscribe
        : match.definition.unsubscribe;
      if (!callback) {
        throw new McpFnValidationError(
          `Resource ${uri} does not support ${subscribed ? "subscriptions" : "unsubscription"}`,
        );
      }
      await callback(url, context, extra);
      return;
    }
    const callback = subscribed
      ? match.definition.subscribe
      : match.definition.unsubscribe;
    if (!callback) {
      throw new McpFnValidationError(
        `Resource ${uri} does not support ${subscribed ? "subscriptions" : "unsubscription"}`,
      );
    }
    await callback(url, match.variables, context, extra);
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<GetPromptResult> {
    const registered = this.prompts.get(name);
    if (!registered)
      throw new McpFnValidationError(`Unknown MCP prompt: ${name}`);
    const normalized = args ?? {};
    if (!registered.validateArguments(normalized)) {
      throw new McpFnValidationError(`Invalid arguments for prompt ${name}`, {
        issues: formatMcpFnSchemaIssues(registered.validateArguments.errors),
      });
    }
    return registered.view.get(normalized, context, extra);
  }

  async complete(
    ref:
      | { type: "ref/prompt"; name: string }
      | { type: "ref/resource"; uri: string },
    argument: { name: string; value: string },
    completionContext: Record<string, string> | undefined,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<CompleteResult> {
    const empty = { completion: { values: [], total: 0, hasMore: false } };
    if (ref.type === "ref/prompt") {
      const prompt = this.prompts.get(ref.name);
      if (!prompt)
        throw new McpFnValidationError(`Unknown MCP prompt: ${ref.name}`);
      const completers = prompt.view.complete;
      if (!completers || !Object.hasOwn(completers, argument.name)) return empty;
      // Called as a method so a completer keeps its `this`.
      return (
        completers[argument.name]?.(
          argument.value,
          completionContext,
          context,
          extra,
        ) ?? empty
      );
    }
    const template = [...this.resourceTemplates.values()].find(
      ({ definition }) => definition.uriTemplate === ref.uri,
    );
    if (!template) {
      if (this.resources.has(ref.uri)) return empty;
      throw new McpFnValidationError(
        `Unknown MCP resource template: ${ref.uri}`,
      );
    }
    const completers = template.definition.complete;
    if (!completers || !Object.hasOwn(completers, argument.name)) return empty;
    return (
      completers[argument.name]?.(
        argument.value,
        completionContext,
        context,
        extra,
      ) ?? empty
    );
  }

  private finalizeResult(
    registered: RegisteredTool<TContext>,
    result: CallToolResult,
  ): CallToolResult {
    if (registered.validateOutput && result.isError) {
      const { structuredContent: _omitted, ...errorWithoutStructuredContent } =
        result;
      return errorWithoutStructuredContent;
    }
    if (registered.validateOutput) {
      if (!result.structuredContent) {
        throw new McpFnOutputValidationError(
          `Tool ${registered.view.name} declares outputSchema but returned no structuredContent`,
        );
      }
      if (!registered.validateOutput(result.structuredContent)) {
        throw new McpFnOutputValidationError(
          `Invalid output from ${registered.view.name}`,
          { issues: formatMcpFnSchemaIssues(registered.validateOutput.errors) },
        );
      }
    }
    return result;
  }
}

/** A V8 or JavaScriptCore stack overflow ("Maximum call stack size exceeded."); no other error. */
function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /^Maximum call stack size exceeded\.?$/.test(error.message);
}
