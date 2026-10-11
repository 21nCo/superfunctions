import { fromRouter } from "@apifn/core";
import { generateOpenApiDocument } from "@superfunctions/http-openapi";
import { describe, expect, it } from "vitest";
import { buildOperationCatalog, canonicalJson } from "../src/index.js";
import { createParityRouter, PARITY_TITLE, PARITY_VERSION } from "./parity-routes.js";
import { fixture, jsonDiff, matchFixture } from "./helpers.js";

const manifest = fixture("parity/manifest.json");

function exportBoth() {
  const router = createParityRouter();
  return {
    core: fromRouter(router as never, { info: { title: PARITY_TITLE, version: PARITY_VERSION } }),
    http: generateOpenApiDocument({ title: PARITY_TITLE, version: PARITY_VERSION, routers: [router as never] }),
  };
}

describe("exporter parity", () => {
  it("committed fixtures match both current exporters", () => {
    const { core, http } = exportBoth();
    expect(core).toEqual(matchFixture("parity/core.openapi.json", core));
    expect(http).toEqual(matchFixture("parity/http-openapi.openapi.json", http));
  });

  it("builds equivalent catalogs except for the documented exporter differences", () => {
    const core = buildOperationCatalog(fixture("parity/core.openapi.json"), manifest);
    const http = buildOperationCatalog(fixture("parity/http-openapi.openapi.json"), manifest);
    expect(core.diagnostics).toEqual([]);
    expect(http.diagnostics).toEqual([]);
    const coreCatalog = core.catalog!;
    const httpCatalog = http.catalog!;
    const index = (id: string) => coreCatalog.operations.findIndex((operation) => operation.id === id);
    expect(httpCatalog.operations.map((operation) => operation.id)).toEqual(coreCatalog.operations.map((operation) => operation.id));

    const responseDescription = (id: string, status: string) =>
      `/operations/${index(id)}/responses/${coreCatalog.operations[index(id)].responses.findIndex((response) => response.status === status)}/description`;
    expect(jsonDiff(coreCatalog, httpCatalog).sort()).toEqual(
      [
        // Different source documents always have different spec digests.
        "/source/specDigest",
        // generateOpenApiDocument cannot express query parameters.
        `/operations/${index("projects.list")}/parameters`,
        // generateOpenApiDocument names responses "HTTP <status> response"; core
        // keeps the route's response description.
        responseDescription("projects.create", "201"),
        responseDescription("projects.create", "409"),
        // generateOpenApiDocument cannot declare a body-less response; routes
        // without responseSchemas get "200 Success" where core keeps the 204.
        responseDescription("projects.delete", "204"),
        responseDescription("projects.delete", "204").replace(/description$/, "status"),
        responseDescription("projects.get", "200"),
        responseDescription("projects.get", "404"),
        responseDescription("projects.list", "200"),
      ].sort()
    );
    expect(coreCatalog.operations[index("projects.delete")].responses).toEqual([
      { status: "204", kind: "success", description: "Deleted", contents: [] },
    ]);
    expect(httpCatalog.operations[index("projects.delete")].responses).toEqual([
      { status: "200", kind: "success", description: "Success", contents: [] },
    ]);
  });

  it("takes deprecation identity from the manifest when an exporter cannot express it", () => {
    const core = fixture("parity/core.openapi.json");
    const http = fixture("parity/http-openapi.openapi.json");
    const route = "/workspaces/{workspaceId}/projects/{projectId}";
    expect(core.paths[route].delete.deprecated).toBe(true);
    expect(http.paths[route].delete.deprecated).toBeUndefined();

    const deprecations = [core, http].map((spec) =>
      canonicalJson(buildOperationCatalog(spec, manifest).catalog!.operations.find((op) => op.id === "projects.delete")!.deprecation)
    );
    expect(deprecations[0]).toBe(deprecations[1]);
    expect(JSON.parse(deprecations[0])).toMatchObject({ deprecated: true, since: "2026-09-01" });
  });
});
