import SwaggerParser from "@apidevtools/swagger-parser";
import { parseDocument } from "yaml";
import type { OpenAPIDocument, ValidationError } from "../types.js";
import { openAPIReferenceContext, type OpenAPIReferenceMode } from "./reference-context.js";

export interface OpenAPIValidationOptions {
  /**
   * Preloaded JSON or YAML for external documents, keyed by the resolved URI or
   * absolute file path, without a fragment. Escape literal `%`, `?`, and `\\`
   * within path segments as `%25`, `%3F`, and `%5C`. Within preloaded documents, use slash-delimited
   * `#/` pointers. Validation never reads files or URLs.
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
  location: DocumentLocation;
}

interface DocumentLocation {
  url: URL;
  isPath: boolean;
  isWindowsPath: boolean;
}

interface ReferenceTarget {
  value: unknown;
  mode: OpenAPIReferenceMode;
  source: ReferenceDocument;
}

interface PointerLookup {
  tokens: string[];
  target: ReferenceTarget | "reference" | undefined;
}

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

const LOCAL_PATH_ORIGIN = "https://apifn-local-path.invalid";
const WINDOWS_DRIVE_PATH = /^[a-z]:\//i;

function workingDirectoryLocation(): DocumentLocation {
  const cwd = typeof process !== "undefined" && process.cwd ? process.cwd().replaceAll("\\", "/") : "/";
  const path = (cwd.startsWith("/") ? cwd : "/" + cwd).replace(/\/$/, "") + "/";
  const url = new URL(LOCAL_PATH_ORIGIN);
  url.pathname = path.split("/").map(encodeURIComponent).join("/");
  return { url, isPath: true, isWindowsPath: WINDOWS_DRIVE_PATH.test(cwd) };
}

function absolutePathKey(pathname: string): string {
  // Decode filesystem names without letting a segment become a path separator
  // or a query. Escape percent signs so literal "%3F" and "?" cannot collide.
  return pathname.split("/").map((segment) =>
    decodeFragment(segment).replaceAll("%", "%25").replaceAll("?", "%3F").replaceAll("/", "%2F").replaceAll("\\", "%5C")
  ).join("/");
}

function resolveDocumentURI(base: DocumentLocation, ref: string) {
  const normalized = ref.replaceAll("\\", "/");
  const windowsDrive = WINDOWS_DRIVE_PATH.test(normalized);
  const url = windowsDrive ? new URL("/" + normalized, LOCAL_PATH_ORIGIN) : new URL(normalized, base.url);
  const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(normalized.trimStart());
  const fragment = url.hash.slice(1);
  url.hash = "";
  const isPath = windowsDrive || (base.isPath && !absolute && url.origin === base.url.origin);
  const queryStart = url.href.indexOf("?");
  const query = queryStart < 0 ? "" : url.href.slice(queryStart);
  const pathname = isPath ? absolutePathKey(url.pathname) : undefined;
  const uri = pathname === undefined ? url.href : pathname + query;
  const pathWithoutLeadingSlash = pathname?.slice(1);
  const isWindowsPath = pathWithoutLeadingSlash !== undefined && (windowsDrive || base.isWindowsPath) &&
    WINDOWS_DRIVE_PATH.test(pathWithoutLeadingSlash);
  const windowsPath = isWindowsPath ? pathWithoutLeadingSlash : undefined;
  const keys = windowsPath === undefined
    ? [uri]
    : [windowsPath + query, windowsPath.replaceAll("/", "\\") + query];
  return { uri: keys[0], fragment, keys, location: { url, isPath, isWindowsPath } };
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
  const root: ReferenceDocument = { value: document, location: workingDirectoryLocation() };
  const supplied = new Map<string, ReferenceDocument>();
  const literalReferences = new Map<object, string>();
  const seen = new WeakMap<object, Map<OpenAPIReferenceMode, object>>();
  const pending: Array<ReferenceTarget & { value: object; copy: object }> = [];
  let field = "x-apifn-reference-copies";
  while (Object.hasOwn(document, field)) field += "-";
  const referenceCopies: ReferenceCopies = { field, targets: [], originals: new Map() };
  const copiedPointers = new Map<ReferenceDocument, Map<string, string>>();
  const aliasTargets = new WeakMap<object, ReferenceTarget>();

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

    const { uri: key, fragment, keys, location: targetLocation } = resolveDocumentURI(source.location, ref);
    let external = supplied.get(key);
    if (!external) {
      const contents = keys.map((candidate) => externalReferences.get(candidate)).find((value) => value !== undefined);
      if (contents === undefined) throw new Error(EXTERNAL_REF_ERROR);
      const parsed = parseDocument(contents);
      if (parsed.errors.length) throw new Error(parsed.errors[0].message);
      // Alias instances retain their object identity, so copying named targets
      // does not expand the alias graph.
      external = { value: parsed.toJS({ maxAliasCount: -1 }), location: targetLocation };
      supplied.set(key, external);
    }
    return { source: external, fragment };
  }

  function pointerTarget(
    source: ReferenceDocument, tokens: string[], aliases: Set<object>, directAlias?: object
  ): PointerLookup {
    let value = source.value;
    let mode: OpenAPIReferenceMode = "node";
    const matched: string[] = [];
    const unresolved = (index: number, target?: "reference"): PointerLookup =>
      ({ tokens: [...matched, ...tokens.slice(index)], target });
    for (let index = 0; index < tokens.length; index += 1) {
      // Follow aliases before looking up remaining tokens, keeping siblings
      // that Swagger Parser gives precedence over the referenced object.
      const chain = new Set(aliases);
      const overrides = new Map<string, { value: unknown; source: ReferenceDocument }>();
      while (typeof value === "object" && value !== null && mode !== "literal" &&
          !openAPIReferenceContext.isMap(mode) && "$ref" in value && typeof value.$ref === "string" && value.$ref) {
        // A reference can point into its own siblings. Following a cycle
        // through other aliases cannot provide a concrete object to traverse.
        if (chain.has(value)) {
          if (value === directAlias) break;
          throw new Error("Circular OpenAPI $ref aliases cannot be traversed");
        }
        chain.add(value);
        let target = aliasTargets.get(value);
        if (!target) {
          const alias = location(source, value.$ref);
          const lookup = lookupPointer(alias.source, alias.fragment, chain, value);
          if (!lookup.target || lookup.target === "reference") return unresolved(index, "reference");
          target = lookup.target;
          // Both pointer spellings can reach this same alias.
          aliasTargets.set(value, target);
        }
        if (target.value === value) break;
        for (const [key, sibling] of Object.entries(value)) {
          if (key !== "$ref" && !overrides.has(key)) {
            overrides.set(key, { value: sibling, source });
          }
        }
        if (mode === "node" && target.mode === "example") mode = "example";
        source = target.source;
        value = target.value;
      }
      if (typeof value !== "object" || value === null) return unresolved(index);
      const parent = overrides.size
        ? { ...value, ...Object.fromEntries([...overrides].map(([key, entry]) => [key, entry.value])) }
        : value;
      // A preloaded value can be a standalone Example Object outside the
      // OpenAPI examples maps that normally establish its context.
      if (source !== root && mode === "node" && isStandaloneExample(parent)) mode = "example";
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
      if (!Object.hasOwn(parent, key)) {
        if (value === root.value && key === field) throw new Error("OpenAPI $ref target does not exist");
        return unresolved(index);
      }
      matched.push(key);
      const child: unknown = Reflect.get(parent, key);
      source = overrides.get(key)?.source ?? source;
      mode = referenceChildMode(parent, mode, key, child);
      value = child;
    }
    return { tokens: matched, target: { value, mode, source } };
  }

  function lookupPointer(
    source: ReferenceDocument, fragment: string, aliases = new Set<object>(), directAlias?: object
  ): PointerLookup {
    if (fragment === "") return { tokens: [], target: { value: source.value, mode: "node", source } };
    if (source === root && fragment.startsWith("/")) {
      const legacy = fragment.split("/").slice(1).map((token) => decodeFragment(unescapePointerToken(token)));
      const legacyLookup = pointerTarget(source, legacy, aliases, directAlias);
      if (legacyLookup.target || !/%2f/i.test(fragment)) return legacyLookup;
      const decoded = decodeFragment(fragment).split("/").slice(1).map(unescapePointerToken);
      const decodedLookup = pointerTarget(source, decoded, aliases, directAlias);
      return decodedLookup.target ? decodedLookup : legacyLookup;
    }
    const decoded = decodeFragment(fragment);
    if (!decoded.startsWith("/") || (source !== root && !fragment.startsWith("/"))) {
      throw new Error("OpenAPI $ref fragments must be slash-delimited JSON pointers");
    }
    const tokens = decoded.split("/").slice(1).map(unescapePointerToken);
    return pointerTarget(source, tokens, aliases, directAlias);
  }

  function rewriteReference(ref: string, source: ReferenceDocument, mode: OpenAPIReferenceMode): string {
    const destination = location(source, ref);
    const { tokens, target } = lookupPointer(destination.source, destination.fragment);
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
