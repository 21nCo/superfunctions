import { describe, expect, it } from "vitest";
import { getOAuthProviderDescriptor, listOAuthProviderDescriptors } from "../index.js";

describe("oauth-providers exports", () => {
  it("returns known providers", () => {
    expect(getOAuthProviderDescriptor("google").id).toBe("google");
    expect(listOAuthProviderDescriptors().length).toBeGreaterThan(0);
  });
});
