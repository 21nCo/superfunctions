// Type-checked by tests/openapi-document-type.test.ts (not run).
import { fromOpenAPI, type OpenApiExecutor } from "../../src/openapi/index.js";

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

// @ts-expect-error an object sharing no OpenAPI field is not a document
fromOpenAPI({ title: "not a document" }, { executor });

// @ts-expect-error a document is an object, not a primitive
fromOpenAPI(42, { executor });
