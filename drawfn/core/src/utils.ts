import type {
  Point,
  Bounds,
  Element,
  Camera,
  DrawfnError,
  DrawfnErrorCode,
} from './types';

export const MIN_CAMERA_ZOOM = 0.1;
export const MAX_CAMERA_ZOOM = 5;
export const MAX_SCENE_ELEMENTS = 2000;
export const MAX_FREEDRAW_POINTS = 16384;

export function generateId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `e_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createDrawfnError(
  code: DrawfnErrorCode,
  message: string,
  details?: Record<string, unknown>,
  recoverable = true
): DrawfnError {
  if (details && Object.keys(details).length > 0) {
    return { code, message, details, recoverable };
  }

  return { code, message, recoverable };
}

export function screenToCanvas(
  screenPoint: Point,
  camera: Camera,
  canvas: HTMLCanvasElement
): Point {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  const x = ((screenPoint.x - rect.left) * scaleX - camera.x) / camera.zoom;
  const y = ((screenPoint.y - rect.top) * scaleY - camera.y) / camera.zoom;
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
