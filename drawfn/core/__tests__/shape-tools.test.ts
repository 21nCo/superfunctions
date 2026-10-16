import { describe, expect, it } from "vitest";
import { Drawfn } from "../src/drawfn";
import { createCanvas } from "../../testing/create-canvas";

describe.each(["rectangle", "ellipse"] as const)("%s gestures", type => {
  it.each([false, true])("normalizes reverse drags with shift=%s and supports undo", shiftKey => {
    const canvas = createCanvas();
    const drawing = new Drawfn({ canvas });
    try {
      drawing.setTool(type);
      const pointer = (event: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(event, {
        clientX: x, clientY: y, shiftKey, bubbles: true, button: 0,
      }));
      pointer("pointerdown", 100, 100);
      pointer("pointermove", 60, 80);
      pointer("pointerup", 60, 80);
      expect(drawing.getScene().elements).toHaveLength(1);
      expect(drawing.getScene().elements[0]).toMatchObject({
        type, x: 60, y: shiftKey ? 60 : 80, w: 40, h: shiftKey ? 40 : 20,
      });
      drawing.undo();
      expect(drawing.getScene().elements).toHaveLength(0);
      drawing.redo();
      expect(drawing.getScene().elements[0].type).toBe(type);
    } finally { drawing.destroy(); }
  });

  it("discards click-only shapes and resets the next gesture", () => {
    const canvas = createCanvas();
    const drawing = new Drawfn({ canvas });
    try {
      drawing.setTool(type);
      for (const event of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(event, {
        clientX: 20, clientY: 20, bubbles: true, button: 0,
      }));
      expect(drawing.getScene().elements).toHaveLength(0);
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 100, bubbles: true }));
      expect(drawing.getScene().elements).toHaveLength(0);
    } finally { drawing.destroy(); }
  });
});
