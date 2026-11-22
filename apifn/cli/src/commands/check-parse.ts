/**
 * The one parser `apifn check` uses for every contract document: the committed spec, the base
 * spec (git, file or HTTP) and the generated head (read back from the YAML `apifn generate`
 * writes). A document passes only when its JSON form is faithful and bounded:
 *
 * - at most MAX_SPEC_BYTES of UTF-8 text, one YAML 1.2 (or JSON) document, a mapping at the root;
 * - expanded with every alias replaced by its anchored node, at most MAX_EXPANDED_SPEC_NODES
 *   nodes and MAX_EXPANDED_SPEC_BYTES of scalar text (measured before anything is converted);
 * - no duplicate or colliding mapping keys (`1` and `"1"`, an alias key naming a literal key
 *   beside it), no merge keys, no collection keys, no alias cycles;
 * - numbers finite, and each literal naming an integer (`9007199254740993`, `9007199254740993.0`,
 *   `9.007199254740993e15`) the double it reads as (exactly, or as its shortest round-trip
 *   decimal), so no value changes on the way to JSON;
 * - only strings, numbers, booleans, null, sequences and mappings (no binary, sets or dates).
 *
 * Any violation throws ContractParseError; each caller decides what it means (committed: drift,
 * base: load error, head: invalid spec).
 */

import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { Alias, Document, Node as YamlNode, Pair } from "yaml";

/** Largest contract text read from a file, git or HTTP. */
export const MAX_SPEC_BYTES = 32 * 1024 * 1024;
/**
 * Largest number of nodes a document may expand to. The yaml package's own guard
 * (`maxAliasCount: 100`) rejects specs `apifn generate` writes for routers that reuse one object
 * many times, so the check bounds the expanded size instead: linear to measure, far above any
 * real spec.
 */
export const MAX_EXPANDED_SPEC_NODES = 5_000_000;
/** Largest amount of scalar text (UTF-16 code units) a document may expand to. */
export const MAX_EXPANDED_SPEC_BYTES = 64 * 1024 * 1024;

export class ContractParseError extends Error {}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const PARSE_OPTIONS = {
  schema: "core",
  version: "1.2",
  merge: false,
  uniqueKeys: true,
  intAsBigInt: true,
  prettyErrors: false,
} as const;

/** Parses contract text (YAML or JSON) into its faithful JSON value. */
export function parseContract(raw: string): JsonObject {
  const size = Buffer.byteLength(raw, "utf8");
  if (size > MAX_SPEC_BYTES) {
    throw new ContractParseError(`the document is ${size} bytes (limit ${MAX_SPEC_BYTES})`);
  }
  const doc = parseDocument(raw, PARSE_OPTIONS);
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    throw new ContractParseError(problem.message);
  }
  const declared = doc.directives?.yaml;
  if (declared?.explicit && declared.version !== "1.2") {
    throw new ContractParseError(`the document declares %YAML ${declared.version}; only YAML 1.2 is read`);
  }
  if (!isMap(doc.contents)) {
    throw new ContractParseError("the document is not a mapping");
  }
  const anchors = resolveAliases(doc);
  measure(doc.contents, anchors);
  return new Converter(anchors).value(doc.contents, "$") as JsonObject;
}

/** Each alias resolves to the last node with its anchor before it in document order. */
function resolveAliases(doc: Document): Map<Alias, YamlNode> {
  const latest = new Map<string, YamlNode>();
  const targets = new Map<Alias, YamlNode>();
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      const target = latest.get(node.source);
      if (!target) throw new ContractParseError(`unresolved alias *${node.source}`);
      targets.set(node, target);
    } else if ((isMap(node) || isSeq(node) || isScalar(node)) && node.anchor) {
      latest.set(node.anchor, node);
    }
  });
  return targets;
}

interface Size {
  nodes: number;
  bytes: number;
}

/** Measures the expanded document (aliases counted every time they appear) against the budgets. */
function measure(root: YamlNode, anchors: Map<Alias, YamlNode>): void {
  new Measurer(anchors).size(root);
}

class Measurer {
  private readonly sizes = new Map<unknown, Size>();
  private readonly open = new Set<unknown>();

  constructor(private readonly anchors: Map<Alias, YamlNode>) {}

  size(node: unknown): Size {
    if (node === null || node === undefined) return { nodes: 0, bytes: 0 };
    const known = this.sizes.get(node);
    if (known) return known;
    if (this.open.has(node)) throw new ContractParseError("the YAML aliases form a cycle");
    this.open.add(node);
    const total = this.measureNode(node);
    this.open.delete(node);
    this.sizes.set(node, total);
    return total;
  }

  private measureNode(node: unknown): Size {
    if (isAlias(node)) return this.add({ nodes: 0, bytes: 0 }, this.size(this.anchors.get(node)));
    if (isPair(node)) return this.add(this.add({ nodes: 0, bytes: 0 }, this.size(node.key)), this.size(node.value));
    if (isMap(node) || isSeq(node)) {
      const total = { nodes: 1, bytes: 0 };
      for (const item of node.items) this.add(total, this.size(item));
      return total;
    }
    const value = isScalar(node) ? node.value : undefined;
    return { nodes: 1, bytes: typeof value === "string" ? value.length : 8 };
  }

