import { describe, expect, it } from "vitest";
import type { CatalogEncoding, CatalogParameter, CatalogSecurityScheme, OperationBinding } from "../src/index.js";

// Compile-time contract: each @ts-expect-error fails `npm run typecheck` once the type accepts what the runtime rejects.
// The assignments only need to typecheck; the test body checks the accepted forms are plain data.
const accepted = {
  byOperationId: { id: "projects.list", operationId: "listProjects" } satisfies OperationBinding,
  byRoute: { id: "projects.list", method: "GET", path: "/projects" } satisfies OperationBinding,
  parameterStyle: "deepObject" satisfies CatalogParameter["style"],
  encodingStyle: "form" satisfies CatalogEncoding["style"],
  scheme: { type: "oauth2", description: null, flows: { clientCredentials: { tokenUrl: "https://auth.example.test/token", scopes: [] } } } satisfies CatalogSecurityScheme,
  apiKey: { type: "apiKey", description: null, in: "header", name: "X-Api-Key" } satisfies CatalogSecurityScheme,
};

export const rejected: unknown[] = [
  // @ts-expect-error a binding needs operationId or a route
  { id: "projects.list" } satisfies OperationBinding,
  // @ts-expect-error a route binding needs both method and path
  { id: "projects.list", method: "get" } satisfies OperationBinding,
  // @ts-expect-error a route binding needs both method and path
  { id: "projects.list", path: "/projects" } satisfies OperationBinding,
  // @ts-expect-error operationId and a route are mutually exclusive
  { id: "projects.list", operationId: "listProjects", method: "get", path: "/projects" } satisfies OperationBinding,
  // @ts-expect-error unsupported parameter style
  "matrix" satisfies CatalogParameter["style"],
  // @ts-expect-error encodings use form or deepObject
  "simple" satisfies CatalogEncoding["style"],
  // @ts-expect-error unknown security scheme type
  { type: "basic", description: null } satisfies CatalogSecurityScheme,
  // @ts-expect-error apiKey locations are query, header and cookie
  { type: "apiKey", description: null, in: "body", name: "key" } satisfies CatalogSecurityScheme,
  // @ts-expect-error unknown OAuth flow
  { type: "oauth2", description: null, flows: { deviceCode: { scopes: [] } } } satisfies CatalogSecurityScheme,
];

describe("public contract types", () => {
  it("accept the forms the runtime accepts", () => {
    expect(JSON.parse(JSON.stringify(accepted))).toEqual(accepted);
    expect(rejected).toHaveLength(9);
  });
});
