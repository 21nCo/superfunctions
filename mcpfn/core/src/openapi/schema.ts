import type { McpFnJsonSchema } from "@mcpfn/core";
import type { OpenApiSkipCode } from "./types.js";

/** Thrown while converting one operation; the operation is skipped with this code. */
export class OpenApiSkip extends Error {
  constructor(
    readonly code: OpenApiSkipCode,
    message: string,
    /** Refused only because the call's document budget had no room left: never remembered, as released reservations may make room. */
    readonly exhausted = false,
  ) {
    super(message);
    this.name = "OpenApiSkip";
  }
}

/** Whether a failure may be remembered for later operations: anything but a refusal of the document budget. */
export function rememberable(error: OpenApiSkip): boolean {
  return !error.exhausted;
}

export type OpenApiVersion = "3.0" | "3.1";

/**
 * `input` removes `readOnly` properties; `output` removes `writeOnly`
 * properties; `plain` removes none (to check a schema as the document wrote it).
 */
export type SchemaMode = "input" | "output" | "plain";

type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 2019-09/2020-12 keywords outside the closed set (D12), plus identifiers
// that change the base URI so `#/definitions/<name>` would no longer resolve.
// Every 2019-09/2020-12 keyword draft-07 does not define is either listed
// here or handled in convertObject: `dependentRequired` is translated to
// `dependencies`, `$defs` becomes `definitions` (refs only ever target
// components; see addDefinitions), and the annotations `$comment`, `deprecated`,
// `contentSchema` and `examples` change no result in either engine. A listed
// keyword would be validated by @cfworker/json-schema but ignored by Ajv's
// draft-07 dialect (or change reference resolution), so the engines would
// accept different payloads.
const UNSUPPORTED_KEYWORDS = [
  "prefixItems",
  "$dynamicRef",
  "$recursiveRef",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentSchemas",
  "minContains",
  "maxContains",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$vocabulary",
  // Draft-04's schema id: mcpFn's validators refuse it at registration.
  "id",
] as const;

// OpenAPI-only annotations dropped from the produced draft-07 schema. `nullable`
// is folded into the type first. A default `$schema` is dropped too (see checkKeywords),
// and so is Ajv's `$async`, which would make its validator return a promise
// that mcpFn's synchronous checks read as a pass; no JSON Schema dialect defines it.
const DROPPED_KEYWORDS = new Set([
  "example",
  "discriminator",
  "xml",
  "externalDocs",
  "nullable",
  "$schema",
  "$async",
]);

const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
]);

const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf"]);

const SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);

const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a 3.1 `jsonSchemaDialect` or `$schema` names a dialect the
 * converter implements: JSON Schema 2020-12 or a published OAS 3.1 base
 * dialect id (`base`, `2024-10-25` or `2024-11-10`). Any other id,
 * including an unpublished dated one, is not known to mean the same.
 */
export function isDefaultDialect(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  return SUPPORTED_DIALECTS.has(uri.endsWith("#") ? uri.slice(0, -1) : uri);
}

const SUPPORTED_DIALECTS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://spec.openapis.org/oas/3.1/dialect/base",
  "https://spec.openapis.org/oas/3.1/dialect/2024-10-25",
  "https://spec.openapis.org/oas/3.1/dialect/2024-11-10",
]);

/**
 * Schema nodes one `fromOpenAPI` call may produce, the one budget of all its
 * work: a floor plus a multiple of the document's own size, so a document
 * that shares one schema object between many operations cannot multiply the
 * work. Every conversion and every copy (each tool's copy of the referenced
 * component schemas it holds and copies made to check a schema) is charged
 * node by node while it is made, so
 * work stops where the budget runs out and a copy that fails is charged only
 * for what it copied.
 * No single schema has a fixed size or depth limit of its own.
 */
const DOCUMENT_NODE_FLOOR = 1_000_000;
const DOCUMENT_NODE_FACTOR = 64;

/**
 * Within one conversion or copy, the produced nodes may exceed the values of
 * the distinct source objects it reads by this factor (plus an allowance)
 * only when objects are shared; a plain JSON tree produces exactly as many.
 */
const SHARING_FACTOR = 4;
const SHARING_ALLOWANCE = 1024;

const REGION = "a schema expands";

/**
 * Skip reasons a schema object's conversion gives whatever region, budget or
 * position it is read in, so one call remembers them per object. A
 * `circular-object` skip raised while converting an object is one of them: the
 * object met again is on the stack below or above it, so either way the cycle
 * is reachable from the object itself. Budget and sharing skips depend on
 * where the object is read and are never remembered (their work is charged).
 */
export const CONTEXT_FREE_FAILURES: ReadonlySet<OpenApiSkipCode> = new Set<OpenApiSkipCode>([
  "circular-object",
  "invalid-schema",
  "unsupported-schema-keyword",
  "unsupported-dialect",
  "unresolved-ref",
  "external-ref",
  "unsupported-ref",
  "unsupported-component-name",
  "unsupported-property-name",
]);

export class NodeBudget {
  private produced = 0;
  private sourceValues = 0;
  /** Objects whose own values are already counted, each once by identity. */
  private readonly credited = new WeakSet<object>();
  /**
   * What a whole call learns about the objects it reads, shared by its
   * budgets: each object's own keys, listed once (so every unit of
   * enumeration work is done once per call or charged to the call's total,
   * however many regions read the same object), and the objects a copy found
   * to contain themselves.
   */
  private readonly call: { keys: WeakMap<object, readonly string[]>; circular: WeakSet<object> };

  constructor(
    private readonly limit = Number.POSITIVE_INFINITY,
    private readonly total?: NodeBudget,
    private readonly subject = REGION,
    call?: NodeBudget["call"],
  ) {
    this.call = call ?? total?.call ?? { keys: new WeakMap(), circular: new WeakSet() };
  }


  /** The own enumerable keys of `value` (an array's indices without its holes), listed once per call. */
  ownKeys(value: object): readonly string[] {
    let keys = this.call.keys.get(value);
    if (keys === undefined) {
      keys = Object.keys(value);
      this.call.keys.set(value, keys);
    }
    return keys;
  }

  /** Whether a copy in this call found that `value` contains itself (a cycle reachable from it). */
  isCircular(value: object): boolean {
    return this.call.circular.has(value);
  }

  markCircular(value: object): void {
    this.call.circular.add(value);
  }

  /** The conversion budget of a whole call for `document`, counted as its values (shared ones once). */
  static forDocument(document: unknown): NodeBudget {
    const call = { keys: new WeakMap<object, readonly string[]>(), circular: new WeakSet<object>() };
    const limit = DOCUMENT_NODE_FLOOR + DOCUMENT_NODE_FACTOR * surveyValues(document, call.keys);
    return new NodeBudget(limit, undefined, "the document's schemas expand in total", call);
  }

  /**
   * A budget for one conversion or copy, charged to this one. Its own check
   * is relative: it may not repeat objects the document shares into many
   * times the values they hold (see SHARING_FACTOR).
   */
  child(): NodeBudget {
    return new NodeBudget(Number.POSITIVE_INFINITY, this);
  }


  /** Nodes that may still be charged. */
  get room(): number {
    return this.limit - this.produced;
  }

  /** Nodes produced so far. */
  get used(): number {
    return this.produced;
  }

  /**
   * Charge `count` nodes at once (a closure walk, a catalog copy, a probe),
   * or nothing when they do not fit: work refused for the budget is not
   * done, so it leaves the budget to other operations.
   */
  chargeNodes(count: number): void {
    if (count === 0) return;
    if (this.produced + count > this.limit) {
      throw new OpenApiSkip("schema-too-large", `${this.subject} to more than ${this.limit} nodes`, this.total === undefined);
    }
    this.total?.chargeNodes(count);
    this.produced += count;
  }

  /** Give back `count` nodes charged at once for work that was then not done (`chargeNodes`). */
  release(count: number): void {
    this.total?.release(count);
    this.produced -= count;
  }

  /** Charge one produced node read from `value`. */
  charge(value?: unknown): void {
    this.total?.charge();
    this.produced += 1;
    if (typeof value === "object" && value !== null) this.source(value);
    if (this.produced > this.limit) {
      throw new OpenApiSkip("schema-too-large", `${this.subject} to more than ${this.limit} nodes`, this.total === undefined);
    }
    // The call's total counts nodes only; each region checks its own sharing.
    if (this.subject === REGION && this.produced > SHARING_FACTOR * this.sourceValues + SHARING_ALLOWANCE) {
      throw new OpenApiSkip(
        "schema-too-large",
        `a schema repeats shared objects into ${this.produced} nodes from ${this.sourceValues} source values`,
      );
    }
  }

  /**
   * Count `value` and its own values as source, once per object whoever refers
   * to it. A conversion that reads the members of an array or map it does not
   * charge (allOf, properties, $defs, ...) calls this for the container.
   */
  source(value: object): void {
    if (this.credited.has(value)) return;
    this.credited.add(value);
    // Own keys, not length: the holes of a sparse array are not source values.
    this.sourceValues += 1 + this.ownKeys(value).length;
  }

  /** Mark `value`, built by the conversion from source already counted, as counted. */
  generated(value: object): void {
    this.credited.add(value);
  }
}

/**
 * Arrays of a private document copy that hold anything but their indices:
 * holes (a length beyond their members) or other own keys, such as `map` or
 * `constructor`, that would shadow what array methods read. Marked once by
 * `surveyValues`; the copy is never changed, so the mark stays true.
 */
const IRREGULAR_ARRAYS = new WeakSet<object>();

/** Whether `keys` (the own keys of `array`, indices first) are exactly its indices. */
function holdsOnlyIndices(array: unknown[], keys: readonly string[]): boolean {
  // Index keys come first in ascending order and other keys after them, so
  // `length` keys ending with index `length - 1` are the indices 0..length-1.
  return keys.length === array.length && (keys.length === 0 || keys[keys.length - 1] === String(keys.length - 1));
}

/**
 * The values in a JSON-like tree, each shared object counted once. Lists the
 * own keys of each object for the call (`keys`) and marks irregular arrays.
 */
function surveyValues(root: unknown, keys: WeakMap<object, readonly string[]>): number {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  let count = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    count += 1;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    const own = Object.keys(value);
    keys.set(value, own);
    if (Array.isArray(value) && !holdsOnlyIndices(value, own)) IRREGULAR_ARRAYS.add(value);
    for (const key of own) stack.push((value as Record<string, unknown>)[key]);
  }
  return count;
}

/**
 * A document array, read only when it holds exactly its indices: its length
 * is then its member count, and the array methods it inherits are not
 * shadowed. Every read of a document array goes through this (or through
 * `arrayOf`, which uses it).
 */
export function documentItems(
  value: unknown[],
  code: "invalid-schema" | "invalid-operation" = "invalid-schema",
): unknown[] {
  if (IRREGULAR_ARRAYS.has(value)) {
    throw new OpenApiSkip(code, "an array has holes or own keys other than its indices");
  }
  return value;
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Parse a local component reference, rejecting external and URL references. */
export function parseComponentRef(
  ref: unknown,
  kind: "schemas" | "parameters" | "requestBodies" | "responses",
): string {
  if (typeof ref !== "string") {
    throw new OpenApiSkip("unsupported-ref", "a $ref value is not a string");
  }
  if (!ref.startsWith("#")) {
    throw new OpenApiSkip("external-ref", `external reference ${JSON.stringify(ref)}`);
  }
  const unsupported = () =>
    new OpenApiSkip(
      "unsupported-ref",
      `reference ${JSON.stringify(ref)} is not a #/components/${kind}/<name> reference`,
    );
  // The fragment is percent-decoded first, then read as a JSON Pointer (RFC 6901 §6).
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    throw unsupported();
  }
  const tokens = pointer.split("/").map(unescapePointerToken);
  if (tokens.length !== 4 || tokens[0] !== "" || tokens[1] !== "components" || tokens[2] !== kind) {
    throw unsupported();
  }
  const name = tokens[3]!;
  if (!COMPONENT_NAME.test(name)) {
    throw new OpenApiSkip(
      "unsupported-component-name",
      `component name ${JSON.stringify(name)} is outside [A-Za-z0-9._-]`,
    );
  }
  return name;
}

interface ConvertedComponent {
  schema?: McpFnJsonSchema | boolean;
  refs?: Set<string>;
  /**
   * Definitions this one validates the same instance against
   * (allOf/anyOf/oneOf/not/if/then/else/dependencies), each with the
   * validator frames from this schema's frame to the definition's.
   */
  inPlace?: Map<string, number>;
  /** Validator frames its own in-place keywords stack, references aside. */
  ownFrames?: number;
  error?: OpenApiSkip;
}

type DirectionalKeyword = "readOnly" | "writeOnly";

function directionalKeyword(mode: "input" | "output"): DirectionalKeyword {
  return mode === "input" ? "readOnly" : "writeOnly";
}

/** Why removing flagged properties from a schema would not be sound. */
interface AccessConflict {
  name: string;
  by: string;
  /** Replaces the sentence built from `name` and `by`. */
  message?: string;
}

