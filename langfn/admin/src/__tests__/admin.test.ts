import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { langFnAdminCapability } from "../index.js";
describe("@langfn/admin availability", () => {
  it("fails closed until LangFn owns its operator registries", () => {
    expect(validateAdminCapabilityManifest(langFnAdminCapability)).toEqual([]);
    expect(langFnAdminCapability).toMatchObject({ availability: "unavailable", operations: [], navigation: [], resources: [] });
    expect(langFnAdminCapability.unavailableReason).toMatch(/no canonical persistent operator registry/i);
  });
});
