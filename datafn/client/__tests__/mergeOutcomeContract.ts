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
    let called = false;
    const onResolved = () => {
      called = true;
      throw new Error("listener failed");
    };
    await expect(storage.mergeRecord("task", "m2", { title: "a" }, { onResolved })).resolves.toMatchObject({
      id: "m2",
      title: "a",
    });
    expect(called).toBe(true);
    expect(await storage.getRecord("task", "m2")).toMatchObject({ title: "a" });
  });
}

export function describeChangelogLastSeqContract(getStorage: () => DatafnStorageAdapter): void {
  it("reports the largest changelog sequence number", async () => {
    const storage = getStorage();
    expect(await storage.changelogLastSeq!()).toBeNull();
    const entry = (mutationId: string) => ({
      clientId: "c1",
      mutationId,
      mutation: { resource: "task", id: "t1" },
      timestampMs: 0,
      timestamp: "",
    });
    await storage.changelogAppend(entry("m1") as any);
    const last = await storage.changelogAppend(entry("m2") as any);
    expect(await storage.changelogLastSeq!()).toBe(last.seq);
    await storage.changelogAck({ throughSeq: last.seq });
    expect(await storage.changelogLastSeq!()).toBeNull();
  });
}