/** A schema applied to an instance, and whether only under a condition or an overlapping alternative. */
interface ClosureEntry {
  schema: JsonObject;
  conditional: boolean;
  /** The kinds of value for which the schema applies only under a condition or an overlapping alternative. */
  conditionalKinds?: ReadonlySet<ValueKind>;
  /** The kinds of value for which the schema matters: those every schema on its path from the root admits. */
  kinds: ReadonlySet<ValueKind>;
}

const CONDITIONAL = "anyOf/oneOf members that can overlap, not, if/then/else or a dependency";

/**
 * Keywords that constrain the whole object or its property count, so a
 * flagged property cannot be left out of a value they accepted.
 */
const INSTANCE_CONSTRAINTS = [
  "const",
  "enum",
  "minProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
] as const;

/**
 * Keywords whose result can change when a property is left out, wherever the
 * schema holding them applies only under a condition (where a changed result
 * can turn a pass into a failure).
 */
const NAME_SENSITIVE = [
  ...INSTANCE_CONSTRAINTS,
  "maxProperties",
  "patternProperties",
  "propertyNames",
] as const;

/** Positions whose subschemas are never projected: a flag below them skips the projection. */
// Child positions a flag may not be under, by the kind of value they apply to.
const UNPROJECTED_OBJECT_POSITIONS = ["patternProperties", "propertyNames"] as const;
const UNPROJECTED_ARRAY_POSITIONS = ["contains", "additionalItems"] as const;

function memoMap<K, V>(memos: Map<K, V>, key: K, create: () => V): V {
  let memo = memos.get(key);
  if (memo === undefined) {
    memo = create();
    memos.set(key, memo);
  }
  return memo;
}

function memoFor<K, V>(memos: Map<K, WeakMap<object, V>>, key: K): WeakMap<object, V> {
  let memo = memos.get(key);
  if (!memo) {
    memo = new WeakMap();
    memos.set(key, memo);
  }
  return memo;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? documentItems(value) : [];
}


function objectEntries(value: unknown): Array<[string, unknown]> {
  return isObject(value) ? Object.entries(value) : [];
}

/**
 * Converts OpenAPI 3.0/3.1 Schema Objects to draft-07 for mcpFn's validators.
 * Component schemas are converted once per mode and shared between tools.
 *
 * Properties flagged `readOnly` (input) or `writeOnly` (output) are projected
 * out where they are declared: `properties[name]` becomes `false` (or is
 * deleted from a closed object) and leaves that object's `required`. Because
 * the converted schema is shared, `checkProjection` first proves that every
 * flag reachable from a root sits on a plain applicator chain (`properties`,
 * one `items` schema, a schema `additionalProperties`, `allOf`, `$ref`, or an
 * `anyOf`/`oneOf` member no other member overlaps by kind of value) and that
 * nothing else needs the property; otherwise the root is not projected.
 */
export class SchemaConverter {
  private readonly cache = new Map<string, ConvertedComponent>();
  private readonly ancestors = new Set<object>();
  /** The settled kinds of each schema object and member list, or why reading them failed. */
  private readonly admitted = new WeakMap<object, AdmittedKinds | OpenApiSkip>();
  /** The node of an allOf (`both`) or anyOf/oneOf (`either`) member array, once per array. */
  private readonly memberLists = new Map<"both" | "either", WeakMap<object, MemberList>>();
  /** The distinct kinds of each `type` array, and of the items of each array literal. */
  private readonly listedTypes = new WeakMap<object, readonly ValueKind[]>();
  private readonly literalItems = new WeakMap<object, ReadonlySet<ValueKind>>();
  /** The kinds of the values an `enum` array or a `const` object lists, once per object. */
  private readonly literalKinds = new Map<"enum" | "const", WeakMap<object, AdmittedKinds | OpenApiSkip>>();
  private readonly flags = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly reaches = new Map<DirectionalKeyword, WeakMap<object, boolean>>();
  private readonly reaching = new Map<DirectionalKeyword, ReadonlySet<string>>();
  private readonly projections = new Map<DirectionalKeyword, WeakMap<object, AccessConflict | null>>();
  /** Schema objects whose conversion failed for a reason of their own, by mode, for the whole call. */
  private readonly failures = new Map<SchemaMode, WeakMap<object, OpenApiSkip>>();
  private budget: NodeBudget;

  constructor(
    private readonly version: OpenApiVersion,
    private readonly schemas: JsonObject,
    /** The budget of the whole call; every conversion and copy is charged to it. */
    private readonly total: NodeBudget,
    /**
     * Set when the document's `jsonSchemaDialect` is not the default: a root
     * schema without its own supported `$schema` is then refused.
     */
    private readonly unsupportedDialect?: string,
    /** The engine the registry validates with, read when a schema declares a `__proto__` property. */
    private readonly engine: () => string = () => "ajv",
  ) {
    this.budget = total.child();
  }

  /**
   * A budget for one copy of produced schemas, charged to the call's total
   * node by node as it copies: copies made to check a schema, and each tool's
   * copy of the generated definitions, which are converted once per call.
   */
  copyBudget(): NodeBudget {
    return this.total.child();
  }

  /** Nodes the call's total may still charge. */
  room(): number {
    return this.total.room;
  }

  /** Charge `nodes` to the call's total: the copy of a tool's schemas its catalog entry gets (see `register`). */
  chargeCopy(nodes: number): void {
    this.total.chargeNodes(nodes);
  }

  /** Charge `nodes` of other document-wide work (following component aliases) to the call's total. */
  chargeWork(nodes: number): void {
    this.total.chargeNodes(nodes);
  }

  /** Give back a catalog copy charged for a tool that was then not registered. */
  releaseCopy(nodes: number): void {
    this.total.release(nodes);
  }

  /** Run `task` with a fresh node budget (one per operation input, operation output or component). */
  budgeted<T>(task: () => T): T {
    const outer = this.budget;
    this.budget = this.total.child();
    try {
      return task();
    } finally {
      this.budget = outer;
    }
  }

  private component(name: string): unknown {
    if (!Object.hasOwn(this.schemas, name)) {
      throw new OpenApiSkip(
        "unresolved-ref",
        `reference #/components/schemas/${name} has no target`,
      );
    }
    return this.schemas[name];
  }

  /**
   * The kinds of value `schema` accepts, following local `$ref`s, one `items`
   * schema and `allOf`/`anyOf`/`oneOf`. A schema without `type`, `enum` or
   * `const` accepts every kind. Schemas that reach each other (a reference
   * cycle) get the greatest fixed point of their kinds, the same whichever
   * of them is asked first, so results are kept per schema object.
   */
  admits(schema: unknown): AdmittedKinds {
    if (schema === false) return NOTHING;
    if (!isObject(schema)) return EVERYTHING;
    if (!this.admitted.has(schema)) this.walkKinds(schema);
    const verdict = this.admitted.get(schema)!;
    if (verdict instanceof OpenApiSkip) throw verdict;
    return verdict;
  }

