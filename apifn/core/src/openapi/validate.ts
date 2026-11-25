import SwaggerParser from "@apidevtools/swagger-parser";
import { parseDocument } from "yaml";
import type { OpenAPIDocument, ValidationError } from "../types.js";
import { openAPIReferenceContext, type OpenAPIReferenceMode } from "./reference-context.js";

export interface OpenAPIValidationOptions {
  /**
   * Preloaded JSON or YAML for external documents, keyed by the resolved URI or
   * absolute file path, without a fragment. Within those documents, use
   * slash-delimited `#/` pointers. Validation never reads files or URLs.
   */
  externalReferences?: ReadonlyMap<string, string>;
}

const EXTERNAL_REF_ERROR = "External OpenAPI $ref requires an explicit allowlist entry";

function referenceChildMode(
  parent: object, mode: OpenAPIReferenceMode, key: string, child: unknown
): OpenAPIReferenceMode {
  const { childMode, entryMode, arrayItemMode } = openAPIReferenceContext;
  if (Array.isArray(parent)) return arrayItemMode(mode);
  if (mode === "literal" || mode === "example") return "literal";
  return entryMode(mode, key, child) ?? childMode(key, child);
}

interface ReferenceDocument {
  value: unknown;
  uri: string;
}

interface ReferenceTarget {
  value: unknown;
  mode: OpenAPIReferenceMode;
  source: ReferenceDocument;
}

type PointerLookup = ReferenceTarget | "reference" | undefined;

interface ReferenceCopies {
  field: string;
  targets: unknown[];
  originals: Map<string, string>;
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function encodePointer(tokens: string[]): string {
  return "#" + tokens.map((token) =>
    "/" + encodeURIComponent(token.replaceAll("~", "~0").replaceAll("/", "~1"))
  ).join("");
}

function resolveDocumentURI(base: string, ref: string): { uri: string; fragment: string } {
  const normalized = ref.replaceAll("\\", "/");
  const isPath = base.startsWith("/");
  const pathBase = new URL("https://apifn-local-path.invalid");
  if (isPath) pathBase.pathname = base.split("/").map(encodeURIComponent).join("/");
  const url = new URL(normalized, isPath ? pathBase : base);
  const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(normalized.trimStart());
  const fragment = url.hash.slice(1);
  const uri = isPath && !absolute && url.origin === pathBase.origin
    ? decodeFragment(url.pathname) + url.search
    : url.href.split("#", 1)[0];
  return { uri, fragment };
}

const EXAMPLE_FIELDS = new Set(["value", "externalValue", "summary", "description"]);

function isStandaloneExample(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.hasOwn(value, "value") || Object.hasOwn(value, "externalValue")) &&
    Object.keys(value).every((key) => EXAMPLE_FIELDS.has(key) || key.startsWith("x-"));
}

function restoreReferenceCopies(document: object, { field, targets, originals }: ReferenceCopies): void {
  if (!originals.size) return;
  const seen = new WeakSet<object>();
  const pending: unknown[] = [document];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    // A reference to the root with sibling fields can copy the temporary slot.
    if (Reflect.get(value, field) === targets) Reflect.deleteProperty(value, field);
    if ("$ref" in value && typeof value.$ref === "string") {
      const original = originals.get(value.$ref);
      if (original !== undefined) value.$ref = original;
    }
    for (const child of Object.values(value)) pending.push(child);
  }
}

