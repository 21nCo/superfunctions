import { describe, expect, it } from "vitest";
import { getOAuthProviderDescriptor, listOAuthProviderDescriptors } from "../index.js";

describe("oauth-providers exports", () => {
  it("returns known providers", () => {
    expect(getOAuthProviderDescriptor("google").id).toBe("google");
    expect(listOAuthProviderDescriptors().length).toBeGreaterThan(0);
  });

  it("returns cloned provider descriptors so callers cannot mutate shared registry state", () => {
    const descriptor = getOAuthProviderDescriptor("google");
    descriptor.defaultScopes.push("mutated");
    descriptor.extraAuthParams = { prompt: "consent" };

    expect(getOAuthProviderDescriptor("google").defaultScopes).toEqual(["openid", "email", "profile"]);
    expect(getOAuthProviderDescriptor("google").extraAuthParams).toBeUndefined();
  });
});