  private add(total: Size, part: Size): Size {
    total.nodes += part.nodes;
    total.bytes += part.bytes;
    if (total.nodes > MAX_EXPANDED_SPEC_NODES) {
      throw new ContractParseError(`the YAML aliases expand to more than ${MAX_EXPANDED_SPEC_NODES} nodes`);
    }
    if (total.bytes > MAX_EXPANDED_SPEC_BYTES) {
      throw new ContractParseError(
        `the YAML aliases expand to more than ${MAX_EXPANDED_SPEC_BYTES} characters of text`
      );
    }
    return total;
  }
}

class Converter {
  private readonly done = new Map<YamlNode, JsonValue>();

  constructor(private readonly anchors: Map<Alias, YamlNode>) {}

  value(node: unknown, at: string): JsonValue {
    if (node === null || node === undefined) return null;
    if (isAlias(node)) return this.value(this.anchors.get(node), at);
    if (isScalar(node)) return scalarValue(node.value, at, node.source);
    const known = this.done.get(node as YamlNode);
    if (known !== undefined) return known;
    let result: JsonValue;
    if (isSeq(node)) {
      result = node.items.map((item, index) => this.value(item, `${at}[${index}]`));
    } else if (isMap(node)) {
      result = this.mapping(node.items as Pair[], at);
    } else {
      throw new ContractParseError(`${at} is not a YAML scalar, sequence or mapping`);
    }
    this.done.set(node as YamlNode, result);
    return result;
  }

  private mapping(pairs: Pair[], at: string): JsonObject {
    const record: JsonObject = {};
    const aliased = new Map<string, string>();
    for (const pair of pairs) {
      const key = this.key(pair.key, at);
      if (Object.hasOwn(record, key.text)) {
        const via = key.via || aliased.get(key.text) || "";
        throw new ContractParseError(`${at} has two keys that are both "${key.text}" in JSON${via}`);
      }
      if (key.via) aliased.set(key.text, key.via);
      // defineProperty keeps a "__proto__" key as data.
      Object.defineProperty(record, key.text, {
        value: this.value(pair.value, `${at}.${key.text}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return record;
  }

  private key(node: unknown, at: string): { text: string; via: string } {
    const via = isAlias(node) ? ` (one is the alias *${node.source})` : "";
    const target = isAlias(node) ? this.anchors.get(node) : node;
    if (!isScalar(target)) {
      throw new ContractParseError(`${at} has a mapping key that is not a scalar${via}`);
    }
    if (!isAlias(node) && target.type === "PLAIN" && target.value === "<<") {
      throw new ContractParseError(`${at} has a YAML merge key (<<), which is not supported`);
    }
    const value = scalarValue(target.value, `${at} key`, target.source);
    if (typeof value === "string") return { text: value, via };
    if (typeof value === "number") return { text: String(value), via };
    throw new ContractParseError(`${at} has a ${value === null ? "null" : typeof value} key, which JSON cannot represent`);
  }
}

/** The exact integer a decimal literal names, or null when it names no integer (or is no decimal). */
function integerOf(literal: string): bigint | null {
  const match = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(literal);
  if (!match) return null;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (digits === "") return 0n;
  // Linear scan for the trailing zeros (a /0+$/ search restarts at every zero run: quadratic).
  let end = digits.length;
  while (digits.codePointAt(end - 1) === 0x30) end -= 1;
  const scale = Number(exponent) - fraction.length + (digits.length - end);
  // A finite double is below 10^309, so an integer with more digits cannot name one.
  if (scale < 0 || end + scale > 400) return null;
  const value = BigInt(digits.slice(0, end)) * 10n ** BigInt(scale);
  return sign === "-" ? -value : value;
}

/**
 * True when the integer `exact` is the double `number` reads as: exactly, or as that double's
 * shortest round-trip decimal (what JSON.stringify and `apifn generate` write, such as
 * 9223372036854776000 for 2^63 or 1e+23). 9007199254740993 names neither, so readers disagree on it.
 */
function holdsInteger(exact: bigint, number: number): boolean {
  return BigInt(number) === exact || integerOf(String(number)) === exact;
}

function scalarValue(value: unknown, at: string, source?: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isFinite(number) || !holdsInteger(value, number)) {
      throw new ContractParseError(`${at} is the integer ${value}, which a JSON number does not hold exactly`);
    }
    return number;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractParseError(`${at} is ${value}, which JSON cannot represent`);
    }
    // A float literal naming an integer (9007199254740993.0) follows the integer rule; any other
    // float literal reads as the same double in every JSON reader.
    const exact = source === undefined ? null : integerOf(source);
    if (exact !== null && !holdsInteger(exact, value)) {
      throw new ContractParseError(`${at} is the integer ${exact} (written ${source}), which a JSON number does not hold exactly`);
    }
    return value;
  }
  const kind = (value as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? typeof value;
  throw new ContractParseError(`${at} is a ${kind}, which JSON cannot represent`);
}

/** Code-unit order, the order JSON.stringify-based canonical forms conventionally use. */
function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item) ?? null);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A null-prototype object keeps an own "__proto__" key as data instead of a prototype change.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record).sort(compareKeys)) {
      const item = canonicalize(record[key]);
      if (item !== undefined) sorted[key] = item;
    }
    return sorted;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  return value;
}

/** Canonical JSON: keys sorted at every level, values JSON drops (undefined) removed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? null));
}