  /**
   * Tarjan's walk from `root` over schema objects and member lists, with an
   * explicit stack (so no reference chain is too deep for it). It reads each
   * node once, its own keywords before its edges, and walks on past a
   * failure; each strongly connected component is settled, or failed, once
   * its successors are, so every verdict depends only on what the node
   * reaches, never on which root reached it first.
   */
  private walkKinds(root: object): void {
    const order = new Map<object, number>();
    const low = new Map<object, number>();
    const terms = new Map<object, KindsTerms | OpenApiSkip>();
    const open: object[] = [];
    const onStack = new Set<object>();
    const path: Array<{ node: object; next: number }> = [];
    const enter = (node: object): void => {
      order.set(node, order.size);
      low.set(node, order.get(node)!);
      open.push(node);
      onStack.add(node);
      terms.set(node, this.ownTerms(node));
      path.push({ node, next: 0 });
    };
    enter(root);
    while (path.length > 0) {
      const frame = path.at(-1)!;
      const children = childrenOf(terms.get(frame.node)!);
      if (frame.next < children.length) {
        const child = children[frame.next++];
        if (this.admitted.has(child)) continue;
        if (!order.has(child)) enter(child);
        else if (onStack.has(child)) low.set(frame.node, Math.min(low.get(frame.node)!, order.get(child)!));
        continue;
      }
      path.pop();
      const { node } = frame;
      const parent = path.at(-1);
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(node)!));
      if (low.get(node) !== order.get(node)) continue;
      // `node` roots a component: it and everything above it on the open stack.
      const component = open.splice(open.lastIndexOf(node));
      for (const member of component) onStack.delete(member);
      const failures = this.componentFailures(component, terms);
      if (failures) for (const [member, failure] of failures) this.admitted.set(member, failure);
      else this.settleKinds(component, terms as Map<object, KindsTerms>);
    }
  }

  /** A node's own terms, or the skip reading its own keywords raised. */
  private ownTerms(node: object): KindsTerms | OpenApiSkip {
    try {
      return this.kindsTerms(node);
    } catch (error) {
      if (error instanceof OpenApiSkip) return error;
      throw error;
    }
  }

  /**
   * The failures of a component whose successors are settled, or undefined
   * when nothing it reaches fails. Each node reaches every other, so all fail
   * once one does. A node takes the nearest failure: its own, else that of
   * its first child (in document order) one step nearer, a failed successor
   * outside the component being one step away.
   */
  private componentFailures(
    component: object[],
    terms: Map<object, KindsTerms | OpenApiSkip>,
  ): Map<object, OpenApiSkip> | undefined {
    const inComponent = new Set(component);
    const failedOutside = (child: object) => !inComponent.has(child) && this.admitted.get(child) instanceof OpenApiSkip;
    const failures = new Map<object, OpenApiSkip>();
    const depth = new Map<object, number>();
    let frontier: object[] = [];
    let candidates: object[] = [];
    for (const node of component) {
      const nodeTerms = terms.get(node)!;
      if (nodeTerms instanceof OpenApiSkip) {
        failures.set(node, nodeTerms);
        depth.set(node, 0);
        frontier.push(node);
      } else if (nodeTerms.children.some(failedOutside)) {
        candidates.push(node);
      }
    }
    if (frontier.length === 0 && candidates.length === 0) return undefined;
    const parents = new Map<object, object[]>();
    for (const node of component) {
      for (const child of childrenOf(terms.get(node)!)) {
        if (!inComponent.has(child)) continue;
        const list = parents.get(child);
        if (list) list.push(node);
        else parents.set(child, [node]);
      }
    }
    for (let step = 1; frontier.length > 0 || candidates.length > 0; step++) {
      for (const node of frontier) for (const parent of parents.get(node) ?? []) candidates.push(parent);
      const reached: object[] = [];
      for (const node of candidates) {
        if (depth.has(node)) continue;
        depth.set(node, step);
        reached.push(node);
      }
      for (const node of reached) {
        for (const child of childrenOf(terms.get(node)!)) {
          const nearer = inComponent.has(child) ? depth.get(child) === step - 1 : step === 1 && failedOutside(child);
          if (!nearer) continue;
          failures.set(node, (failures.get(child) ?? this.admitted.get(child)) as OpenApiSkip);
          break;
        }
      }
      frontier = reached;
      candidates = [];
    }
    return failures;
  }

  /**
   * Settle a component to its greatest fixed point: every node starts from
   * its kinds with each member in the component taken as EVERYTHING, then a
   * member that narrowed narrows its parents incrementally (an intersection
   * with its new kinds, or new counts for anyOf/oneOf). A node narrows at
   * most once per kind and each step costs its parents O(1), so the work is
   * linear in the component's edges, however wide a member list is.
   */
  private settleKinds(component: object[], terms: Map<object, KindsTerms>): void {
    const inComponent = new Set(component);
    const read = (value: unknown): AdmittedKinds => {
      if (value === false) return NOTHING;
      if (!isObject(value)) return EVERYTHING;
      return inComponent.has(value) ? EVERYTHING : (this.admitted.get(value) as AdmittedKinds);
    };
    const settling = new Map<object, SettlingKinds>();
    const parents = new Map<object, Array<{ parent: SettlingKinds; role: "member" | "items" }>>();
    for (const node of component) {
      const nodeTerms = terms.get(node)!;
      const state = new SettlingKinds(nodeTerms, read);
      settling.set(node, state);
      const occurrences: Array<[unknown, "member" | "items"]> = nodeTerms.members.map((member) => [member, "member"]);
      if (nodeTerms.items !== undefined) occurrences.push([nodeTerms.items, "items"]);
      for (const [child, role] of occurrences) {
        if (!isObject(child) || !inComponent.has(child)) continue;
        const list = parents.get(child);
        if (list) list.push({ parent: state, role });
        else parents.set(child, [{ parent: state, role }]);
      }
    }
    // What each node's parents last took it to be.
    const seen = new Map<object, AdmittedKinds>();
    const pending = component.filter((node) => !sameKinds(settling.get(node)!.kinds, EVERYTHING));
    const queued = new Set(pending);
    const nodes = new Map<SettlingKinds, object>([...settling].map(([node, state]) => [state, node]));
    while (pending.length > 0) {
      const child = pending.pop()!;
      queued.delete(child);
      const before = seen.get(child) ?? EVERYTHING;
      const after = settling.get(child)!.kinds;
      seen.set(child, after);
      for (const { parent, role } of parents.get(child) ?? []) {
        const node = nodes.get(parent)!;
        if (parent.narrow(role, before, after) && !queued.has(node)) {
          queued.add(node);
          pending.push(node);
        }
      }
    }
    for (const [node, state] of settling) this.admitted.set(node, state.kinds);
  }

  /** The member list node of `members` combined as `combine`, one per array and combination. */
  private memberList(members: unknown[], combine: "both" | "either"): MemberList {
    const lists = memoFor(this.memberLists, combine);
    let list = lists.get(members);
    if (!list) {
      list = { members: documentItems(members), combine };
      memberListNodes.add(list);
      lists.set(members, list);
    }
    return list;
  }

  /** What the kinds of a schema object or member list combine, read (and checked) once. */
  private kindsTerms(node: object): KindsTerms {
    if (isMemberList(node)) return termsOf(node.combine, EVERYTHING, node.members);
    const schema = node as JsonObject;
    const members: unknown[] = [];
    if (Object.hasOwn(schema, "$ref")) {
      const target = this.component(parseComponentRef(schema.$ref, "schemas"));
      // Whether or not the target is settled yet, the siblings are read here
      // and the target is followed only afterwards, by the walk.
      // OpenAPI 3.0 ignores $ref siblings; 3.1 applies them too.
      if (this.version === "3.0") return termsOf("both", EVERYTHING, [target]);
      members.push(target);
    }
    if (Array.isArray(schema.allOf)) members.push(this.memberList(schema.allOf, "both"));
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const value = schema[keyword];
      if (Array.isArray(value)) members.push(this.memberList(value, "either"));
    }
    const excluded = this.typeOnlyKinds(schema.not);
    const narrowed = this.narrowByValues(EVERYTHING, schema);
    const own = excluded.length === 0 ? narrowed : { ...narrowed, values: without(narrowed.values, excluded) };
    const items = Object.hasOwn(schema, "items") && !Array.isArray(schema.items) ? schema.items : undefined;
    return termsOf("both", own, members, items);
  }

  /** The kinds a `type` value names; an array of them is reduced to its distinct kinds once per array. */
  private typeKinds(type: unknown): readonly ValueKind[] {
    if (!Array.isArray(type)) return kindsOfType(type);
    let kinds = this.listedTypes.get(type);
    if (kinds === undefined) {
      const distinct = new Set<ValueKind>();
      for (const entry of documentItems(type)) for (const kind of kindsOfType(entry)) distinct.add(kind);
      kinds = [...distinct];
      this.listedTypes.set(type, kinds);
    }
    return kinds;
  }

  /** The kinds a `not` refuses when it holds nothing but `type` (and annotations). */
  private typeOnlyKinds(not: unknown): readonly ValueKind[] {
    if (!isObject(not) || not.type === undefined) return [];
    if (!this.budget.ownKeys(not).every((key) => ANNOTATION_KEYWORDS.has(key))) return [];
    return this.typeKinds(not.type);
  }

  /** The kinds of the items of an array literal, once per array. */
  private itemKinds(literal: unknown[]): ReadonlySet<ValueKind> {
    let kinds = this.literalItems.get(literal);
    if (kinds === undefined) {
      const listed = new Set<ValueKind>();
      for (const item of documentItems(literal)) listed.add(kindOfValue(item));
      kinds = listed;
      this.literalItems.set(literal, kinds);
    }
    return kinds;
  }

  /** `enum`/`const`: the value is one of `literals`, and an array value's items are among theirs. */
  private kindsOfLiterals(literals: unknown[]): AdmittedKinds {
    const values = new Set<ValueKind>();
    const items = new Set<ValueKind>();
    for (const literal of literals) {
      values.add(kindOfValue(literal));
      if (Array.isArray(literal)) for (const kind of this.itemKinds(literal)) items.add(kind);
    }
    return { values, items };
  }

  /** The kinds of the literals an `enum` array (or a `const` value) lists, kept per object. */
  private literals(keyword: "enum" | "const", value: unknown): AdmittedKinds {
    const listed = keyword === "enum" ? documentItems(value as unknown[]) : [value];
    if (typeof value !== "object" || value === null) return this.kindsOfLiterals(listed);
    // Kept per object, failure included (an irregular array literal), so a shared list is read once.
    const memo = memoFor(this.literalKinds, keyword);
    let kinds = memo.get(value);
    if (kinds === undefined) {
      try {
        kinds = this.kindsOfLiterals(listed);
      } catch (error) {
        if (error instanceof OpenApiSkip) memo.set(value, error);
        throw error;
      }
      memo.set(value, kinds);
    }
    if (kinds instanceof OpenApiSkip) throw kinds;
    return kinds;
  }

  /** `type` (with 3.0 `nullable`), `enum` and `const`. */
  private narrowByValues(result: AdmittedKinds, schema: JsonObject): AdmittedKinds {
    let narrowed = result;
    if (schema.type !== undefined) {
      const kinds = this.typeKinds(schema.type);
      const nullable = this.version === "3.0" && schema.nullable === true;
      narrowed = { ...narrowed, values: intersect(narrowed.values, nullable ? [...kinds, "null"] : kinds) };
    }
    if (Array.isArray(schema.enum)) narrowed = both(narrowed, this.literals("enum", schema.enum));
    if (Object.hasOwn(schema, "const")) narrowed = both(narrowed, this.literals("const", schema.const));
    return narrowed;
  }

  /**
   * Convert a schema rooted in a tool's input or output schema. Referenced
   * component names are added to `refs`; call `definitions` for their closure.
   */
  convertRoot(schema: unknown, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema | boolean {
    this.checkRootDialect(schema);
    return this.convert(schema, mode, refs);
  }

  /**
   * A schema resource root (a media type, parameter or component schema) is
   * read in its own `$schema` (checked with the other keywords), else in the
   * document's `jsonSchemaDialect`. A root holding only `$ref` is read in the
   * dialect of its target component, which is checked as a root itself; a
   * boolean root is refused like any other.
   */
  private checkRootDialect(schema: unknown): void {
    if (this.unsupportedDialect === undefined) return;
    if (isObject(schema) && Object.hasOwn(schema, "$schema")) return;
    if (isObject(schema) && this.budget.ownKeys(schema).length === 1 && Object.hasOwn(schema, "$ref")) return;
    if (!isObject(schema) && typeof schema !== "boolean") return;
    throw new OpenApiSkip("unsupported-dialect", `the document's jsonSchemaDialect ${this.unsupportedDialect} is not supported`);
  }

  private convert(schema: unknown, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema | boolean {
    // A schema object that already failed for a reason of its own fails again without any work.
    const failed = isObject(schema) ? this.failures.get(mode)?.get(schema) : undefined;
    if (failed) throw failed;
    this.budget.charge(schema);
    if (typeof schema === "boolean") return schema;
    if (!isObject(schema)) {
      throw new OpenApiSkip("invalid-schema", "a schema is not an object");
    }
    if (this.ancestors.has(schema)) {
      throw new OpenApiSkip("circular-object", "a schema contains itself as an object (not through $ref)");
    }
    this.ancestors.add(schema);
    try {
      return this.convertObject(schema, mode, refs);
    } catch (error) {
      if (error instanceof OpenApiSkip && CONTEXT_FREE_FAILURES.has(error.code)) memoFor(this.failures, mode).set(schema, error);
      throw error;
    } finally {
      this.ancestors.delete(schema);
    }
  }

  private checkKeywords(schema: JsonObject): void {
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(schema, keyword)) {
        throw new OpenApiSkip(
          "unsupported-schema-keyword",
          `schema keyword ${keyword} is not supported`,
        );
      }
    }
    if (Object.hasOwn(schema, "$schema") && (this.version === "3.0" || !isDefaultDialect(schema.$schema))) {
      throw new OpenApiSkip("unsupported-dialect", `schema dialect ${JSON.stringify(schema.$schema)} is not supported`);
    }
  }

  private convertObject(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    if (Object.hasOwn(schema, "$ref")) return this.convertReference(schema, mode, refs);
    this.checkKeywords(schema);
    const converted = this.convertKeywords(schema, mode, refs);
    foldExclusiveBounds(converted);
    this.project(converted, schema, mode);
    return this.version === "3.0" && schema.nullable === true
      ? nullableSchema(converted)
      : converted;
  }

  private convertReference(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    const name = parseComponentRef(schema.$ref, "schemas");
    this.component(name);
    // OpenAPI 3.0 ignores every $ref sibling, so they are neither checked nor kept.
    if (this.version === "3.0") return this.reference(name, refs);
    // 3.1 (2020-12) applies the siblings too: an allOf of them and the reference.
    const { $ref, ...rest } = schema;
    this.checkKeywords(rest);
    if (Object.keys(rest).length === 0) return this.reference(name, refs);
    if (rest.allOf !== undefined && !(Array.isArray(rest.allOf) && rest.allOf.length > 0)) {
      throw new OpenApiSkip("invalid-schema", "allOf is not a non-empty array");
    }
    // The siblings are converted where they are (a shared allOf is read, not
    // copied) and the reference joins their allOf as its last member. The
    // allOf is credited first, whatever the order of the siblings.
    if (Array.isArray(rest.allOf)) this.budget.source(rest.allOf);
    // An own `allOf: undefined` is no allOf: the reference becomes one.
    else delete rest.allOf;
    this.budget.generated(rest);
    const converted = this.convertObject(rest, mode, refs);
    this.budget.charge();
    const reference = this.reference(name, refs);
    if (Array.isArray(converted.allOf)) converted.allOf.push(reference);
    else converted.allOf = [reference];
    return converted;
  }

  private convertKeywords(schema: JsonObject, mode: SchemaMode, refs: Set<string>): McpFnJsonSchema {
    const entries: Array<[string, unknown]> = [];
    let dependencies: JsonObject | undefined;
    let defs: JsonObject | undefined;
    // Keyword by keyword, so a failing one ends the work before the rest are read.
    for (const keyword of this.budget.ownKeys(schema)) {
      const value = schema[keyword];
      if (DROPPED_KEYWORDS.has(keyword)) continue;
      // 2020-12 (OpenAPI 3.1) defines no `dependencies`: it annotates only.
      if (keyword === this.ignoredKeyword()) continue;
      if (keyword === "dependencies" && isObject(value)) {
        dependencies = { ...dependencies, ...this.convertDependencies(value, mode, refs) };
      } else if (keyword === "dependentRequired" && isObject(value)) {
        dependencies = { ...value, ...dependencies };
      } else if (keyword === "$defs") {
        // Draft-07 has no $defs, so Ajv would not refuse a malformed one.
        if (!isObject(value)) throw new OpenApiSkip("invalid-schema", "$defs is not an object");
        defs = this.convertMap(value, mode, refs);
      } else {
        const entry = this.convertEntry(schema, keyword, value, mode, refs);
        if (entry) entries.push(entry);
      }
    }
    if (dependencies) entries.push(["dependencies", dependencies]);
    if (defs) addDefinitions(entries, defs);
    return Object.fromEntries(entries) as McpFnJsonSchema;
  }

  /**
   * Ajv leaves a "__proto__" key of properties out, so it never checks that
   * property. @cfworker/json-schema checks an own one, and the inherited
   * Object.prototype when it is absent (its `required` finds that too): only
   * a required property whose schema admits no object is checked as written
   * there, in a body or a response alike.
   */
  private assertPrototypeProperty(schema: JsonObject, property: unknown): void {
    if (this.engine() !== "cfworker") {
      throw new OpenApiSkip("unsupported-property-name", "property __proto__ cannot be declared: Ajv ignores it in properties");
    }
    // `true` accepts the inherited value as it accepts any own one.
    if (property === true) return;
    let objects = true;
    try {
      objects = this.admits(property).values.has("object");
    } catch (error) {
      if (error instanceof OpenApiSkip && !rememberable(error)) throw error;
    }
    if (objects || !this.requiresInline(schema, "__proto__")) {
      throw new OpenApiSkip(
        "unsupported-property-name",
        "property __proto__ must be required and admit no object: the validator reads the inherited Object.prototype when it is absent",
      );
    }
  }

  /** Whether `schema` or one of its inline `allOf` members, read with it, lists `name` in `required`. */
  private requiresInline(schema: JsonObject, name: string): boolean {
    const pending: unknown[] = [schema];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const node = pending.pop();
      if (!isObject(node) || seen.has(node)) continue;
      seen.add(node);
      this.total.chargeNodes(1);
      if (arrayOf(node.required).includes(name)) return true;
      pending.push(...arrayOf(node.allOf));
    }
    return false;
  }

  private convertEntry(
    schema: JsonObject,
    keyword: string,
    value: unknown,
    mode: SchemaMode,
    refs: Set<string>,
  ): [string, unknown] | undefined {
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      if (keyword === "properties" && Object.hasOwn(value, "__proto__")) this.assertPrototypeProperty(schema, value.__proto__);
      return [keyword, this.convertMap(value, mode, refs)];
    }
    if ((SCHEMA_ARRAY_KEYWORDS.has(keyword) || keyword === "items") && Array.isArray(value)) {
      this.budget.source(documentItems(value));
      // Grown member by member, so the budget stops the work before the result is as long as the source.
      const converted: unknown[] = [];
      for (const item of value) converted.push(this.convert(item, mode, refs));
      return [keyword, converted];
    }
    if (keyword === "items") return [keyword, this.convert(value, mode, refs)];
    if (SCHEMA_KEYWORDS.has(keyword)) return [keyword, this.convert(value, mode, refs)];
    if ((keyword === "exclusiveMinimum" || keyword === "exclusiveMaximum") && typeof value === "boolean") {
      // OpenAPI 3.0 (draft-04 style) boolean form; draft-07 takes the bound.
      const bound = schema[keyword === "exclusiveMinimum" ? "minimum" : "maximum"];
      return value && typeof bound === "number" ? [keyword, bound] : undefined;
    }
    return [keyword, value];
  }

  private convertMap(value: JsonObject, mode: SchemaMode, refs: Set<string>): JsonObject {
    return this.convertMembers(value, (item) => this.convert(item, mode, refs));
  }

  private convertDependencies(value: JsonObject, mode: SchemaMode, refs: Set<string>): JsonObject {
    return this.convertMembers(value, (item) => (Array.isArray(item) ? documentItems(item) : this.convert(item, mode, refs)));
  }

  /** A map's members converted one by one, so a failing member ends the work before the rest are read. */
  private convertMembers(value: JsonObject, convert: (item: unknown) => unknown): JsonObject {
    this.budget.source(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of this.budget.ownKeys(value)) entries.push([key, convert(value[key])]);
    return Object.fromEntries(entries);
  }

  /**
   * Leave out the properties `source` itself flags for `mode`: `false` refuses
   * the name whatever `patternProperties` or `additionalProperties` say, and a
   * closed object refuses it once it is no longer listed.
   */
  private project(converted: McpFnJsonSchema, source: JsonObject, mode: SchemaMode): void {
    if (mode === "plain") return;
    const keyword = directionalKeyword(mode);
    const flagged = objectEntries(source.properties)
      .filter(([, property]) => this.hasFlag(property, keyword))
      .map(([name]) => name);
    if (flagged.length === 0 || !isObject(converted.properties)) return;
    const closed = converted.additionalProperties === false && converted.patternProperties === undefined;
    const properties: JsonObject = { ...converted.properties };
    for (const name of flagged) {
      if (closed) delete properties[name];
      else Object.defineProperty(properties, name, { value: false, enumerable: true, writable: true, configurable: true });
    }
    converted.properties = properties as McpFnJsonSchema["properties"];
    if (Array.isArray(converted.required)) {
      const removed = new Set<unknown>(flagged);
      converted.required = documentItems(converted.required).filter((name) => !removed.has(name));
      if ((converted.required as unknown[]).length === 0) delete converted.required;
    }
  }

  private reference(name: string, refs: Set<string>): McpFnJsonSchema {
    refs.add(name);
    return { $ref: `${DEFINITION_REF}${name}` };
  }

  /**
   * Throw `unsupported-access-flag` unless leaving out the properties flagged
   * for `mode` everywhere `schema` applies is sound: the result refuses every
   * flagged name and still accepts what the source accepted without them.
   */
  checkProjection(schema: unknown, mode: "input" | "output"): void {
    const keyword = directionalKeyword(mode);
    const conflict = this.projectionConflict(schema, keyword);
    if (conflict === undefined) return;
    throw new OpenApiSkip(
      "unsupported-access-flag",
      conflict.message ??
        `property ${JSON.stringify(conflict.name)} is ${keyword} but is also constrained by ` +
          `${conflict.by}, so it cannot be removed soundly`,
    );
  }

  /** Whether `schema` (through any subschema or reference) flags a property for `mode`. */
  flagsFor(schema: unknown, mode: "input" | "output"): boolean {
    return this.reachesFlag(schema, directionalKeyword(mode));
  }

  /**
   * Memoised per schema object. A check that reaches a schema still being
   * checked (a reference cycle), or one whose clean result is still
   * provisional, does not know that schema's result yet; as in Tarjan's
   * algorithm, checks are numbered in the order they start, and a clean
   * result that depends on an earlier one stays provisional until the check
   * it depends on ends clean as the first of its cycle. A conflict is always
   * final and ends every check up to the outermost one.
   */
  private projectionConflict(schema: unknown, keyword: DirectionalKeyword): AccessConflict | undefined {
    if (!isObject(schema) || !this.reachesFlag(schema, keyword)) return undefined;
    const memo = memoFor(this.projections, keyword);
    const known = memo.get(schema);
    if (known !== undefined) return known ?? undefined;
    const unknown = this.checking.get(schema) ?? this.provisional.get(schema);
    if (unknown !== undefined) {
      this.lowest = Math.min(this.lowest, unknown);
      return undefined;
    }
    const index = this.started++;
    const mark = this.pending.length;
    const outer = this.lowest;
    this.checking.set(schema, index);
    this.lowest = Number.POSITIVE_INFINITY;
    try {
      const entries = this.closure(schema);
      // Object children only matter in schemas that can accept an object,
      // array items only in schemas that can accept an array, each with
      // whether it applies to that kind of value only under a condition.
      const objects = entriesFor(entries, "object");
      const arrays = entriesFor(entries, "array");
      const conflict = this.flagConflict(objects, keyword) ?? this.childConflict(objects, arrays, keyword);
      if (conflict !== undefined) memo.set(schema, conflict);
      else if (this.lowest >= index) this.settle(schema, mark, memo);
      else {
        this.provisional.set(schema, index);
        this.pending.push(schema);
      }
      return conflict;
    } finally {
      this.checking.delete(schema);
      this.lowest = Math.min(outer, this.lowest >= index ? Number.POSITIVE_INFINITY : this.lowest);
      if (this.checking.size === 0) {
        this.provisional.clear();
        this.pending.length = 0;
      }
    }
  }

  /** `schema` ends clean, first of its cycle: so do the provisional results that started inside its check. */
  private settle(schema: object, mark: number, memo: WeakMap<object, AccessConflict | null>): void {
    memo.set(schema, null);
    for (const settled of this.pending.splice(mark)) {
      memo.set(settled, null);
      this.provisional.delete(settled);
    }
  }

  /** Checks in progress and provisional clean results, by the order their checks started. */
  private readonly checking = new Map<object, number>();
  private readonly provisional = new Map<object, number>();
  private readonly pending: object[] = [];
  private started = 0;
  private lowest = Number.POSITIVE_INFINITY;

  /**
   * `root` and every schema applied to the same instance: `$ref` targets
   * (OpenAPI 3.0 ignores the siblings), `allOf` members and `anyOf`/`oneOf`
   * members, plus, marked `conditional`, `not`/`if`/`then`/`else`, schema
   * dependencies and, for each kind of value two alternatives can both
   * accept, those alternatives. A schema reached both ways is also recorded
   * as conditional, whatever the order of the visits, because its converted
   * form is shared by both.
   * Each entry also keeps the kinds of value every schema on a path to it
   * admits: for any other value a schema on that path fails whatever the
   * entry says, so the entry decides nothing for it. A schema reached for
   * more kinds, or under a condition for more kinds, is visited again (at
   * most twice per kind).
   */
  private closure(root: JsonObject): ClosureEntry[] {
    const entries: ClosureEntry[] = [];
    const visited = new Map<object, { conditionalKinds: ReadonlySet<ValueKind>; kinds: ReadonlySet<ValueKind> }>();
    const walk = (current: unknown, under: ReadonlySet<ValueKind>, reaching: ReadonlySet<ValueKind>): void => {
      if (!isObject(current)) return;
      const before = visited.get(current);
      let kinds = intersect(reaching, this.admittedValues(current));
      let conditionalKinds = under.size === 0 ? NO_KINDS : intersect(under, kinds);
      if (before !== undefined) {
        const covered = [...kinds].every((kind) => before.kinds.has(kind));
        if (covered && [...conditionalKinds].every((kind) => before.conditionalKinds.has(kind))) return;
        kinds = new Set([...before.kinds, ...kinds]);
        conditionalKinds = new Set([...before.conditionalKinds, ...conditionalKinds]);
      }
      visited.set(current, { conditionalKinds, kinds });
      if (Object.hasOwn(current, "$ref")) {
        walk(this.target(current.$ref), conditionalKinds, kinds);
        if (this.version === "3.0") return;
      }
      entries.push({ schema: current, conditional: conditionalKinds.size > 0, conditionalKinds, kinds });
      for (const member of arrayOf(current.allOf)) walk(member, conditionalKinds, kinds);
      for (const keyword of ["anyOf", "oneOf"] as const) {
        const members = arrayOf(current[keyword]);
        const shared = this.sharedKinds(members);
        for (const member of members) {
          const overlapping = shared.size === 0 ? NO_KINDS : intersect(shared, this.admittedValues(member));
          walk(member, overlapping.size === 0 ? conditionalKinds : new Set([...conditionalKinds, ...overlapping]), kinds);
        }
      }
      for (const keyword of ["not", "if", "then", "else"] as const) walk(current[keyword], kinds, kinds);
      for (const keyword of this.dependencyKeywords()) {
        for (const [, dependency] of objectEntries(current[keyword])) walk(dependency, kinds, kinds);
      }
    };
    walk(root, NO_KINDS, EVERYTHING.values);
    return entries;
  }

  /** The keyword conversion drops: 2020-12 (OpenAPI 3.1) defines no `dependencies`, so it annotates only. */
  private ignoredKeyword(): string | undefined {
    return this.version === "3.1" ? "dependencies" : undefined;
  }

  private dependencyKeywords(): string[] {
    return this.version === "3.1" ? ["dependentSchemas"] : ["dependencies", "dependentSchemas"];
  }

  /** The kinds of value two or more alternatives accept; a value of any other kind meets at most one. */
  private sharedKinds(members: unknown[]): Set<ValueKind> {
    const shared = new Set<ValueKind>();
    const seen = new Set<ValueKind>();
    for (const member of members) {
      for (const kind of this.admittedValues(member)) {
        if (seen.has(kind)) shared.add(kind);
        seen.add(kind);
      }
    }
    return shared;
  }

  /**
   * Flags on this instance's own properties, among the schemas that can
   * accept an object: each must be declared in an unconditional schema, no
   * such schema may need the name (a `required` list of another schema, `const`, `enum`,
   * `minProperties` or a dependency), and no conditional one may tell the
   * object with the name from the object without it (listing it, counting
   * or matching property names, or closing the object).
   */
  private flagConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    const declarers = this.declarers(entries, keyword);
    if (!(declarers instanceof Map)) return declarers;
    if (declarers.size === 0) return undefined;
    // Validators do not read a "__proto__" key of properties as a property schema.
    if (declarers.has("__proto__")) return { name: "__proto__", by: "the validators, which ignore it in properties" };
    for (const entry of entries) {
      const conflict = needsFlagged(entry, declarers, this.ignoredKeyword());
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  /** The schemas flagging each property name, or the conflict of a flag under a condition. */
  private declarers(
    entries: ClosureEntry[],
    keyword: DirectionalKeyword,
  ): Map<string, Set<object>> | AccessConflict {
    const declarers = new Map<string, Set<object>>();
    for (const { schema, conditional } of entries) {
      for (const [name, property] of objectEntries(schema.properties)) {
        if (!this.hasFlag(property, keyword)) continue;
        if (conditional) return { name, by: CONDITIONAL };
        const known = declarers.get(name) ?? new Set<object>();
        known.add(schema);
        declarers.set(name, known);
      }
    }
    return declarers;
  }

  /**
   * Flags below this instance: a child value (a property, the additional
   * properties, the items) is projected only when exactly one schema
   * constrains it, unconditionally, and nothing compares whole values.
   * Property children are compared among the schemas that can accept an
   * object (`objects`), items among those that can accept an array
   * (`arrays`): a schema of another kind never applies them.
   */
  private childConflict(
    objects: ClosureEntry[],
    arrays: ClosureEntry[],
    keyword: DirectionalKeyword,
  ): AccessConflict | undefined {
    const reaches = (value: unknown) => this.reachesFlag(value, keyword);
    for (const [members, positions] of [
      [objects, UNPROJECTED_OBJECT_POSITIONS],
      [arrays, UNPROJECTED_ARRAY_POSITIONS],
    ] as const) {
      for (const { schema } of members) {
        for (const position of positions) {
          if (this.childSchemas(schema, position).some(reaches)) return childConflict(keyword, position, "its position");
        }
      }
    }
    for (const { schema } of arrays) {
      if (Array.isArray(schema.items) && documentItems(schema.items).some(reaches)) {
        return childConflict(keyword, "items", "its position in a tuple");
      }
    }
    return (
      this.propertyConflict(objects, keyword) ??
      this.additionalConflict(objects, keyword) ??
      this.itemsConflict(arrays, keyword)
    );
  }

  private propertyConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    // One pass: the listed schemas of every unflagged name (a flagged
    // property is refused outright, so its value is never checked).
    const listed = new Map<string, { values: unknown[]; conditional: boolean }>();
    for (const { schema, conditional } of entries) {
      for (const [name, property] of objectEntries(schema.properties)) {
        if (this.hasFlag(property, keyword)) continue;
        const known = listed.get(name) ?? { values: [], conditional: false };
        known.values.push(property);
        known.conditional ||= conditional;
        listed.set(name, known);
      }
    }
    // How many schemas with a constraining additionalProperties list each
    // name: one that does not list it validates its value as well.
    const ignored = this.ignoredKeyword();
    const additional = entries.filter(({ schema }) => constrainsValues(schema.additionalProperties, ignored));
    const listedByAdditional = new Map<string, number>();
    for (const { schema } of additional) {
      for (const [name] of objectEntries(schema.properties)) {
        listedByAdditional.set(name, (listedByAdditional.get(name) ?? 0) + 1);
      }
    }
    const patterned = patternMatcher(entries, ignored);
    for (const [name, { values, conditional }] of listed) {
      if (!values.some((value) => this.reachesFlag(value, keyword))) continue;
      const subject = `property ${JSON.stringify(name)}`;
      if ((listedByAdditional.get(name) ?? 0) < additional.length) {
        return childConflict(keyword, subject, "additionalProperties of another schema for the same object");
      }
      const conflict = this.singleSource(entries, keyword, subject, values, conditional, patterned(name));
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  private additionalConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    for (const entry of entries) {
      const value = entry.schema.additionalProperties;
      if (!this.reachesFlag(value, keyword)) continue;
      // Names another schema lists or patterns are validated by both schemas.
      const shared = entries.some(
        ({ schema }) =>
          schema !== entry.schema &&
          (objectEntries(schema.properties).length > 0 ||
            objectEntries(schema.patternProperties).length > 0 ||
            constrainsValues(schema.additionalProperties, this.ignoredKeyword())),
      );
      const subject = "additionalProperties";
      const conflict = shared
        ? childConflict(keyword, subject, "properties of another schema for the same object")
        : this.singleSource(entries, keyword, subject, [value], entry.conditional, false);
      if (conflict !== undefined) return conflict;
    }
    return undefined;
  }

  private itemsConflict(entries: ClosureEntry[], keyword: DirectionalKeyword): AccessConflict | undefined {
    const sources: unknown[] = [];
    let conditional = false;
    for (const entry of entries) {
      const { schema } = entry;
      if (schema.items === undefined || Array.isArray(schema.items) || opens(schema.items, this.ignoredKeyword())) continue;
      sources.push(schema.items);
      conditional ||= entry.conditional;
    }
    if (!sources.some((source) => this.reachesFlag(source, keyword))) return undefined;
    for (const { schema } of entries) {
      if (Array.isArray(schema.items)) return childConflict(keyword, "items", "a tuple items list for the same array");
      if (schema.uniqueItems === true) return childConflict(keyword, "items", "uniqueItems");
      if (!opens(schema.contains, this.ignoredKeyword()) || !opens(schema.additionalItems, this.ignoredKeyword())) {
        return childConflict(keyword, "items", "contains or additionalItems");
      }
    }
    return this.singleSource(entries, keyword, "items", sources, conditional, false);
  }

  /** A child value projected through exactly one unconditional schema, which is then checked in turn. */
  private singleSource(
    entries: ClosureEntry[],
    keyword: DirectionalKeyword,
    subject: string,
    sources: unknown[],
    conditional: boolean,
    patterned: boolean,
  ): AccessConflict | undefined {
    if (conditional) return childConflict(keyword, subject, CONDITIONAL);
    if (patterned) return childConflict(keyword, subject, "patternProperties of a schema for the same object");
    // sameReference is an equivalence, so comparing with the first suffices.
    const [first] = sources;
    if (sources.some((source) => !sameReference(first, source))) {
      return childConflict(keyword, subject, "another schema for the same value");
    }
    if (comparesWholeValues(entries)) return childConflict(keyword, subject, "const or enum");
    return this.projectionConflict(first, keyword);
  }

  /** The subschemas `schema` holds under `keyword` (a schema, an array of them or a map of them). */
  private childSchemas(schema: JsonObject, keyword: string): unknown[] {
    const value = schema[keyword];
    if (value === undefined) return [];
    if (Array.isArray(value)) return documentItems(value);
    if (SCHEMA_MAP_KEYWORDS.has(keyword) || keyword === "dependencies" || keyword === "dependentSchemas") {
      return isObject(value) ? Object.values(value).filter((entry) => !Array.isArray(entry)) : [];
    }
    return [value];
  }

  /**
   * Whether removal changes anything in the instance tree `schema` describes:
   * whether some schema reachable from it (through every subschema keyword
   * and `$ref`, with OpenAPI 3.0 ignoring `$ref` siblings) has a property
   * flagged with `keyword`. Components are resolved once per keyword
   * (`componentsReachingFlag`), so the check stays linear in the document.
   */
  private reachesFlag(schema: unknown, keyword: DirectionalKeyword): boolean {
    if (!isObject(schema)) return false;
    const memo = memoFor(this.reaches, keyword);
    let result = memo.get(schema);
    if (result === undefined) {
      const reaching = this.componentsReachingFlag(keyword);
      const { flagged, refs } = this.localFlags(schema, keyword);
      result = flagged || [...refs].some((name) => reaching.has(name));
      memo.set(schema, result);
    }
    return result;
  }

  private componentsReachingFlag(keyword: DirectionalKeyword): ReadonlySet<string> {
    const known = this.reaching.get(keyword);
    if (known) return known;
    const result = new Set<string>();
    const referrers = new Map<string, string[]>();
    const queue: string[] = [];
    for (const [name, schema] of Object.entries(this.schemas)) {
      const { flagged, refs } = this.componentFlags(schema, keyword);
      if (flagged) {
        result.add(name);
        queue.push(name);
      }
      for (const ref of refs) {
        const list = referrers.get(ref) ?? [];
        list.push(name);
        referrers.set(ref, list);
      }
    }
    while (queue.length > 0) {
      for (const referrer of referrers.get(queue.pop()!) ?? []) {
        if (result.has(referrer)) continue;
        result.add(referrer);
        queue.push(referrer);
      }
    }
    this.reaching.set(keyword, result);
    return result;
  }

  /**
   * `localFlags` of a component. One too deeply nested to scan (a stack
   * overflow) or holding a value conversion refuses (such as an irregular
   * array) counts as flagged, so any operation reaching it is checked in
   * full, and fails there with its own skip; others are unaffected.
   */
  private componentFlags(schema: unknown, keyword: DirectionalKeyword): { flagged: boolean; refs: Set<string> } {
    try {
      return this.localFlags(schema, keyword);
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof OpenApiSkip)) throw error;
      return { flagged: true, refs: new Set() };
    }
  }

  /**
   * Whether the schemas reachable from `schema` without following `$ref`
   * have a property flagged with `keyword`, and the components they reference.
   */
  private localFlags(schema: unknown, keyword: DirectionalKeyword): { flagged: boolean; refs: Set<string> } {
    const refs = new Set<string>();
    let flagged = false;
    const seen = new Set<object>();
    const walk = (current: unknown): void => {
      if (!isObject(current) || seen.has(current)) return;
      seen.add(current);
      if (Object.hasOwn(current, "$ref")) {
        try {
          refs.add(parseComponentRef(current.$ref, "schemas"));
        } catch {
          // left for conversion to report
        }
        if (this.version === "3.0") return;
      }
      for (const [, property] of objectEntries(current.properties)) {
        if (this.hasFlag(property, keyword)) flagged = true;
      }
      for (const entry of SUBSCHEMA_KEYWORDS) {
        if (entry === this.ignoredKeyword()) continue;
        for (const child of this.childSchemas(current, entry)) walk(child);
      }
    };
    walk(schema);
    return { flagged, refs };
  }

  private admittedValues(schema: unknown): ReadonlySet<ValueKind> {
    try {
      return this.admits(schema).values;
    } catch {
      return EVERYTHING.values;
    }
  }

  private mayBeObject(schema: unknown): boolean {
    return this.admittedValues(schema).has("object");
  }

  private target(ref: unknown): unknown {
    try {
      return this.component(parseComponentRef(ref, "schemas"));
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a property schema carries `keyword`: on itself, on a schema it
   * references (an alias's own sibling included in 3.1; OpenAPI 3.0 ignores
   * every `$ref` sibling, so there only the target counts), on an `allOf` member, or on
   * every alternative of an `anyOf`/`oneOf` other than a null-only one (the
   * nullable reference idiom `anyOf: [{ $ref }, { type: "null" }]`).
   */
  private hasFlag(property: unknown, keyword: DirectionalKeyword): boolean {
    if (!isObject(property)) return false;
    const memo = memoFor(this.flags, keyword);
    const known = memo.get(property);
    if (known !== undefined) return known;
    // A cycle back to this schema adds no flag; a cycle that never descends
    // into a child is rejected by `definitions` anyway.
    memo.set(property, false);
    try {
      const result = this.computeFlag(property, keyword);
      memo.set(property, result);
      return result;
    } catch (error) {
      // A partial result (such as after a stack overflow) is never kept.
      memo.delete(property);
      throw error;
    }
  }

  private computeFlag(property: JsonObject, keyword: DirectionalKeyword): boolean {
    if (Object.hasOwn(property, "$ref")) {
      const referenced = this.hasFlag(this.target(property.$ref), keyword);
      if (this.version === "3.0" || referenced) return referenced;
    }
    if (property[keyword] === true) return true;
    if (arrayOf(property.allOf).some((member) => this.hasFlag(member, keyword))) return true;
    for (const alternatives of ["anyOf", "oneOf"] as const) {
      const values = arrayOf(property[alternatives]).filter((member) => !this.isNullOnly(member));
      if (values.length > 0 && values.every((member) => this.hasFlag(member, keyword))) return true;
    }
    return false;
  }

  private isNullOnly(schema: unknown): boolean {
    const values = this.admittedValues(schema);
    return values.size === 1 && values.has("null");
  }

  private convertedComponent(name: string, mode: SchemaMode): ConvertedComponent {
    const cacheKey = `${mode}:${name}`;
    let entry = this.cache.get(cacheKey);
    if (!entry) {
      try {
        const refs = new Set<string>();
        const schema = this.budgeted(() => this.convertRoot(this.component(name), mode, refs));
        // Only references the conversion made are edges: a malformed keyword it kept as written makes none.
        const { links, own } = inPlaceReferences(schema);
        entry = { schema, refs, inPlace: new Map([...links].filter(([key]) => refs.has(key))), ownFrames: own };
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        // Converted again by a later operation: its work is charged again.
        if (!rememberable(error)) throw error;
        entry = {
          error: new OpenApiSkip(error.code, `${error.message} (in #/components/schemas/${name})`),
        };
      }
      this.cache.set(cacheKey, entry);
    }
    return entry;
  }

  /**
   * The transitive closure of the component schemas `refs` names, as
   * `definitions`, for a converted `root` referring to them. A closure in
   * which a definition reaches itself without descending into a property,
   * item or other child instance is rejected: validators would recurse on
   * the same value without end. How deep the closure nests is not bounded
   * here: the validator compiling the tool schema decides (a stack overflow
   * skips it as `schema-too-large`), and the work is charged to the call.
   */
  definitions(refs: Iterable<string>, mode: SchemaMode): Record<string, McpFnJsonSchema | boolean> {
    const names = [...refs];
    const known = this.checkDefinitions(names, mode);
    known.value ??= this.emit(names, mode);
    return known.value;
  }

  /** Everything `definitions` checks, without emitting the closure. */
  checkDefinitions(refs: Iterable<string>, mode: SchemaMode): { value?: Record<string, McpFnJsonSchema | boolean> } {
    // Kept per call by mode and names: many operations reach the same closure.
    const names = [...refs];
    const key = `${mode}\0${names.join("\0")}`;
    let known = this.closures.get(key);
    if (!known) {
      try {
        this.checkClosure(names, mode);
        known = {};
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        // The work done is charged; a later operation may find room for the walk.
        if (!rememberable(error)) throw error;
        known = { error };
      }
      this.closures.set(key, known);
    }
    if (known.error) throw known.error;
    return known;
  }

  private readonly closures = new Map<string, { value?: Record<string, McpFnJsonSchema | boolean>; error?: OpenApiSkip }>();
  /** By mode, for the whole call: components whose whole closure converted. */
  private readonly checkedClosures = new Map<SchemaMode, Set<string>>();
  /** By mode, for the whole call: the longest in-place reference chain from each component (-1: it reaches a cycle). */
  private readonly inPlaceDepths = new Map<SchemaMode, Map<string, number>>();
  /** By mode, for the whole call: 1 when a component's closure holds an in-place cycle. */
  private readonly cycles = new Map<SchemaMode, Map<string, number>>();

  /** A converted component of a checked closure (none: no references, no schema). */
  private converted(name: string, mode: SchemaMode): ConvertedComponent {
    return this.cache.get(`${mode}:${name}`) ?? NO_COMPONENT;
  }

  /**
   * Convert the closure of `names` breadth-first and throw its first failure
   * in that order, then refuse an in-place cycle it holds. A component whose
   * closure already converted is not walked again, so a tail many closures
   * share is walked once per call.
   */
  private checkClosure(names: string[], mode: SchemaMode): void {
    const checked = memoMap(this.checkedClosures, mode, () => new Set<string>());
    const seen = new Set<string>();
    const queue = names.filter((name) => !checked.has(name));
    for (let index = 0; index < queue.length; index += 1) {
      const key = queue[index]!;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = this.convertedComponent(key, mode);
      // A failing closure is walked again by every root reaching it: each
      // entry and its edges are charged before they are queued, so a wide
      // shared hub costs every walk that reaches it, and none once the
      // call's total is spent.
      if (entry.error) {
        this.total.chargeNodes(1);
        throw entry.error;
      }
      this.total.chargeNodes(1 + entry.refs!.size);
      for (const next of entry.refs!) if (!seen.has(next) && !checked.has(next)) queue.push(next);
    }
    for (const key of seen) checked.add(key);
    const cycles = memoMap(this.cycles, mode, () => new Map<string, number>());
    const edges = (key: string) => this.converted(key, mode).refs!;
    const holdsCycle = (name: string) =>
      settleGraph(name, edges, cycles, (component, below) =>
        below > 0 || component.some((key) => this.inPlaceDepth(key, mode) < 0) ? 1 : 0,
      ) > 0;
    // Only a closure holding an in-place cycle is walked again, to name the cycle.
    if (names.some(holdsCycle)) {
      assertProductiveRecursion(this.closureEntries(names, mode));
    }
  }

  /** The converted closure of `names`, in breadth-first order, each entry charged to the call's total as it is reached. */
  private closureEntries(names: string[], mode: SchemaMode): Map<string, ConvertedComponent> {
    const entries = new Map<string, ConvertedComponent>();
    const queue = [...names];
    for (let index = 0; index < queue.length; index += 1) {
      const key = queue[index]!;
      if (entries.has(key)) continue;
      const entry = this.converted(key, mode);
      // The entry and every reference it holds: walking a closure costs its edges.
      this.total.chargeNodes(1 + entry.refs!.size);
      entries.set(key, entry);
      for (const next of entry.refs!) if (!entries.has(next)) queue.push(next);
    }
    return entries;
  }

  /**
   * The most frames a validator that follows references while it validates
   * (@cfworker/json-schema) stacks for one value of a tool schema whose
   * converted `root` refers to a checked closure, from the schema alone,
   * never from a sample value. At every position a value can take, the
   * subschemas and references applied there in place count, followed to
   * their end, each child value from its own first frame. Child values
   * every accepted value of the root must have (required properties, items
   * up to `minItems`, by the `type`, `required` and `minItems` of the schema
   * and its `allOf` members) form the root's own chain, which stacks on its
   * parent's frames: no valid value is shallower. Any other child value
   * (optional, or in a branch a value can avoid) is one a caller can leave
   * out, so its chain never stacks. A chain of forced children that never
   * ends has no finite valid instance and is infinitely deep. Each
   * component is walked once per call, and a root once per tool schema,
   * each walk charged to the call's total. A root a call may leave out
   * (`required` false) forces nothing of its own. A schema only checked
   * (`plain`) is measured in place: no value is validated against it.
   */
  frames(root: McpFnJsonSchema | boolean, mode: SchemaMode, required = true): number {
    const own = this.positions(root, mode, mode !== "plain" && required);
    const reach = memoMap(this.reachFrames, mode, () => new Map<string, number>());
    let most = Math.max(own.frames, own.forcedFrames);
    for (const [name, frame] of own.forced) most = Math.max(most, frame + this.forcedFrames(name, mode));
    for (const name of own.refs) {
      const below = settleGraph(name, (key) => this.componentPositions(key, mode).refs, reach, (component, deeper) => {
        let frames = deeper;
        for (const key of component) frames = Math.max(frames, this.componentPositions(key, mode).frames);
        return frames;
      });
      most = Math.max(most, below);
    }
    return most;
  }

  /** By mode, for the whole call: the positions of one component (`positions`). */
  private readonly positionFrames = new Map<SchemaMode, Map<string, Positions>>();
  /** By mode, for the whole call: the most frames at any position a component's schema reaches (`frames`). */
  private readonly reachFrames = new Map<SchemaMode, Map<string, number>>();
  /** By mode, for the whole call: the frames every valid value of a component stacks from its own frame (`forcedFrames`). */
  private readonly forcedDepths = new Map<SchemaMode, Map<string, number>>();

  private componentPositions(name: string, mode: SchemaMode): Positions {
    const local = memoMap(this.positionFrames, mode, () => new Map<string, Positions>());
    let known = local.get(name);
    if (known === undefined) {
      known = this.positions(this.converted(name, mode).schema, mode);
      local.set(name, known);
    }
    return known;
  }

  /**
   * The frames every valid value of component `name` stacks from the frame
   * of a reference to it: its forced chain, continued through the components
   * that chain applies. A cycle of forced references has no finite valid
   * value (Infinity). Settled once per component per call.
   */
  private forcedFrames(name: string, mode: SchemaMode): number {
    const memo = memoMap(this.forcedDepths, mode, () => new Map<string, number>());
    return settleGraph(name, (key) => this.componentPositions(key, mode).forced.keys(), memo, (component) => {
      const key = component[0]!;
      const own = this.componentPositions(key, mode);
      if (component.length > 1 || own.forced.has(key)) return Number.POSITIVE_INFINITY;
      let frames = own.forcedFrames;
      for (const [next, frame] of own.forced) frames = Math.max(frames, frame + memo.get(next)!);
      return frames;
    });
  }

  /**
   * One schema's positions: the most frames at any of them, each child
   * value counted from its own first frame (`frames`), and on the chain of
   * the schema's own value stacked through its forced children
   * (`forcedFrames`), the definitions it applies anywhere (`refs`), and
   * those applied on its own chain, with the frame they are applied at
   * (`forced`). In place, `allOf` members and references must be satisfied;
   * `anyOf`, `oneOf`, `not`, conditions and dependencies need not.
   */
  private positions(schema: unknown, mode: SchemaMode, required = true): Positions {
    const result: Positions = { frames: 0, forcedFrames: 0, refs: new Set(), forced: new Map() };
    // Charged as the walk goes, so it stops before work the budget cannot cover.
    let visited = 0;
    const flush = () => {
      const count = visited;
      visited = 0;
      this.total.chargeNodes(count);
    };
    // `frame` stacks along the own chain; `local` counts from the child value's first frame.
    const visit = (node: unknown, frame: number, local: number, own: boolean, must: boolean, whole?: Conjunction): void => {
      if (node === undefined) return;
      visited += 1;
      if (visited >= POSITION_CHARGE_BATCH) flush();
      let reached = local;
      let stacked = frame;
      if (isObject(node) && typeof node.$ref === "string" && node.$ref.startsWith(DEFINITION_REF)) {
        const name = node.$ref.slice(DEFINITION_REF.length);
        result.refs.add(name);
        // Within a checked closure no in-place chain is a cycle.
        const depth = Math.max(0, this.inPlaceDepth(name, mode));
        reached = local + depth;
        stacked = frame + depth;
        if (own && must) addFrame(result.forced, name, frame);
      }
      result.frames = Math.max(result.frames, reached);
      if (own) result.forcedFrames = Math.max(result.forcedFrames, stacked);
      if (!isObject(node)) return;
      // `allOf` members validate the same value: a child one member declares is
      // forced by `required`, `type` or `minItems` in another.
      if (whole === undefined) {
        // A schema only checked (`plain`) forces no child: it is measured in place.
        whole = mode === "plain" ? UNFORCED : conjunction(node);
        visited += whole.nodes;
        if (visited >= POSITION_CHARGE_BATCH) flush();
      }
      // A branch every valid value must take applies like an `allOf` member.
      const taken = takenBranches(node, whole.selectors);
      for (const member of [...arrayOf(node.allOf), ...taken]) visit(member, frame + 1, local + 1, own, must, whole);
      forEachInPlace(node, (member) => {
        if (!taken.includes(member)) visit(member, frame + 1, local + 1, own, false);
      }, false);
      forEachChild(
        node,
        (member, forced) => (forced && own && must ? visit(member, frame + 1, 1, true, true) : visit(member, 1, 1, false, false)),
        (pairs) => this.total.chargeNodes(pairs),
        whole,
      );
    };
    visit(schema, 1, 1, required, true);
    flush();
    return result;
  }

  /** The closure as `definitions`. Each tool schema holding it is charged while it is copied (`copyBudget`). */
  private emit(names: string[], mode: SchemaMode): Record<string, McpFnJsonSchema | boolean> {
    const result: Array<[string, McpFnJsonSchema | boolean]> = [];
    for (const [key, entry] of this.closureEntries(names, mode)) result.push([key, entry.schema!]);
    return Object.fromEntries(result);
  }

  /**
   * The most validator frames that validating one value against component
   * `name` stacks by applying subschemas and references in place (at least
   * 1), or -1 when it reaches an in-place cycle. Walked with an explicit
   * stack over converted components, and kept for the whole call.
   */
  private inPlaceDepth(name: string, mode: SchemaMode): number {
    const depths = memoMap(this.inPlaceDepths, mode, () => new Map<string, number>());
    const known = depths.get(name);
    if (known !== undefined) return known;
    const linksOf = (key: string) => this.converted(key, mode).inPlace!;
    const active = new Set([name]);
    const stack = [{ key: name, next: linksOf(name).keys() }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const step = frame.next.next();
      if (!step.done) {
        if (depths.has(step.value)) continue;
        if (active.has(step.value)) {
          // Every component still open reaches the cycle.
          for (const open of stack) depths.set(open.key, -1);
          break;
        }
        active.add(step.value);
        stack.push({ key: step.value, next: linksOf(step.value).keys() });
        continue;
      }
      stack.pop();
      active.delete(frame.key);
      let frames = this.converted(frame.key, mode).ownFrames ?? 1;
      for (const [next, distance] of linksOf(frame.key)) {
        const depth = depths.get(next)!;
        frames = depth < 0 || frames < 0 ? -1 : Math.max(frames, distance + depth);
      }
      depths.set(frame.key, frames);
    }
    return depths.get(name)!;
  }
}

const DEFINITION_REF = "#/definitions/";

/**
 * Why `entry`, a schema for an object whose flagged properties `declarers`
 * maps to the schemas flagging them, needs a flagged name: a `required` list
 * of a schema that does not flag it, an object-wide constraint, or (under a
 * condition) a keyword that tells the object with the name from the one without.
 */
function needsFlagged(
  entry: ClosureEntry,
  declarers: ReadonlyMap<string, ReadonlySet<object>>,
  ignored: string | undefined,
): AccessConflict | undefined {
  const { schema, conditional } = entry;
  const [first] = declarers.keys();
  const constraint = (conditional ? NAME_SENSITIVE : INSTANCE_CONSTRAINTS).find(
    (keyword) => keyword !== ignored && Object.hasOwn(schema, keyword),
  );
  if (constraint !== undefined) return { name: first!, by: constraint };
  if (conditional && !opens(schema.additionalProperties, ignored)) {
    return { name: first!, by: "additionalProperties under a condition" };
  }
  const listed = conditional ? objectEntries(schema.properties).find(([name]) => declarers.has(name)) : undefined;
  if (listed !== undefined) return { name: listed[0], by: CONDITIONAL };
  const foreign = arrayOf(schema.required).find(
    (name) => typeof name === "string" && declarers.get(name)?.has(schema) === false,
  );
  return foreign === undefined
    ? undefined
    : { name: foreign as string, by: "a required list of another schema for the same object" };
}

const wholeValueChecks = new WeakMap<ClosureEntry[], boolean>();

/** Whether some schema for the instance has an object or array `const`/`enum` (computed once per closure). */
function comparesWholeValues(entries: ClosureEntry[]): boolean {
  let known = wholeValueChecks.get(entries);
  if (known === undefined) {
    known = entries.some(({ schema }) => isComposite(schema.const) || arrayOf(schema.enum).some(isComposite));
    wholeValueChecks.set(entries, known);
  }
  return known;
}

/**
 * Whether a constraining `patternProperties` key of `entries` may match a
 * name. Only an anchored literal prefix (`^x-`) or literal (`^id$`) is
 * decided, by looking strings up; any other pattern may match. No document
 * pattern is ever run.
 */
function patternMatcher(entries: ClosureEntry[], ignored: string | undefined): (name: string) => boolean {
  const exact = new Set<string>();
  // Literal prefixes by length: a name is compared once per distinct length,
  // with no structure larger than the prefixes themselves.
  const prefixes = new Map<number, Set<string>>();
  let any = false;
  for (const { schema } of entries) {
    for (const [pattern, value] of objectEntries(schema.patternProperties)) {
      if (!constrainsValues(value, ignored)) continue;
      const literal = /^\^([A-Za-z0-9_-]*)(\$?)$/.exec(pattern);
      if (!literal) any = true;
      else if (literal[2]) exact.add(literal[1]!);
      else {
        const prefix = literal[1]!;
        const known = prefixes.get(prefix.length) ?? new Set<string>();
        known.add(prefix);
        prefixes.set(prefix.length, known);
      }
    }
  }
  return (name) => {
    if (any || exact.has(name)) return true;
    for (const [length, known] of prefixes) {
      if (length <= name.length && known.has(name.slice(0, length))) return true;
    }
    return false;
  };
}

/**
 * Draft-07 has no `$defs`, so Ajv would not check the declarations under it
 * while @cfworker/json-schema does: they become `definitions` (never
 * referenced, since refs only target components), or an `allOf` member's
 * when the schema declares `definitions` too, which accepts every value.
 */
function addDefinitions(entries: Array<[string, unknown]>, defs: JsonObject): void {
  if (!entries.some(([keyword]) => keyword === "definitions")) {
    entries.push(["definitions", defs]);
    return;
  }
  const allOf = entries.find(([keyword]) => keyword === "allOf");
  if (allOf === undefined) entries.push(["allOf", [{ definitions: defs }]]);
  else if (Array.isArray(allOf[1]) && allOf[1].length > 0) allOf[1] = [...allOf[1], { definitions: defs }];
  // A malformed allOf is kept as written, so the schema is still refused.
  else entries.push(["$defs", defs]);
}

function childConflict(keyword: DirectionalKeyword, subject: string, by: string): AccessConflict {
  return {
    name: subject,
    by,
    message: `${subject} contains ${keyword} properties but is also constrained by ${by}, so they cannot be removed soundly`,
  };
}

/** The same object, or two references to the same component. */
function sameReference(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return (
    isObject(left) &&
    isObject(right) &&
    Object.keys(left).length === 1 &&
    Object.keys(right).length === 1 &&
    typeof left.$ref === "string" &&
    left.$ref === right.$ref
  );
}

/** Whether a subschema accepts every value (absent, `true` or `{}`, ignoring a keyword the dialect does not define). */
function opens(value: unknown, ignored: string | undefined): boolean {
  return value === undefined || value === true || (isObject(value) && Object.keys(value).every((key) => key === ignored));
}

/** Whether a `const` or `enum` value is an object or array, which constrains child values. */
function isComposite(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Whether an `additionalProperties` value constrains the values (not only the presence) of properties. */
function constrainsValues(value: unknown, ignored: string | undefined): boolean {
  return isObject(value) && Object.keys(value).some((key) => key !== ignored);
}

function foldExclusiveBounds(converted: McpFnJsonSchema): void {
  // `{ minimum: 1, exclusiveMinimum: true }` became `exclusiveMinimum: 1`;
  // the inclusive bound it replaced is redundant.
  if (typeof converted.exclusiveMinimum === "number" && converted.minimum === converted.exclusiveMinimum) {
    delete converted.minimum;
  }
  if (typeof converted.exclusiveMaximum === "number" && converted.maximum === converted.exclusiveMaximum) {
    delete converted.maximum;
  }
}

/** Every keyword holding subschemas, for `localFlags`. */
const SUBSCHEMA_KEYWORDS = [
  "properties",
  "definitions",
  "$defs",
  "allOf",
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependencies",
  "dependentSchemas",
] as const;

const IN_PLACE_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

const NO_COMPONENT: ConvertedComponent = { refs: new Set(), inPlace: new Map(), ownFrames: 1 };

/**
 * A value per node of a graph, settled once per strongly connected component
 * as `settle(component, below)`, `below` being the largest value of a
 * successor outside it (0 when none). Tarjan's walk with an explicit stack,
 * so no chain is too long for it; `memo` keeps the values for the whole call.
 */
function settleGraph(
  start: string,
  edges: (node: string) => Iterable<string>,
  memo: Map<string, number>,
  settle: (component: string[], below: number) => number,
): number {
  const known = memo.get(start);
  if (known !== undefined) return known;
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const below = new Map<string, number>();
  const open: string[] = [];
  const path: Array<{ node: string; next: Iterator<string> }> = [];
  const enter = (node: string): void => {
    low.set(node, order.size);
    order.set(node, order.size);
    below.set(node, 0);
    open.push(node);
    path.push({ node, next: edges(node)[Symbol.iterator]() });
  };
  enter(start);
  while (path.length > 0) {
    const frame = path.at(-1)!;
    const step = frame.next.next();
    if (!step.done) {
      const child = step.value;
      const value = memo.get(child);
      if (value !== undefined) below.set(frame.node, Math.max(below.get(frame.node)!, value));
      else if (!order.has(child)) enter(child);
      // Visited but not settled: still open, so in this node's component.
      else low.set(frame.node, Math.min(low.get(frame.node)!, order.get(child)!));
      continue;
    }
    path.pop();
    const { node } = frame;
    const parent = path.at(-1);
    if (low.get(node) !== order.get(node)) {
      low.set(parent!.node, Math.min(low.get(parent!.node)!, low.get(node)!));
      continue;
    }
    const component = open.splice(open.lastIndexOf(node));
    let outside = 0;
    for (const member of component) outside = Math.max(outside, below.get(member)!);
    const value = settle(component, outside);
    for (const member of component) memo.set(member, value);
    if (parent) below.set(parent.node, Math.max(below.get(parent.node)!, value));
  }
  return memo.get(start)!;
}

/**
 * Definitions a converted schema applies to the same instance it validates,
 * each with the most validator frames from the schema's own frame to the
 * definition's (1 for a `$ref` on the schema itself), and the frames its
 * in-place keywords stack without references. `then` and `else` apply only
 * beside `if`, as validators apply them.
 */
function inPlaceReferences(schema: McpFnJsonSchema | boolean): { links: Map<string, number>; own: number } {
  const links = new Map<string, number>();
  let own = 1;
  const walk = (current: unknown, frame: number): void => {
    if (!isObject(current)) return;
    own = Math.max(own, frame);
    if (typeof current.$ref === "string" && current.$ref.startsWith(DEFINITION_REF)) {
      const name = current.$ref.slice(DEFINITION_REF.length);
      links.set(name, Math.max(links.get(name) ?? 0, frame));
    }
    forEachInPlace(current, (member) => walk(member, frame + 1));
  };
  walk(schema, 1);
  return { links, own };
}

/** The subschemas a draft-07 validator applies to the same instance as `schema`. */
function forEachInPlace(schema: JsonObject, visit: (member: unknown) => void, allOf = true): void {
  for (const keyword of IN_PLACE_ARRAY_KEYWORDS) {
    if (keyword === "allOf" && !allOf) continue;
    for (const member of arrayOf(schema[keyword])) visit(member);
  }
  visit(schema.not);
  if (schema.if !== undefined) {
    visit(schema.if);
    visit(schema.then);
    visit(schema.else);
  }
  for (const [, dependency] of objectEntries(schema.dependencies)) visit(dependency);
}

/**
 * What a schema and its inline `allOf` members, applied to the same value,
 * demand of it together: the names any of them `required`, the JSON types all
 * of their `type`s allow (undefined when none has one), and the largest
 * `minItems` and `minProperties`. `required` and `names` hold the names every
 * accepted object owns: those a `required` list names, except a name every
 * object inherits (`toString`), which satisfies @cfworker/json-schema's
 * `required` without an own property unless a declared `properties` entry
 * would be applied to the inherited function; and every declared name of a
 * closed object (`additionalProperties: false`, no patterns) whose
 * `minProperties` leaves none of them out. Members behind a `$ref` are not
 * read. `nodes` counts the walk.
 */
interface Conjunction {
  required: string[];
  names: Set<string>;
  /** The kinds of value its `type`s admit (`number` admits integers). */
  types: Set<ValueKind> | undefined;
  /** The kinds the schema and its inline `allOf` members admit, which select the branches taken (`takenBranches`). */
  selectors: Set<ValueKind> | undefined;
  minItems: number;
  minProperties: number;
  nodes: number;
}

/** How many walked nodes `positions` charges at once. */
const POSITION_CHARGE_BATCH = 1024;

/** A conjunction that demands nothing: every child value starts its own chain. */
const UNFORCED: Conjunction = {
  required: [], names: new Set(), types: undefined, selectors: undefined, minItems: 0, minProperties: 0, nodes: 0,
};

function conjunction(schema: JsonObject): Conjunction {
  const names = new Set<string>();
  const result: Conjunction = {
    required: [], names, types: undefined, selectors: undefined, minItems: 0, minProperties: 0, nodes: 0,
  };
  const inline: unknown[] = [schema];
  while (inline.length > 0) {
    const node = inline.pop();
    result.nodes += 1;
    if (!isObject(node)) continue;
    if (node.type !== undefined) result.selectors = narrowed(result.selectors, node.type);
    for (const member of arrayOf(node.allOf)) inline.push(member);
  }
  // Names a `properties` entry other than `true` declares: @cfworker/json-schema
  // applies it to an inherited value (`toString`) too, and throws on a function.
  const owned = new Set<string>();
  // The declared names of each closed object (`additionalProperties: false`, no patterns).
  const closed: string[][] = [];
  const required: string[] = [];
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const node = pending.pop();
    result.nodes += 1;
    if (!isObject(node)) continue;
    const declared = objectEntries(node.properties);
    // The entries of `required`, `type` and `properties` read here are walked too.
    result.nodes += arrayOf(node.required).length + arrayOf(node.type).length + declared.length;
    for (const [name, member] of declared) if (member !== true) owned.add(name);
    if (node.additionalProperties === false && objectEntries(node.patternProperties).length === 0) {
      closed.push(declared.map(([name]) => name));
    }
    for (const name of arrayOf(node.required)) if (typeof name === "string") required.push(name);
    if (node.type !== undefined) result.types = narrowed(result.types, node.type);
    if (typeof node.minItems === "number") result.minItems = Math.max(result.minItems, node.minItems);
    if (typeof node.minProperties === "number") result.minProperties = Math.max(result.minProperties, node.minProperties);
    result.nodes += arrayOf(node.anyOf).length + arrayOf(node.oneOf).length;
    for (const member of [...arrayOf(node.allOf), ...takenBranches(node, result.selectors)]) pending.push(member);
  }
  const own = (name: string) => {
    if (names.has(name)) return;
    names.add(name);
    result.required.push(name);
  };
  // A required name every object inherits needs an own property only where
  // a declared schema would otherwise be applied to the inherited function.
  for (const name of required) if (!(name in Object.prototype) || owned.has(name)) own(name);
  // A closed object's own names are declared ones: `minProperties` of them
  // must all be present when there are no more than that.
  // Several closed members admit only the names each of them declares.
  const allowed = closed.slice(1).reduce((names, next) => {
    const declared = new Set(next);
    return names.filter((name) => declared.has(name));
  }, closed[0] ?? []);
  if (allowed.length > 0 && result.minProperties >= allowed.length) allowed.forEach(own);
  return result;
}

/**
 * The subschemas a draft-07 validator applies to child values (properties,
 * items, ...) of the instance `schema` validates, each with whether every
 * value `schema` accepts has that child: a property every accepted object
 * owns (`conjunction`: its `properties` entry and the `patternProperties`
 * matching it, else `additionalProperties`) when only objects are accepted,
 * and items up to `minItems` when only arrays are. `whole` is what `schema` with the `allOf`
 * members it belongs to demands of the value (`conjunction`).
 */
function forEachChild(
  schema: JsonObject,
  visit: (member: unknown, forced: boolean) => void,
  charge: (pairs: number) => void = () => undefined,
  whole: Conjunction = conjunction(schema),
): void {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const patterns = objectEntries(schema.patternProperties);
  // Only a schema with patterns or `additionalProperties` reads every
  // required name; each `allOf` member that does is charged for them.
  const scan = patterns.length > 0 || schema.additionalProperties !== undefined;
  const object = onlyType(whole, "object");
  const required = object && scan ? whole.required : [];
  // Every required name is matched against every pattern: charged first.
  if (required.length > 0) charge(required.length * (1 + patterns.length));
  const forcedPatterns = new Set<string>();
  let forcedAdditional = false;
  const expressions = new Map<string, RegExp | undefined>();
  for (const name of required) {
    const declared = Object.hasOwn(properties, name);
    // Matching patterns apply beside `properties`; `additionalProperties` only
    // without either. A pattern validators cannot read forces nothing.
    let matched = false;
    let readable = true;
    for (const [pattern] of patterns) {
      const matches = patternMatches(pattern, name, expressions, charge);
      if (matches === undefined) readable = false;
      else if (matches) {
        forcedPatterns.add(pattern);
        matched = true;
      }
    }
    if (!declared && !matched && readable) forcedAdditional = true;
  }
  for (const [name, member] of objectEntries(schema.properties)) visit(member, object && whole.names.has(name));
  for (const [pattern, member] of patterns) visit(member, forcedPatterns.has(pattern));
  visit(schema.additionalProperties, forcedAdditional);
  visit(schema.propertyNames, false);
  visit(schema.contains, false);
  const minItems = onlyType(whole, "array") ? whole.minItems : 0;
  if (Array.isArray(schema.items)) {
    const items = arrayOf(schema.items);
    items.forEach((member, index) => visit(member, minItems > index));
    visit(schema.additionalItems, minItems > items.length);
  } else {
    visit(schema.items, minItems >= 1);
  }
}

/**
 * The in-place branches of `schema` every value it accepts must satisfy:
 * the only member of `anyOf` or `oneOf` whose `type` does not contradict the
 * kinds the schema's inline conjunction admits (`selectors`) and its own
 * `type`, and `then` under an always-true `if` (`else` under `false`). At
 * most three, each read where the schema is.
 */
function takenBranches(schema: JsonObject, selectors: Set<ValueKind> | undefined): unknown[] {
  const taken: unknown[] = [];
  const own = schema.type === undefined ? selectors : narrowed(selectors, schema.type);
  for (const keyword of ["anyOf", "oneOf"] as const) {
    let open: unknown;
    let count = 0;
    for (const member of arrayOf(schema[keyword])) {
      if (member === false) continue;
      if (own !== undefined && isObject(member) && member.type !== undefined &&
        !typeEntries(member.type).some((type) => kindsOfType(type).some((kind) => own.has(kind)))) continue;
      open = member;
      count += 1;
      if (count > 1) break;
    }
    if (count === 1) taken.push(open);
  }
  const always = schema.if === true || (isObject(schema.if) && Object.keys(schema.if).length === 0);
  if (always && schema.then !== undefined) taken.push(schema.then);
  if (schema.if === false && schema.else !== undefined) taken.push(schema.else);
  return taken;
}

function typeEntries(type: unknown): unknown[] {
  return typeof type === "string" ? [type] : arrayOf(type);
}

/** The kinds of `kinds` (all when undefined) that `type` also admits. */
function narrowed(kinds: Set<ValueKind> | undefined, type: unknown): Set<ValueKind> {
  const own = new Set(typeEntries(type).flatMap((entry) => kindsOfType(entry)));
  return kinds === undefined ? own : new Set([...kinds].filter((kind) => own.has(kind)));
}

/** Whether a conjunction accepts only values of JSON type `type` by its `type`s. */
function onlyType(whole: Conjunction, type: ValueKind): boolean {
  return whole.types !== undefined && whole.types.size === 1 && whole.types.has(type);
}

/**
 * Whether a `patternProperties` pattern matches `name`, for a pattern of
 * literal characters with optional `^` and `$` anchors (undefined for any
 * other pattern). No pattern from the document runs as a regular expression
 * while converting.
 */
function patternMatches(
  pattern: string,
  name: string,
  expressions: Map<string, RegExp | undefined>,
  charge: (work: number) => void,
): boolean | undefined {
  const start = pattern.startsWith("^");
  const end = pattern.length > (start ? 1 : 0) && pattern.endsWith("$") && !pattern.endsWith("\\$");
  const literal = pattern.slice(start ? 1 : 0, end ? -1 : undefined);
  if (/[\\.^$|?*+()[\]{}]/.test(literal)) {
    if (!expressions.has(pattern)) expressions.set(pattern, boundedExpression(pattern));
    const expression = expressions.get(pattern);
    if (expression === undefined) return undefined;
    // One quantifier and no groups: at most quadratic in the name, charged first.
    charge((name.length + 1) ** 2);
    return expression.test(name);
  }
  if (start && end) return name === literal;
  if (start) return name.startsWith(literal);
  if (end) return name.endsWith(literal);
  return name.includes(literal);
}

/**
 * A pattern as the validator compiles it (`u`), only when it has no groups,
 * alternation, backreferences or lookaround and at most one quantifier, so
 * matching cannot backtrack exponentially (undefined otherwise).
 */
function boundedExpression(pattern: string): RegExp | undefined {
  let quantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      if (/[1-9k]/.test(pattern[index + 1] ?? "1")) return undefined;
      index += 1;
    } else if (char === "[") {
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") index += pattern[index] === "\\" ? 2 : 1;
      if (index >= pattern.length) return undefined;
    } else if (char === "(" || char === ")" || char === "|") {
      return undefined;
    } else if (char === "*" || char === "+" || char === "?" || char === "{") {
      quantifiers += 1;
    }
  }
  if (quantifiers > 1) return undefined;
  try {
    return new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
}

