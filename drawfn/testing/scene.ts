import type { Scene } from "../core/src/types";

export function createScene(): Scene {
  return {
    version: 1,
    id: "scene-1",
    camera: { x: 0, y: 0, zoom: 1 },
    background: { color: "#ffffff" },
    elements: [rectangle("rect-1")],
  };
}

export function rectangle(id: string) {
  return {
    id,
    type: "rectangle" as const,
    x: 10,
    y: 20,
    w: 80,
    h: 40,
    rotation: 0,
    stroke: "#000000",
    fill: "transparent" as const,
    strokeWidth: 2,
    opacity: 1,
  };
}
