/**
 * DATA-15: the merge-outcome contract every storage adapter that sets
 * `capabilities.reportsMergeOutcome` meets. Shared by the adapter tests.
 */
import { expect, it } from "vitest";
import type { DatafnStorageAdapter } from "../src/storage.js";

export function describeMergeOutcomeContract(getStorage: () => DatafnStorageAdapter): void {
  it("reports whether the merge created the record", async () => {
    const storage = getStorage();
    const outcomes: boolean[] = [];
    const onResolved = ({ created }: { created: boolean }) => outcomes.push(created);
    await storage.mergeRecord("task", "m1", { title: "a" }, { onResolved });
    await storage.mergeRecord("task", "m1", { title: "b" }, { onResolved });
    expect(outcomes).toEqual([true, false]);
  });

  it("completes the merge when the outcome callback throws", async () => {
    const storage = getStorage();
    const onResolved = () => {
      throw new Error("listener failed");
    };
    await expect(storage.mergeRecord("task", "m2", { title: "a" }, { onResolved })).resolves.toMatchObject({
      id: "m2",
      title: "a",
    });
    expect(await storage.getRecord("task", "m2")).toMatchObject({ title: "a" });
  });
}