/** Keep the largest frame each definition is applied at. */
function addFrame(frames: Map<string, number>, name: string, frame: number): void {
  frames.set(name, Math.max(frames.get(name) ?? 0, frame));
}

/** The positions of one schema (`SchemaConverter.positions`). */
interface Positions {
  frames: number;
  forcedFrames: number;
  refs: Set<string>;
  forced: Map<string, number>;
}

/** A stack overflow (the converter's or a validator's) means schemas or references nest too deeply. */
export const TOO_DEEP = "a schema or reference chain nests too deeply";

/**
 * `A: { $ref: B }, B: { $ref: A }` or a 3.1 `X: { $ref: X, type: object }`
 * never descends into a child value; validators recurse on it without end.
 * Names the in-place cycle a closure reaches; walked with an explicit stack, so no chain is too long to check. */
function assertProductiveRecursion(entries: ReadonlyMap<string, ConvertedComponent>): void {
  const links = (key: string): Iterator<string> => (entries.get(key)?.inPlace ?? new Map<string, number>()).keys();
  const done = new Set<string>();
  const active = new Set<string>();
  for (const start of entries.keys()) {
    if (done.has(start)) continue;
    active.add(start);
    const stack = [{ key: start, next: links(start) }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const step = frame.next.next();
      if (step.done) {
        stack.pop();
        active.delete(frame.key);
        done.add(frame.key);
      } else if (active.has(step.value)) {
        throw new OpenApiSkip(
          "unresolved-ref",
          `#/components/schemas/${step.value} refers back to itself without descending into a property or array item`,
        );
      } else if (!done.has(step.value)) {
        active.add(step.value);
        stack.push({ key: step.value, next: links(step.value) });
      }
    }
  }
}

