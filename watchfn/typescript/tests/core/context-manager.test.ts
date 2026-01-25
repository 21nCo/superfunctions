import { describe, it, expect, beforeEach } from "vitest";
import { ContextManager, Context } from "../src/core/context-manager";

describe("ContextManager", () => {
  let contextManager: ContextManager;

  beforeEach(() => {
    contextManager = new ContextManager();
  });

  describe("run", () => {
    it("should set and get context", async () => {
      const context: Context = {
        requestId: "req_123",
        userId: "user_456",
      };

      await contextManager.run(context, () => {
        const current = contextManager.get();
        expect(current?.requestId).toBe("req_123");
        expect(current?.userId).toBe("user_456");
      });
    });

    it("should isolate contexts", async () => {
      const context1: Context = { requestId: "req_1" };
      const context2: Context = { requestId: "req_2" };

      await Promise.all([
        contextManager.run(context1, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const current = contextManager.get();
          expect(current?.requestId).toBe("req_1");
        }),
        contextManager.run(context2, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const current = contextManager.get();
          expect(current?.requestId).toBe("req_2");
        }),
      ]);
    });
  });

  describe("tags", () => {
    it("should set and get tags", async () => {
      await contextManager.run({ requestId: "test" }, () => {
        contextManager.setTag("environment", "test");
        contextManager.setTag("version", "1.0.0");

        expect(contextManager.getTag("environment")).toBe("test");
        expect(contextManager.getTag("version")).toBe("1.0.0");
      });
    });

    it("should set multiple tags", async () => {
      await contextManager.run({ requestId: "test" }, () => {
        contextManager.setTags({
          env: "production",
          region: "us-east-1",
        });

        expect(contextManager.getTag("env")).toBe("production");
        expect(contextManager.getTag("region")).toBe("us-east-1");
      });
    });
  });

  describe("metadata", () => {
    it("should set and get metadata", async () => {
      await contextManager.run({ requestId: "test" }, () => {
        contextManager.setMetadata("user", { id: 123, name: "John" });

        const user = contextManager.getMetadata("user");
        expect(user).toEqual({ id: 123, name: "John" });
      });
    });
  });

  describe("elapsed time", () => {
    it("should track elapsed time", async () => {
      await contextManager.run({ requestId: "test" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));

        const elapsed = contextManager.getElapsedTime();
        expect(elapsed).toBeGreaterThanOrEqual(100);
      });
    });
  });

  describe("global context", () => {
    it("should merge global context with local context", async () => {
      contextManager.setGlobalContext({
        tags: { service: "api" },
      });

      await contextManager.run({ requestId: "test" }, () => {
        const current = contextManager.get();
        expect(current?.tags?.service).toBe("api");
        expect(current?.requestId).toBe("test");
      });
    });
  });
});
