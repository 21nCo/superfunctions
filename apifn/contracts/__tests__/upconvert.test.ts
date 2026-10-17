import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { buildOperationCatalog, clone, fixture } from "./helpers.js";
import { describeUpconvertParity } from "./upconvert-rows.js";

describeUpconvertParity("with the workspace @apifn/core");

describe("OpenAPI 3.0 upconversion through reference chains", () => {
  const nullable = (version: string) => (version === "3.0.3" ? { type: "string", nullable: true } : { type: ["string", "null"] });
  /** The catalog fixture with a query parameter on GET /health referencing `#/x-c1`, then `x-c1` ... `x-c<links>`, then the target. */
  const chained = (version: string, links: number, extra: (spec: Record<string, any>) => void = () => {}) => {
    const spec = clone(fixture("catalog/openapi.json"));
    spec.openapi = version;
    spec.paths["/health"].get.parameters = [{ $ref: "#/x-c1" }];
    for (let link = 1; link < links; link += 1) spec[`x-c${link}`] = { $ref: `#/x-c${link + 1}` };
    spec[`x-c${links}`] = { $ref: "#/x-target" };
    spec["x-target"] = { name: "probe", in: "query", schema: nullable(version) };
    extra(spec);
    return spec;
  };
  const build = (spec: Record<string, any>) => buildOperationCatalog(spec, clone(fixture("catalog/manifest.json")));
  const expectParity = (make: (version: string) => Record<string, any>) => {
    const current = build(make("3.1.0"));
    for (const input of [make("3.0.3"), JSON.stringify(make("3.0.3")), stringify(make("3.0.3"))]) {
      expect(canonicalJson(buildOperationCatalog(input, clone(fixture("catalog/manifest.json"))))).toBe(canonicalJson(current));
    }
    return current;
  };

  it("follows a chain of 32 objects, the longest deref reads", () => {
    const current = expectParity((version) => chained(version, 30));
    expect(current.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const health = current.catalog!.operations.find((operation) => operation.id === "system.health")!;
    expect(health.parameters.find((parameter) => parameter.name === "probe")!.schema).toEqual({ type: ["string", "null"] });
  });

  it("reports a chain of 33 objects and a cycle the same way for 3.0 and 3.1, without throwing", () => {
    expect(expectParity((version) => chained(version, 31)).diagnostics.map((diagnostic) => diagnostic.code)).toContain("UNRESOLVED_REF");
    const cyclic = expectParity((version) => chained(version, 2, (spec) => (spec["x-c2"] = { $ref: "#/x-c1" })));
    expect(cyclic.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UNRESOLVED_REF");
  });

  it("follows a reference fully when a shorter chain reaches it after a longer one stopped at it", () => {
    // From components.parameters.Long, x-c31 is the 32nd object, so the walk stops there; the
    // response header chain below reaches x-c31 later, as the 2nd object of its chain.
    const shorter = (spec: Record<string, any>) => {
      spec.components.parameters.Long = { $ref: "#/x-c1" };
      spec.paths["/health"].get.parameters = [];
      spec.paths["/health"].get.responses["200"].headers = { "X-Probe": { $ref: "#/x-h1" } };
      const hops = 34;
      for (let link = 1; link <= hops; link += 1) {
        const next = link === hops ? "#/x-c31" : `#/x-h${link + 1}`;
        spec[`x-h${link}`] = { content: { "text/plain": { schema: { type: "string" }, encoding: { a: { headers: { H: { $ref: next } } } } } } };
      }
    };
    const current = expectParity((version) => chained(version, 32, shorter));
    expect(current.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });
});
