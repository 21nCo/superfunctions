/**
 * How a value is read: `node` (an OpenAPI or schema object, whose keys are keywords), `names` (a
 * map from names to nodes, such as `properties`), `extNames` (a names map that also takes `x-`
 * extensions: Paths and Responses), `components`, `examples` (a map of Example Objects), `example`
 * (one Example Object or its `$ref`), `links` and `link` (Link Objects, whose `parameters` and
 * `requestBody` are data), `objects` and `object` (a map of, or one, OpenAPI object that may be a
 * Reference Object: a Parameter, Response, Request Body, Header, Security Scheme or Callback),
 * `extObjects` (Responses: `objects` that also take `x-` extensions) or `literal` (data). A Callback
 * Object is an `object`: its `x-` keys are data and its expressions Path Items.
 */
export type OpenAPIReferenceMode =
  | "node" | "names" | "extNames" | "objects" | "extObjects" | "object" | "components" | "examples" | "example" | "links" | "link"
  | "literal";

/** Modes whose `$ref` is a Reference Object: only `summary` and `description` beside it apply. */
const REFERENCE_MODES = new Set<OpenAPIReferenceMode>(["object", "example", "link"]);
/** Maps whose entries may be Reference Objects (not Schema Objects). */
const OBJECT_MAPS = new Set(["parameters", "requestBodies", "headers", "securitySchemes", "callbacks", "responses"]);

/** Keywords whose value maps names (any string, `default` and `$ref` included) to nodes. */
const NAME_MAPS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "schemas", "links", "pathItems",
  "paths", "webhooks", "content", "encoding", "variables",
]);
/** Keywords whose value is data. */
const LITERALS = new Set(["example", "default", "const", "enum"]);

/** How the value under `key` of a node is read. */
function childMode(key: string, value: unknown): OpenAPIReferenceMode {
  if (LITERALS.has(key) || key.startsWith("x-")) return "literal";
  if (key === "examples") return Array.isArray(value) ? "literal" : "examples";
  if (key === "components") return "components";
  if (key === "links") return "links";
  if (key === "paths") return "extNames";
  if (key === "responses") return "extObjects";
  if (key === "requestBody") return "object";
  if (OBJECT_MAPS.has(key)) return "objects";
  return NAME_MAPS.has(key) ? "names" : "node";
}

/** How the value under `key` of a map read in `mode` is read (null: `mode` is not a map). */
function entryMode(mode: OpenAPIReferenceMode, key: string, value: unknown): OpenAPIReferenceMode | null {
  switch (mode) {
    case "names":
      return "node";
    case "extNames":
      return key.startsWith("x-") ? "literal" : "node";
    case "objects":
      return "object";
    case "extObjects":
      return key.startsWith("x-") ? "literal" : "object";
    case "components":
      if (key.startsWith("x-")) return "literal";
      if (key === "examples" || key === "links") return key;
      return OBJECT_MAPS.has(key) ? "objects" : "names";
    case "examples":
      return "example";
    case "links":
      return "link";
    case "link":
      return key === "parameters" || key === "requestBody" ? "literal" : childMode(key, value);
    default:
      return null;
  }
}

const MAP_MODES = new Set<OpenAPIReferenceMode>(["names", "extNames", "objects", "extObjects", "components", "examples", "links"]);
/** How the items of an array read in a map mode are read. */
const MAP_ITEMS: Partial<Record<OpenAPIReferenceMode, OpenAPIReferenceMode>> = { names: "node", extNames: "node", objects: "object", extObjects: "object" };

export const openAPIReferenceContext = Object.freeze({
  childMode,
  entryMode,
  isReferenceObject: (mode: OpenAPIReferenceMode) => REFERENCE_MODES.has(mode),
  isMap: (mode: OpenAPIReferenceMode) => MAP_MODES.has(mode),
  arrayItemMode: (mode: OpenAPIReferenceMode) => MAP_ITEMS[mode] ?? mode,
});
