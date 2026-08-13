import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { apiFnAdminCapability } from "../index.js";
describe("@apifn/admin availability", () => {
  it("fails closed until ApiFn owns a canonical persistent operator service", () => {
    expect(validateAdminCapabilityManifest(apiFnAdminCapability)).toEqual([]);
    expect(apiFnAdminCapability).toMatchObject({ availability: "unavailable", operations: [], navigation: [], resources: [] });
    expect(apiFnAdminCapability.unavailableReason).toMatch(/no canonical persistent operator store\/service/i);
  });
});
