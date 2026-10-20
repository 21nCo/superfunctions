import { describe, expect, it, vi } from "vitest";
import { Drawfn } from "../src/drawfn";
import { MAX_FREEDRAW_POINTS } from "../src/utils";
import type { FreeDrawElement } from "../src/types";

describe("pen point capacity", () => {
  it.each(["pointerup", "pointercancel"])("bounds a full stroke, emits one limit error and preserves %s semantics", completion => {
    const canvas = document.createElement("canvas"); document.body.append(canvas); const api = new Drawfn({ canvas }); api.setTool("pen");
    const dispatch = (type: string) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: 10, clientY: 10, bubbles: true }));
    dispatch("pointerdown");
    // Seed a valid full stroke to exercise overflow/completion without quadratic
    // setup from replaying every intermediate 16,384-point snapshot.
    const points: FreeDrawElement["points"] = Array.from({ length: MAX_FREEDRAW_POINTS }, (_, i) => [i, i, 0.5]);
    const tool = (api as unknown as { toolManager: { getTool(name: string): { currentPoints: FreeDrawElement["points"] } } }).toolManager.getTool("pen");
    tool.currentPoints = points;
    api.update(api.getElements()[0].id, { points });
    const error = vi.fn(); api.on("error", error);
    for (let i = 0; i < 50; i++) dispatch("pointermove");
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "SCENE_LIMIT_EXCEEDED" }));
    expect(tool.currentPoints).toHaveLength(MAX_FREEDRAW_POINTS);
    expect((api.getElements()[0] as FreeDrawElement).points).toHaveLength(MAX_FREEDRAW_POINTS);
    dispatch(completion); expect(tool.currentPoints).toHaveLength(0);
    if (completion === "pointerup") { expect(api.getHistoryState().depth).toBe(1); api.undo(); }
    else expect(api.getHistoryState().depth).toBe(0);
    expect(api.getElements()).toHaveLength(0);
    dispatch("pointerdown"); dispatch("pointermove"); dispatch("pointerup");
    expect((api.getElements()[0] as FreeDrawElement).points).toHaveLength(2); api.destroy(); canvas.remove();
  });
});
