import type { Element, Point, Bounds } from "./types";
import { rotatePoint } from "./utils";

export type SelectionHandlePoint = {
  type: "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | "rotate";
  point: Point;
};

export function getTupleBounds(points: Array<[number, number, number?]>): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
} {
  if (points.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      w: 0,
      h: 0,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

/**
 * Get the four corners of an element's oriented bounding box
 */
export function getOBBCorners(element: Element): [Point, Point, Point, Point] {
  const { x, y, w, h, rotation } = element;

  if (rotation === 0) {
    // Fast path for non-rotated elements
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }

  const center = { x: x + w / 2, y: y + h / 2 };
  const corners: [Point, Point, Point, Point] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];

  return corners.map((corner) => rotatePoint(corner, center, rotation)) as [
    Point,
    Point,
    Point,
    Point,
  ];
}

/**
 * Check if a point is inside an element's oriented bounding box
 */
export function isPointInOBB(point: Point, element: Element): boolean {
  const { x, y, w, h, rotation } = element;

  if (rotation === 0) {
    // Fast path for non-rotated elements (AABB)
    return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
  }

  // For rotated elements, inverse rotate the point and check against AABB
  const center = { x: x + w / 2, y: y + h / 2 };
  const rotated = rotatePoint(point, center, -rotation);

  return (
    rotated.x >= x && rotated.x <= x + w && rotated.y >= y && rotated.y <= y + h
  );
}

/**
 * Get the axis-aligned bounding box that contains the rotated element
 */
export function getOBBBounds(element: Element): Bounds {
  if (element.rotation === 0) {
    return {
      x: element.x,
      y: element.y,
      w: element.w,
      h: element.h,
    };
  }

  const corners = getOBBCorners(element);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

export function getMidpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function getSelectionHandlePoints(
  element: Element,
  zoom: number
): SelectionHandlePoint[] {
  const [nw, ne, se, sw] = getOBBCorners(element);
  const center = { x: element.x + element.w / 2, y: element.y + element.h / 2 };
  const unrotatedRotateHandle = {
    x: element.x + element.w / 2,
    y: element.y - 20 / zoom,
  };
  const rotateHandle =
    element.rotation === 0
      ? unrotatedRotateHandle
      : rotatePoint(unrotatedRotateHandle, center, element.rotation);

  return [
    { type: "nw", point: nw },
    { type: "ne", point: ne },
    { type: "sw", point: sw },
    { type: "se", point: se },
    { type: "n", point: getMidpoint(nw, ne) },
    { type: "s", point: getMidpoint(sw, se) },
    { type: "e", point: getMidpoint(ne, se) },
    { type: "w", point: getMidpoint(nw, sw) },
    { type: "rotate", point: rotateHandle },
  ];
}

/**
 * Check if a point is within a certain distance of a line segment
 */
export function isPointNearLine(
  point: Point,
  start: Point,
  end: Point,
  tolerance: number
): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length === 0) return false;

  // Calculate distance from point to line
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / (length * length)
    )
  );
  const projection = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };

  const distance = Math.sqrt(
    Math.pow(point.x - projection.x, 2) + Math.pow(point.y - projection.y, 2)
  );

  return distance <= tolerance;
}

/**
 * Check if a point is inside a polygon (for freedraw hit testing)
 */
export function isPointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}