// OpenAPI 3.0.3: `nullable: true` adds "null" only to an explicitly defined
// `type`; other constraints such as `enum` keep their meaning, and a schema
// without `type` is unaffected.
function nullableSchema(schema: McpFnJsonSchema): McpFnJsonSchema {
  if (typeof schema.type === "string") {
    return schema.type === "null" ? schema : { ...schema, type: [schema.type, "null"] };
  }
  if (Array.isArray(schema.type) && !documentItems(schema.type).includes("null")) {
    return { ...schema, type: [...schema.type, "null"] };
  }
  return schema;
}

/** A kind of JSON value. `integer` and `number` are disjoint: 1 is an integer, 1.5 a number. */
export type ValueKind = "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";

const ALL_KINDS: readonly ValueKind[] = ["string", "number", "integer", "boolean", "null", "array", "object"];

/**
 * The kinds of value a schema can accept, and for arrays the kinds its items
 * can accept. It over-approximates: keywords that only narrow (`if`, bounds,
 * a `not` other than one of bare types) are ignored, so a kind outside the
 * set is never accepted.
 */
export interface AdmittedKinds {
  values: ReadonlySet<ValueKind>;
  items: ReadonlySet<ValueKind>;
}

const EVERYTHING: AdmittedKinds = { values: new Set(ALL_KINDS), items: new Set(ALL_KINDS) };
const NOTHING: AdmittedKinds = { values: new Set(), items: new Set() };

