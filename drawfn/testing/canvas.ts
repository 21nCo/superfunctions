import { vi } from "vitest";
import { canvasBounds } from "./create-canvas";

export function installCanvasMocks(framework = false) {
  const mockContext = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    ellipse: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })),
  };

  HTMLCanvasElement.prototype.getContext = vi.fn((contextId: string) => {
    if (contextId === "2d") {
      return mockContext as any;
    }
    return null;
  }) as any;

  if (framework) HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(canvasBounds);

  HTMLCanvasElement.prototype.toBlob = vi.fn(function (callback: BlobCallback) {
    callback(new Blob(["mock"], { type: "image/png" }));
  }) as any;

  if (framework) globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as any;

  if (framework) globalThis.cancelAnimationFrame = vi.fn() as any;


  return mockContext;
}
