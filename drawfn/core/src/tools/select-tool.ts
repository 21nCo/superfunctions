import { BaseTool } from "./base-tool";
import type { Element, Point, ToolContext } from "../types";
import { screenToCanvas, isPointInBounds, getElementBounds } from "../utils";
import { isPointInOBB } from "../geometry";

type HandleType =
  | "nw"
  | "ne"
  | "sw"
  | "se"
  | "n"
  | "s"
  | "e"
  | "w"
  | "rotate"
  | null;

export class SelectTool extends BaseTool {
  name = "select";
  private dragStart: Point | null = null;
  private dragElementId: string | null = null;
  private dragHandle: HandleType = null;
  private initialBounds: { x: number; y: number; w: number; h: number } | null =
    null;

  // Marquee selection state
  private marqueeStart: Point | null = null;
  private marqueeCurrent: Point | null = null;
  private isMarqueeActive = false;

  // Double-click detection for text editing
  private lastClickTime = 0;
  private lastClickPoint: Point | null = null;
  private lastClickedElementId: string | null = null;

  handlePointerDown(
    e: PointerEvent,
    context: ToolContext,
    selectedIds: Set<string>
  ): void {
    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    for (const id of selectedIds) {
      const element = scene.elements.find((el) => el.id === id);
      if (!element) continue;

      const handle = this.getHandleAtPoint(element, point, scene.camera.zoom);
      if (handle) {
        context.recordHistory();
        this.dragStart = point;
        this.dragElementId = element.id;
        this.dragHandle = handle;
        this.initialBounds = {
          x: element.x,
          y: element.y,
          w: element.w,
          h: element.h,
        };
        return;
      }
    }

    for (let i = scene.elements.length - 1; i >= 0; i--) {
      const element = scene.elements[i];

      // Use rotation-aware hit testing
      if (isPointInOBB(point, element)) {
        // Check for double-click on text elements
        const now = Date.now();
        const isDoubleClick =
          this.lastClickedElementId === element.id &&
          now - this.lastClickTime < 300 &&
          this.lastClickPoint &&
          Math.abs(point.x - this.lastClickPoint.x) < 5 &&
          Math.abs(point.y - this.lastClickPoint.y) < 5;

        if (isDoubleClick && element.type === "text") {
          // Trigger text editing
          const drawfn = context.getDrawfn();
          if (drawfn.editTextElement) {
            drawfn.editTextElement(element.id);
          }
          return;
        }

        // Update click tracking
        this.lastClickTime = now;
        this.lastClickPoint = point;
        this.lastClickedElementId = element.id;

        context.recordHistory();
        this.dragStart = point;
        this.dragElementId = element.id;
        this.dragHandle = null;

        if (!selectedIds.has(element.id)) {
          if (!e.shiftKey) {
            selectedIds.clear();
          }
          selectedIds.add(element.id);
        }
        return;
      }
    }

    // No element hit - start marquee selection
    if (!e.shiftKey) {
      selectedIds.clear();
    }
    this.marqueeStart = point;
    this.marqueeCurrent = point;
    this.isMarqueeActive = true;
  }

  handlePointerMove(e: PointerEvent, context: ToolContext): void {
    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    // Handle marquee selection
    if (this.isMarqueeActive && this.marqueeStart) {
      this.marqueeCurrent = point;
      return;
    }

    // Handle element drag/resize
    if (!this.dragStart || !this.dragElementId) return;

    if (this.dragHandle && this.initialBounds) {
      this.handleResize(point, this.dragHandle, context);
    } else {
      const dx = point.x - this.dragStart.x;
      const dy = point.y - this.dragStart.y;

      const element = scene.elements.find((el) => el.id === this.dragElementId);
      if (element) {
        context.updateElement(this.dragElementId, {
          x: element.x + dx,
          y: element.y + dy,
        });
      }

      this.dragStart = point;
    }
  }

  handlePointerUp(e: PointerEvent, context: ToolContext): void {
    // Handle marquee selection completion
    if (this.isMarqueeActive && this.marqueeStart && this.marqueeCurrent) {
      const selection = context.getSelection();
      const elementsInMarquee = this.getElementsInMarquee(context);

      if (e.shiftKey) {
        // Add to selection
        elementsInMarquee.forEach((id) => selection.add(id));
      } else {
        // Replace selection
        selection.clear();
        elementsInMarquee.forEach((id) => selection.add(id));
      }

      this.marqueeStart = null;
      this.marqueeCurrent = null;
      this.isMarqueeActive = false;
      return;
    }

    // Handle element drag/resize completion
    this.dragStart = null;
    this.dragElementId = null;
    this.dragHandle = null;
    this.initialBounds = null;
  }

  getMarquee(): { start: Point; current: Point } | null {
    if (this.isMarqueeActive && this.marqueeStart && this.marqueeCurrent) {
      return { start: this.marqueeStart, current: this.marqueeCurrent };
    }
    return null;
  }

