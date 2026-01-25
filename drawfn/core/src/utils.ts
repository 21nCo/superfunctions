import type { Point, Bounds, Element, Camera } from './types';

export function generateId(): string {
  return `e_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function screenToCanvas(
  screenPoint: Point,
  camera: Camera,
  canvas: HTMLCanvasElement
): Point {
  const rect = canvas.getBoundingClientRect();
  const x = (screenPoint.x - rect.left - camera.x) / camera.zoom;
  const y = (screenPoint.y - rect.top - camera.y) / camera.zoom;
  return { x, y };
}

export function canvasToScreen(
  canvasPoint: Point,
  camera: Camera
): Point {
  return {
    x: canvasPoint.x * camera.zoom + camera.x,
    y: canvasPoint.y * camera.zoom + camera.y,
  };
}

export function getElementBounds(element: Element): Bounds {
  return {
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
  };
}

export function isPointInBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.w &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.h
  );
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
}

export function getViewportBounds(
  camera: Camera,
  canvas: HTMLCanvasElement
): Bounds {
  const w = canvas.width / camera.zoom;
  const h = canvas.height / camera.zoom;
  return {
    x: -camera.x / camera.zoom,
    y: -camera.y / camera.zoom,
    w,
    h,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function rotatePoint(point: Point, center: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}
