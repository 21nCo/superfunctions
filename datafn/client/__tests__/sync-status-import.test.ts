/**
 * DATA-15: change events for imported records, including ones relayed from
 * another tab, leave the sync status's last error in place.
 */
import { describe, expect, it } from "vitest";
import { createDatafnSyncStatusController } from "../src/sync/status.js";

describe("sync status and imports", () => {
  it("keeps the last error through an import event, relayed or not", () => {
    const controller = createDatafnSyncStatusController({ mode: "sync", getOnline: () => true });
    controller.markError(new Error("push rejected"), "push");
    const base = { type: "mutation_applied" as const, resource: "notes", action: "replace", timestampMs: 1 };

    controller.handleEvent({ ...base, context: { source: "import" } });
    controller.handleEvent({ ...base, context: { source: "import" }, fromRemoteTab: true } as any);
    expect(controller.getStatus().lastError).toBe("push rejected");
    expect(controller.getStatus().lastSyncAt).toBeNull();

    controller.handleEvent({ ...base, action: "merge" });
    expect(controller.getStatus().lastError).toBeNull();
    controller.dispose?.();
  });
});