function prepareReferences(document: OpenAPIDocument, externalReferences?: ReadonlyMap<string, string>) {
  const cwd = typeof process !== "undefined" && process.cwd ? process.cwd().replaceAll("\\", "/") : "/";
  const uri = (cwd.startsWith("/") ? cwd : "/" + cwd).replace(/\/$/, "") + "/";
  const root: ReferenceDocument = { value: document, uri };
  const supplied = new Map<string, ReferenceDocument>();
  const literalReferences = new Map<object, string>();
  const seen = new WeakMap<object, Map<OpenAPIReferenceMode, object>>();
  const pending: Array<ReferenceTarget & { value: object; copy: object }> = [];
  let field = "x-apifn-reference-copies";
  while (Object.hasOwn(document, field)) field += "-";
  const referenceCopies: ReferenceCopies = { field, targets: [], originals: new Map() };
  const copiedPointers = new Map<ReferenceDocument, Map<string, string>>();

  function enqueue(value: unknown, mode: OpenAPIReferenceMode, source: ReferenceDocument): unknown {
    if (typeof value !== "object" || value === null) return value;
    const contexts = seen.get(value) ?? new Map<OpenAPIReferenceMode, object>();
    const existing = contexts.get(mode);
    if (existing) return existing;

    // YAML aliases can share a value between a schema and literal example data.
    const prototype = Object.getPrototypeOf(value);
    const copy = Array.isArray(value) ? [...value]
      : prototype === Object.prototype || prototype === null ? { ...value } : value;
    contexts.set(mode, copy);
    seen.set(value, contexts);
    pending.push({ value, copy, mode, source });
    return copy;
  }

  function location(source: ReferenceDocument, ref: string): { source: ReferenceDocument; fragment: string } {
    if (ref.startsWith("#")) return { source, fragment: ref.slice(1) };
    if (!externalReferences?.size) throw new Error(EXTERNAL_REF_ERROR);

    const { uri: key, fragment } = resolveDocumentURI(source.uri, ref);
    let external = supplied.get(key);
    if (!external) {
      const contents = externalReferences.get(key);
      if (contents === undefined) throw new Error(EXTERNAL_REF_ERROR);
      const parsed = parseDocument(contents);
      if (parsed.errors.length) throw new Error(parsed.errors[0].message);
      // Alias instances retain their object identity, so copying named targets
      // does not expand the alias graph.
      external = { value: parsed.toJS({ maxAliasCount: -1 }), uri: key };
      supplied.set(key, external);
    }
    return { source: external, fragment };
  }

  function pointerTarget(
    source: ReferenceDocument, tokens: string[], aliases: Set<object>
  ): PointerLookup {
    let value = source.value;
    let mode: OpenAPIReferenceMode = "node";
    for (let index = 0; index < tokens.length; index += 1) {
      // A preloaded value can be a standalone Example Object outside the
      // OpenAPI examples maps that normally establish its context.
      if (source !== root && mode === "node" && isStandaloneExample(value)) mode = "example";
      // Follow aliases before looking up remaining tokens, keeping siblings
      // that Swagger Parser gives precedence over the referenced object.
      const chain = new Set(aliases);
      const overrides = new Map<string, { value: unknown; source: ReferenceDocument }>();
      while (typeof value === "object" && value !== null && mode !== "literal" &&
          !openAPIReferenceContext.isMap(mode) && "$ref" in value && typeof value.$ref === "string" && value.$ref) {
        // A root alias can point to one of its own sibling definitions.
        if (chain.has(value)) break;
        chain.add(value);
        const alias = location(source, value.$ref);
        const { target } = lookupPointer(alias.source, alias.fragment, chain);
        if (!target || target === "reference") return "reference";
        for (const [key, sibling] of Object.entries(value)) {
          if (key !== "$ref" && !overrides.has(key)) {
            overrides.set(key, { value: sibling, source });
          }
        }
        source = target.source;
        value = target.value;
      }
      if (typeof value !== "object" || value === null) return undefined;
      const parent = overrides.size
        ? { ...value, ...Object.fromEntries([...overrides].map(([key, entry]) => [key, entry.value])) }
        : value;
      let key = tokens[index];
      if (!Object.hasOwn(parent, key) || Reflect.get(parent, key) === undefined ||
          (index === tokens.length - 1 && Reflect.get(parent, key) === null)) {
        for (let end = tokens.length; end > index + 1; end -= 1) {
          const joined = tokens.slice(index, end).join("/");
          if (Object.hasOwn(parent, joined) && Reflect.get(parent, joined) !== undefined) {
            key = joined;
            index = end - 1;
            break;
          }
        }
      }
      if (!Object.hasOwn(parent, key)) return undefined;
      const child: unknown = Reflect.get(parent, key);
      source = overrides.get(key)?.source ?? source;
      mode = referenceChildMode(parent, mode, key, child);
      value = child;
    }
    return { value, mode, source };
  }

  function lookupPointer(
    source: ReferenceDocument, fragment: string, aliases = new Set<object>()
  ): { tokens: string[]; target: PointerLookup } {
    if (fragment === "") return { tokens: [], target: { value: source.value, mode: "node", source } };
    if (fragment.startsWith("/")) {
      const legacy = fragment.split("/").slice(1).map((token) => decodeFragment(unescapePointerToken(token)));
      const target = pointerTarget(source, legacy, aliases);
      if (target || source !== root || !/%2f/i.test(fragment)) return { tokens: legacy, target };
      const decoded = decodeFragment(fragment).split("/").slice(1).map(unescapePointerToken);
      const decodedTarget = pointerTarget(source, decoded, aliases);
      return decodedTarget ? { tokens: decoded, target: decodedTarget } : { tokens: legacy, target };
    }
    const decoded = decodeFragment(fragment);
    if (source !== root || !decoded.startsWith("/")) {
      throw new Error("OpenAPI $ref fragments must be slash-delimited JSON pointers");
    }
    const tokens = decoded.split("/").slice(1).map(unescapePointerToken);
    return { tokens, target: pointerTarget(source, tokens, aliases) };
  }

  function rewriteReference(ref: string, source: ReferenceDocument, mode: OpenAPIReferenceMode): string {
    const destination = location(source, ref);
    const { tokens, target } = lookupPointer(destination.source, destination.fragment);
    if (destination.source === root && tokens[0] === field) {
      throw new Error("OpenAPI $ref target does not exist");
    }
    const canonical = encodePointer(tokens);
    const isLocal = destination.source === root;
    if (!target || target === "reference") {
      if (isLocal) return canonical; // Let Swagger Parser report local missing or circular pointers.
      throw new Error("OpenAPI $ref target does not exist");
    }
    if (isLocal && target.source === root &&
        (target.mode !== "literal" || typeof target.value !== "object" || target.value === null)) {
      return canonical;
    }

    // Place imported targets and schemas that refer into a literal payload in
    // their own context, so Swagger Parser never sees the literal references.
    const pointers = copiedPointers.get(destination.source) ?? new Map<string, string>();
    const key = mode + canonical;
    const existing = pointers.get(key);
    if (existing) return existing;
    const preparedRef = "#/" + field + "/" + referenceCopies.targets.length;
    pointers.set(key, preparedRef);
    copiedPointers.set(destination.source, pointers);
    referenceCopies.originals.set(preparedRef, isLocal ? canonical : ref);
    referenceCopies.targets.push(enqueue(target.value, mode, target.source));
    return preparedRef;
  }

  const copy = enqueue(root.value, "node", root) as OpenAPIDocument;
  while (pending.length) {
    const { value, copy, mode, source } = pending.pop()!;
    if ("$ref" in value && typeof value.$ref === "string") {
      if (mode === "literal") {
        literalReferences.set(copy, value.$ref);
        Reflect.deleteProperty(copy, "$ref");
      } else if (value.$ref && !openAPIReferenceContext.isMap(mode)) {
        Reflect.set(copy, "$ref", rewriteReference(value.$ref, source, mode));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") continue;
      Reflect.set(copy, key, enqueue(child, referenceChildMode(value, mode, key, child), source));
    }
  }
  if (referenceCopies.targets.length) Reflect.set(copy, field, referenceCopies.targets);
  return { copy, referenceCopies, literalReferences };
}

function toValidationErrors(error: unknown): ValidationError[] {
  const details = (error as { details?: Array<{ path?: string | string[]; message?: string }> })
    ?.details;

  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => ({
      path: Array.isArray(detail.path)
        ? detail.path.join(".")
        : detail.path || "openapi",
      message: detail.message || "Validation error",
      severity: "error",
    }));
  }

  const message = error instanceof Error ? error.message : "Validation error";
  return [
    {
      path: "openapi",
      message,
      severity: "error",
    },
  ];
}

export async function validateOpenAPI(
  document: OpenAPIDocument,
  options?: OpenAPIValidationOptions
): Promise<ValidationError[]> {
  return (await validateAndDereferenceOpenAPI(document, options)).errors;
}

/** Validates and returns a dereferenced copy for callers that compare or store it. */
export async function validateAndDereferenceOpenAPI(
  document: OpenAPIDocument,
  options?: OpenAPIValidationOptions
): Promise<{ document: OpenAPIDocument; errors: [] } | { document: null; errors: ValidationError[] }> {
  try {
    const { copy, referenceCopies, literalReferences } = prepareReferences(
      structuredClone(document), options?.externalReferences,
    );
    // Prepared pointers address the copy and need a parser base independent
    // of filesystem characters in the working directory.
    const validated = await SwaggerParser.validate("/apifn-validation/openapi.json", copy as never, {
      resolve: { external: false, file: false, http: false },
    });
    restoreReferenceCopies(validated, referenceCopies);
    for (const [literal, ref] of literalReferences) Reflect.set(literal, "$ref", ref);
    return { document: validated as unknown as OpenAPIDocument, errors: [] };
  } catch (error) {
    return { document: null, errors: toValidationErrors(error) };
  }
}
