import { describe, expect, it } from "vitest";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { botFnAdminCapability } from "../index.js";
describe("@botfn/admin availability", () => {
  it("fails closed until BotFn owns a unified operator service", () => {
    expect(validateAdminCapabilityManifest(botFnAdminCapability)).toEqual([]);
    expect(botFnAdminCapability).toMatchObject({ availability: "unavailable", operations: [], navigation: [], resources: [] });
    expect(botFnAdminCapability.unavailableReason).toMatch(/no canonical aggregate/i);
  });
});
