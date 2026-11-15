/**
 * DATA-15: search index updates for one provider and resource run one at a
 * time, in the order they were queued, and a failure does not block the rest.
 */
import { describe, expect, it } from "vitest";
import { runSearchIndexUpdate } from "../src/searchIndexQueue.js";

describe("runSearchIndexUpdate", () => {
  it("runs updates for a resource in order and resources independently", async () => {
    const provider = {};
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = runSearchIndexUpdate(provider, "notes", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      log.push("notes 1");
    });
    const second = runSearchIndexUpdate(provider, "notes", async () => {
      log.push("notes 2");
    });
    const other = runSearchIndexUpdate(provider, "tags", async () => {
      log.push("tags");
    });
    await other;
    expect(log).toEqual(["tags"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(["tags", "notes 1", "notes 2"]);
  });

  it("keeps running queued updates after one fails", async () => {
    const provider = {};
    const failed = runSearchIndexUpdate(provider, "notes", async () => {
      throw new Error("index unavailable");
    });
    const next = runSearchIndexUpdate(provider, "notes", async () => "done");
    await expect(failed).rejects.toThrow("index unavailable");
    await expect(next).resolves.toBe("done");
  });
});
