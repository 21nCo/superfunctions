import { beforeEach, describe, expect, it, vi } from "vitest";
import { Drawfn } from "../src/drawfn";

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return canvas;
}

describe("text editing", () => {
  let canvas: HTMLCanvasElement;
  let overlayRoot: HTMLDivElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = createCanvas();
    overlayRoot = document.createElement("div");
    document.body.appendChild(overlayRoot);
    drawfn = new Drawfn({ canvas, overlayRoot });
  });

  it("re-editing an existing text element commits through the standard update pipeline", () => {
    drawfn.add({
      id: "text-1",
      type: "text",
      x: 100,
      y: 100,
      w: 200,
      h: 40,
      rotation: 0,
      stroke: "#000000",
      fill: "#000000",
      strokeWidth: 0,
      opacity: 1,
      text: "hello",
      fontFamily: "sans-serif",
      fontSize: 16,
      align: "left",
    });

    const events: string[] = [];
    const historyDepths: number[] = [];
    drawfn.on("elementUpdated", () => events.push("elementUpdated"));
    drawfn.on("historyChanged", (event) => {
      events.push("historyChanged");
      historyDepths.push(event.depth);
    });
    drawfn.on("sceneChanged", event => events.push(`sceneChanged:${event.reason}`));

    drawfn.editTextElement("text-1");

    const textarea = overlayRoot.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    textarea.value = "hello world";
    textarea.dispatchEvent(new Event("blur"));

    const element = drawfn.getElementById("text-1");
    expect(element?.type).toBe("text");
    expect((element as any).text).toBe("hello world");
    expect(events).toEqual(["elementUpdated", "historyChanged", "sceneChanged:text-commit"]);
    expect(historyDepths[historyDepths.length - 1]).toBe(2);
  });

  it("empty provisional text removes the provisional element and destroy cleans overlay state", () => {
    drawfn.setTool("text");

    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 120,
        clientY: 140,
        pointerId: 1,
        bubbles: true,
      })
    );

    const textarea = overlayRoot.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(drawfn.getScene().elements).toHaveLength(1);

    textarea.value = "   ";
    textarea.dispatchEvent(new Event("blur"));

    expect(drawfn.getScene().elements).toHaveLength(0);
    expect(overlayRoot.querySelector("textarea")).toBeNull();

    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 180,
        clientY: 180,
        pointerId: 2,
        bubbles: true,
      })
    );
    expect(overlayRoot.querySelector("textarea")).not.toBeNull();

    drawfn.destroy();

    expect(overlayRoot.querySelector("textarea")).toBeNull();

    const removeDocumentClickListener = vi.spyOn(document, "removeEventListener");
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 220,
        clientY: 220,
        pointerId: 3,
        bubbles: true,
      })
    );
    expect(removeDocumentClickListener).not.toHaveBeenCalledWith(
      "click",
      expect.any(Function)
    );
    removeDocumentClickListener.mockRestore();
  });
  it("commits new text with text-commit reason and exactly one undo step", () => {
    const changed = vi.fn(); drawfn.on("sceneChanged", changed); drawfn.setTool("text");
    canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
    const textarea = overlayRoot.querySelector("textarea")!; textarea.value = "new text"; textarea.dispatchEvent(new Event("blur"));
    expect(changed).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledWith(expect.objectContaining({ reason: "text-commit" }));
    expect(drawfn.getHistoryState().depth).toBe(1); drawfn.undo(); expect(drawfn.getElements()).toEqual([]);
    drawfn.redo(); expect(drawfn.getElements()[0]).toMatchObject({ text: "new text" }); drawfn.destroy();
  });

});