function kindsOfType(type: unknown): ValueKind[] {
  switch (type) {
    case "number":
      return ["number", "integer"];
    case "string":
    case "integer":
    case "boolean":
    case "null":
    case "array":
    case "object":
      return [type];
    default:
      return [];
  }
}

function kindOfValue(value: unknown): ValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "object";
}

const ANNOTATION_KEYWORDS = new Set(["type", "title", "description", "$comment"]);

/** The entries that can apply to a value of `kind`, each conditional when it applies to that kind only under a condition. */
function entriesFor(entries: ClosureEntry[], kind: ValueKind): ClosureEntry[] {
  const result: ClosureEntry[] = [];
  for (const entry of entries) {
    if (!entry.kinds.has(kind)) continue;
    const conditional = entry.conditionalKinds?.has(kind) ?? entry.conditional;
    result.push(conditional === entry.conditional ? entry : { ...entry, conditional });
  }
  return result;
}

const NO_KINDS: ReadonlySet<ValueKind> = new Set();

function intersect(left: ReadonlySet<ValueKind>, right: Iterable<ValueKind>): Set<ValueKind> {
  const allowed = new Set(right);
  return new Set([...left].filter((kind) => allowed.has(kind)));
}

function without(left: ReadonlySet<ValueKind>, removed: readonly ValueKind[]): Set<ValueKind> {
  return new Set([...left].filter((kind) => !removed.includes(kind)));
}

