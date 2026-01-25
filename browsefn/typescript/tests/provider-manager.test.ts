/**
 * Tests for provider manager
 */

import { describe, it, expect } from "vitest";
import { ProviderManager } from "../src/core/provider-manager.js";

class MockProvider {
  constructor(
    public name: string,
    private available: boolean = true
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

describe("ProviderManager", () => {
  it("should get provider by name", async () => {
    const manager = new ProviderManager("p1", ["p2", "p3"]);
    manager.register("p1", new MockProvider("p1") as any);
    manager.register("p2", new MockProvider("p2") as any);

    const provider = manager.get("p1");
    expect(provider?.name).toBe("p1");
  });

  it("should construct fallback chain correctly", async () => {
    const manager = new ProviderManager("p1", ["p2", "p3"]);
    manager.register("p1", new MockProvider("p1") as any);
    manager.register("p2", new MockProvider("p2") as any);
    manager.register("p3", new MockProvider("p3") as any);

    const chain = manager.getFallbackChain("p3");
    expect(chain).toEqual(["p3", "p1", "p2"]);
  });

  it("should check provider availability", async () => {
    const manager = new ProviderManager();
    manager.register("available", new MockProvider("available", true) as any);
    manager.register(
      "unavailable",
      new MockProvider("unavailable", false) as any
    );

    expect(await manager.isAvailable("available")).toBe(true);
    expect(await manager.isAvailable("unavailable")).toBe(false);
  });

  it("should execute with fallback", async () => {
    const manager = new ProviderManager("failing", ["working"]);
    manager.register("failing", new MockProvider("failing", false) as any);
    manager.register("working", new MockProvider("working", true) as any);

    const result = await manager.executeWithFallback(
      "failing",
      async (provider: any, name: string) => {
        if (provider.name === "failing") {
          throw new Error("Provider failed");
        }
        return `Success from ${name}`;
      }
    );

    expect(result).toBe("Success from working");
  });

  it("should list available providers", async () => {
    const manager = new ProviderManager();
    manager.register("p1", new MockProvider("p1", true) as any);
    manager.register("p2", new MockProvider("p2", false) as any);
    manager.register("p3", new MockProvider("p3", true) as any);

    const available = await manager.listAvailable();
    expect(available).toEqual(["p1", "p3"]);
  });
});
