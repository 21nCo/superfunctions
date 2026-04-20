import { cleanup } from "@testing-library/svelte";
import { afterEach, vi } from "vitest";

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

HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => {
  return {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}) as any;

HTMLCanvasElement.prototype.toBlob = vi.fn(function (callback: BlobCallback) {
  callback(new Blob(["mock"], { type: "image/png" }));
}) as any;

globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
}) as any;

globalThis.cancelAnimationFrame = vi.fn() as any;

afterEach(() => {
  cleanup();
  Object.values(mockContext).forEach((value) => {
    if (typeof value === "function" && "mockClear" in value) {
      value.mockClear();
    }
  });
});