  private getElementsInMarquee(context: ToolContext): string[] {
    if (!this.marqueeStart || !this.marqueeCurrent) return [];

    const scene = context.getScene();
    const minX = Math.min(this.marqueeStart.x, this.marqueeCurrent.x);
    const minY = Math.min(this.marqueeStart.y, this.marqueeCurrent.y);
    const maxX = Math.max(this.marqueeStart.x, this.marqueeCurrent.x);
    const maxY = Math.max(this.marqueeStart.y, this.marqueeCurrent.y);

    const elementsInBounds: string[] = [];

    for (const element of scene.elements) {
      // Check if element's center point is within marquee bounds
      const centerX = element.x + element.w / 2;
      const centerY = element.y + element.h / 2;

      if (
        centerX >= minX &&
        centerX <= maxX &&
        centerY >= minY &&
        centerY <= maxY
      ) {
        elementsInBounds.push(element.id);
      }
    }

    return elementsInBounds;
  }

  private getHandleAtPoint(
    element: Element,
    point: Point,
    zoom: number
  ): HandleType {
    const handleSize = 8 / zoom;
    const { x, y, w, h, rotation } = element;

    // Define handles in local (unrotated) coordinates
    const localHandles = [
      { type: "nw" as HandleType, x: x, y: y },
      { type: "ne" as HandleType, x: x + w, y: y },
      { type: "sw" as HandleType, x: x, y: y + h },
      { type: "se" as HandleType, x: x + w, y: y + h },
      { type: "n" as HandleType, x: x + w / 2, y: y },
      { type: "s" as HandleType, x: x + w / 2, y: y + h },
      { type: "e" as HandleType, x: x + w, y: y + h / 2 },
      { type: "w" as HandleType, x: x, y: y + h / 2 },
      { type: "rotate" as HandleType, x: x + w / 2, y: y - 20 / zoom },
    ];

    // If element is rotated, rotate handle positions
    const handles: Array<{ type: HandleType; x: number; y: number }> =
      rotation !== 0
        ? localHandles.map((handle) => {
            const center = { x: x + w / 2, y: y + h / 2 };
            const rotated = this.rotatePoint(
              { x: handle.x, y: handle.y },
              center,
              rotation
            );
            return { type: handle.type, x: rotated.x, y: rotated.y };
          })
        : localHandles;

    for (const handle of handles) {
      const dist = Math.sqrt(
        Math.pow(point.x - handle.x, 2) + Math.pow(point.y - handle.y, 2)
      );
      if (dist < handleSize) {
        return handle.type;
      }
    }

    return null;
  }

  private rotatePoint(point: Point, center: Point, angle: number): Point {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos,
    };
  }

  private handleResize(
    point: Point,
    handle: HandleType,
    context: ToolContext
  ): void {
    if (!this.dragElementId || !this.initialBounds || !this.dragStart) return;

    const dx = point.x - this.dragStart.x;
    const dy = point.y - this.dragStart.y;

    let updates: Partial<Element> = {};

    switch (handle) {
      case "nw":
        updates = {
          x: this.initialBounds.x + dx,
          y: this.initialBounds.y + dy,
          w: Math.max(10, this.initialBounds.w - dx),
          h: Math.max(10, this.initialBounds.h - dy),
        };
        break;
      case "ne":
        updates = {
          y: this.initialBounds.y + dy,
          w: Math.max(10, this.initialBounds.w + dx),
          h: Math.max(10, this.initialBounds.h - dy),
        };
        break;
      case "sw":
        updates = {
          x: this.initialBounds.x + dx,
          w: Math.max(10, this.initialBounds.w - dx),
          h: Math.max(10, this.initialBounds.h + dy),
        };
        break;
      case "se":
        updates = {
          w: Math.max(10, this.initialBounds.w + dx),
          h: Math.max(10, this.initialBounds.h + dy),
        };
        break;
      case "n":
        updates = {
          y: this.initialBounds.y + dy,
          h: Math.max(10, this.initialBounds.h - dy),
        };
        break;
      case "s":
        updates = {
          h: Math.max(10, this.initialBounds.h + dy),
        };
        break;
      case "e":
        updates = {
          w: Math.max(10, this.initialBounds.w + dx),
        };
        break;
      case "w":
        updates = {
          x: this.initialBounds.x + dx,
          w: Math.max(10, this.initialBounds.w - dx),
        };
        break;
      case "rotate":
        const cx = this.initialBounds.x + this.initialBounds.w / 2;
        const cy = this.initialBounds.y + this.initialBounds.h / 2;
        const angle = Math.atan2(point.y - cy, point.x - cx);
        updates = { rotation: angle };
        break;
    }

    if (Object.keys(updates).length > 0) {
      context.updateElement(this.dragElementId, updates);
    }
  }
}
