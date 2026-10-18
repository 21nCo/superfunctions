import { installCanvasMocks } from "../../testing/canvas";

if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
installCanvasMocks();