function both(left: AdmittedKinds, right: AdmittedKinds): AdmittedKinds {
  return { values: intersect(left.values, right.values), items: intersect(left.items, right.items) };
}

/** An allOf (`both`) or anyOf/oneOf (`either`) member array as a node of the kinds walk. */
interface MemberList {
  readonly members: unknown[];
  readonly combine: "both" | "either";
}

const memberListNodes = new WeakSet<object>();

function isMemberList(node: object): node is MemberList {
  return memberListNodes.has(node);
}

/** What a node's kinds combine: its own narrowing and its members' kinds (an `items` schema narrows only `items`). */
interface KindsTerms {
  readonly combine: "both" | "either";
  readonly own: AdmittedKinds;
  readonly members: readonly unknown[];
  readonly items: unknown;
  /** The object members and items: the nodes this one's kinds depend on. */
  readonly children: readonly object[];
}

function childrenOf(terms: KindsTerms | OpenApiSkip): readonly object[] {
  return terms instanceof OpenApiSkip ? [] : terms.children;
}

function termsOf(combine: "both" | "either", own: AdmittedKinds, members: readonly unknown[], items?: unknown): KindsTerms {
  const children: object[] = [];
  for (const member of members) if (isObject(member)) children.push(member);
  if (isObject(items)) children.push(items);
  return { combine, own, members, items, children };
}

