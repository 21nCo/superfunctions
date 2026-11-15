/**
 * DATA-15: change events for imported records, including ones relayed from
 * another tab, leave the sync status's last error in place.
 */
import { describe, expect, it } from "vitest";
import { createDatafnSyncStatusController } from "../src/sync/status.js";
import { IMPORT_CONTEXT } from "../src/events/importMarker.js";

describe("sync status and imports", () => {
  it("keeps the last error through an import event, relayed or not", () => {
    const controller = createDatafnSyncStatusController({ mode: "sync", getOnline: () => true });
    controller.markError(new Error("push rejected"), "push");
    const base = { type: "mutation_applied" as const, resource: "notes", action: "replace", timestampMs: 1 };

    controller.handleEvent({ ...base, context: IMPORT_CONTEXT });
    controller.handleEvent({ ...base, context: IMPORT_CONTEXT, fromRemoteTab: true } as any);
    expect(controller.getStatus().lastError).toBe("push rejected");
    expect(controller.getStatus().lastSyncAt).toBeNull();

    controller.handleEvent({ ...base, action: "merge" });
    expect(controller.getStatus().lastError).toBeNull();
    controller.dispose?.();
  });

  it("treats a mutation whose own context looks like the marker as a normal write", () => {
    const controller = createDatafnSyncStatusController({ mode: "sync", getOnline: () => true });
    controller.markError(new Error("push rejected"), "push");
    controller.handleEvent({
      type: "mutation_applied",
      resource: "notes",
      action: "merge",
      timestampMs: 1,
      context: { source: "import" },
    });
    expect(controller.getStatus().lastError).toBeNull();
    controller.dispose?.();
  });

  it("keeps the marker unchanged when a subscriber tries to modify it", () => {
    expect(Object.isFrozen(IMPORT_CONTEXT)).toBe(true);
    expect(() => {
      (IMPORT_CONTEXT as { source: string }).source = "edited";
    }).toThrow(TypeError);
    expect(IMPORT_CONTEXT.source).toBe("import");
  });
});
