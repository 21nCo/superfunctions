import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { contentFnAdminCapability } from "../index.js";
describe("@contentfn/admin ownership", () => {
  it("is folded into CmsFn without a second generic ContentFn operator surface", () => {
    expect(validateAdminCapabilityManifest(contentFnAdminCapability)).toEqual([]);
    expect(contentFnAdminCapability).toMatchObject({ availability: "folded", owner: { moduleId: "cmsfn" }, operations: [], navigation: [], resources: [] });
  });
});
