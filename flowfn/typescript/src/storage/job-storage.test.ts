import { describe, it, expect } from "vitest";
import { MemoryJobStorage } from "./job-storage.js";
import { JobImpl } from "../queue/job.js";
describe("job storage integrity", () => {
  it("updates primitive payloads by replacement while merging object patches", async () => {
    const primitive = new JobImpl("task", 1); await primitive.update(2); expect(primitive.data).toBe(2);
    const object = new JobImpl("task", { a: 1, b: 2 }); await object.update({ a: 3 }); expect(object.data).toEqual({ a: 3, b: 2 });
  });
  it("isolates overlapping queue names and IDs and snapshots mutable payloads", async () => {
    const storage = new MemoryJobStorage();
    const first = new JobImpl(
      "task",
      { nested: { secret: 1 } },
      { jobId: "b:c" },
    );
    await storage.save("a", first);
    await storage.save("a:b", new JobImpl("task", 2, { jobId: "c" }));
    first.data.nested.secret = 99;
    const copy = await storage.get("a", "b:c");
    copy!.data.nested.secret = 42;
    expect((await storage.getAll("a"))[0].data).toEqual({
      nested: { secret: 1 },
    });
    expect(await storage.count("a")).toBe(1);
    await storage.clean("a", 0, "waiting");
    expect(await storage.count("a:b")).toBe(1);
  });
  it("updates deduplication lookups without stale indexes and preserves job identity", async () => {
    const storage = new MemoryJobStorage();
    await storage.save(
      "queue",
      new JobImpl("task", 1, { jobId: "id", deduplicationKey: "old" }),
    );
    await storage.update("queue", "id", {
      id: "spoof",
      opts: { deduplicationKey: "new" },
    });
    expect(await storage.existsByDeduplicationKey("queue", "old")).toBe(false);
    expect(await storage.existsByDeduplicationKey("queue", "new")).toBe(true);
    expect((await storage.get("queue", "id"))!.id).toBe("id");
    await storage.delete("queue", "id");
    expect(await storage.existsByDeduplicationKey("queue", "new")).toBe(false);
  });
});
