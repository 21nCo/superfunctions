// Type-checked by tests/openapi-document-type.test.ts (not run).
import { fromOpenAPI, type OpenApiDocument, type OpenApiExecutor } from "../../src/openapi/index.js";

declare const executor: OpenApiExecutor;

// The shape @apifn/core's fromRouter() returns: an interface whose only index
// signature covers `x-*` keys (mirrored so the test has no apifn dependency).
interface RouterDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  [key: `x-${string}`]: unknown;
}
declare const routerDocument: RouterDocument;
fromOpenAPI(routerDocument, { executor });

// A document parsed from JSON or YAML.
declare const parsed: Record<string, unknown>;
fromOpenAPI(parsed, { executor });
fromOpenAPI(JSON.parse("{}") as unknown as { openapi: string; paths: object }, { executor });

// A fresh literal with standard top-level fields and x-* extensions.
fromOpenAPI(
  {
    openapi: "3.1.0",
    info: { title: "example", version: "1.0.0" },
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    servers: [{ url: "https://api.example.test" }],
    paths: {},
    webhooks: {},
    components: { schemas: {} },
    security: [],
    tags: [{ name: "pets" }],
    externalDocs: { url: "https://docs.example.test" },
    "x-internal": true,
  },
  { executor },
);

// A document type declared as a plain interface, without an index signature.
interface PlainDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
}
declare const plainDocument: PlainDocument;
fromOpenAPI(plainDocument, { executor });

// With the context type given explicitly the standard fields are still accepted.
fromOpenAPI<undefined>({ openapi: "3.0.3", info: { title: "t", version: "1" }, servers: [], paths: {} }, { executor });

// x-* extensions are accepted where the document type is named: with the
// context type given explicitly, and on a literal annotated as OpenApiDocument.
fromOpenAPI<undefined>({ openapi: "3.1.0", paths: {}, "x-internal": true }, { executor });
const annotated: OpenApiDocument = { openapi: "3.1.0", paths: {}, "x-generated-by": "test" };
fromOpenAPI(annotated, { executor });
// @ts-expect-error a top-level field outside the standard set and x-* is still refused there
fromOpenAPI<undefined>({ openapi: "3.1.0", title: "misplaced" }, { executor });

// The operation given to name() and to the executor is deeply frozen, and typed read-only.
fromOpenAPI(parsed, {
  executor: {
    execute({ operation }) {
      // @ts-expect-error read-only
      operation.path = "/changed";
      // @ts-expect-error read-only
      operation.parameters[0]!.name = "changed";
      // @ts-expect-error read-only
      operation.servers[0]!.url = "https://changed.example.test";
      return { content: [{ type: "text", text: operation.path }] };
    },
  },
  name(operation) {
    // @ts-expect-error read-only
    operation.tags.push("changed");
    // @ts-expect-error read-only
    operation.requestBody!.contentType = "text/plain";
    return operation.operationId ?? operation.path;
  },
});

// @ts-expect-error an object sharing no OpenAPI field is not a document
fromOpenAPI({ title: "not a document" }, { executor });

// @ts-expect-error a document is an object, not a primitive
fromOpenAPI(42, { executor });

// Explicit-context calls also accept producer interfaces without an index
// signature, fromRouter-style interfaces and parsed records.
fromOpenAPI<undefined>(plainDocument, { executor });
fromOpenAPI<undefined>(routerDocument, { executor });
fromOpenAPI<undefined>(parsed, { executor });
const namedRouter: OpenApiDocument = routerDocument;
const namedParsed: OpenApiDocument = parsed;
fromOpenAPI(namedRouter, { executor });
fromOpenAPI<undefined>(namedParsed, { executor });
// @ts-expect-error a value sharing no standard field is refused
fromOpenAPI<undefined>({ title: "misplaced" }, { executor });

// The named type stays extensible, and x-* fields read as unknown.
interface ConsumerDocument extends OpenApiDocument {
  readonly "x-generated": string;
}
declare const consumerDocument: ConsumerDocument;
fromOpenAPI(consumerDocument, { executor });
const generated: string = consumerDocument["x-generated"];
const extension: unknown = annotated["x-generated-by"];
void generated;
void extension;
