import { describe, expect, it, vi } from "vitest";
import { Drawfn } from "../src/drawfn";
import type { RectangleElement } from "../src/types";
const rectangle: RectangleElement = { id: "one", type: "rectangle", x: 1, y: 2, w: 10, h: 10, rotation: 0, stroke: "black", fill: "red", strokeWidth: 0, opacity: 1 };

describe("clear history contract", () => {
  it("clears as one undoable mutation with ordered element/selection/history/scene events", () => {
    const api = new Drawfn({ canvas: document.createElement("canvas") });
    api.add(rectangle); api.add({ ...rectangle, id: "two" }); api.setSelection(["one", "two"]);
    const previous = api.getScene(); const depth = api.getHistoryState().depth; const events: string[] = [];
    api.on("elementRemoved", id => events.push(`remove:${id}`));
    api.on("selectionChanged", () => events.push("selection")); api.on("historyChanged", () => events.push("history"));
    api.on("sceneChanged", event => events.push(`scene:${event.reason}`));
    api.clear(); expect(api.getElements()).toEqual([]); expect(api.getHistoryState().depth).toBe(depth + 1);
    expect(events).toEqual(["remove:one", "remove:two", "selection", "history", "scene:clear"]);
    api.undo(); expect(api.getScene()).toEqual(previous); expect(api.getSelectedIds()).toEqual([]);
    api.redo(); expect(api.getElements()).toEqual([]); api.destroy();
  });

  it("does not add snapshots or scene events for repeated empty clears and resetHistory retains content", () => {
    const api = new Drawfn({ canvas: document.createElement("canvas") }); const changed = vi.fn(); api.on("sceneChanged", changed);
    const initial = api.getScene(); api.clear(); api.clear(); expect(api.getScene()).toEqual(initial); expect(changed).not.toHaveBeenCalled();
    api.add(rectangle); const content = api.getScene(); api.resetHistory();
    expect(api.getScene()).toEqual(content); expect(api.getHistoryState()).toEqual({ canUndo: false, canRedo: false, depth: 0 });
    api.clear(); api.resetHistory(); api.undo(); expect(api.getElements()).toEqual([]); api.destroy();
  });

  it("closes a provisional text editor before clearing so late blur cannot restore text", () => {
    const canvas = document.createElement("canvas"); const root = document.createElement("div"); document.body.append(root);
    const api = new Drawfn({ canvas, overlayRoot: root }); api.add(rectangle); api.setTool("text");
    canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }));
    const textarea = root.querySelector("textarea")!; textarea.value = "pending";
    api.clear(); expect(root.querySelector("textarea")).toBeNull(); textarea.dispatchEvent(new Event("blur"));
    expect(api.getElements()).toEqual([]); api.undo(); expect(api.getElements()).toEqual([rectangle]); api.destroy(); root.remove();
  });
});
