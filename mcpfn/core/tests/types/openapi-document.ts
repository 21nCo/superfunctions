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

// @ts-expect-error a document is an object, not a primitive
fromOpenAPI(42, { executor });