/**
 * The kinds of one node while its component settles. `both`: the value
 * matches `own` and every member (an `items` member narrows only `items`).
 * `either` (anyOf/oneOf): it matches some member, so each kind is counted
 * by the members admitting it, and item kinds come from members that accept
 * arrays. Members are folded one by one, with no array of their kinds.
 */
class SettlingKinds {
  kinds: AdmittedKinds;
  private readonly values = new Map<ValueKind, number>();
  private readonly items = new Map<ValueKind, number>();

  constructor(
    private readonly terms: KindsTerms,
    read: (value: unknown) => AdmittedKinds,
  ) {
    if (terms.combine === "either") {
      for (const member of terms.members) this.count(read(member), 1);
      this.kinds = this.counted();
      return;
    }
    let result = terms.own;
    for (const member of terms.members) result = both(result, read(member));
    if (terms.items !== undefined) result = narrowItems(result, read(terms.items));
    this.kinds = result;
  }

  /** Take one occurrence of a member as narrowed from `before` to `after`; whether this node's kinds narrowed. */
  narrow(role: "member" | "items", before: AdmittedKinds, after: AdmittedKinds): boolean {
    let next: AdmittedKinds;
    if (this.terms.combine === "either") {
      this.count(before, -1);
      this.count(after, 1);
      next = this.counted();
    } else {
      // Kinds only narrow, so intersecting with the member's new kinds is the new fold.
      next = role === "items" ? narrowItems(this.kinds, after) : both(this.kinds, after);
    }
    if (sameKinds(next, this.kinds)) return false;
    this.kinds = next;
    return true;
  }

  private count(kinds: AdmittedKinds, step: number): void {
    for (const kind of kinds.values) this.values.set(kind, (this.values.get(kind) ?? 0) + step);
    if (kinds.values.has("array")) for (const kind of kinds.items) this.items.set(kind, (this.items.get(kind) ?? 0) + step);
  }

  private counted(): AdmittedKinds {
    const listed = (counts: Map<ValueKind, number>) => new Set([...counts].filter(([, count]) => count > 0).map(([kind]) => kind));
    return { values: listed(this.values), items: listed(this.items) };
  }
}

/** An `items` schema narrows the kinds of an array value's items to the kinds it admits. */
function narrowItems(kinds: AdmittedKinds, items: AdmittedKinds): AdmittedKinds {
  return { ...kinds, items: intersect(kinds.items, items.values) };
}

function sameKinds(left: AdmittedKinds, right: AdmittedKinds): boolean {
  return sameSet(left.values, right.values) && sameSet(left.items, right.items);
}

function sameSet(left: ReadonlySet<ValueKind>, right: ReadonlySet<ValueKind>): boolean {
  if (left.size !== right.size) return false;
  for (const kind of left) if (!right.has(kind)) return false;
  return true;
}
