import type {
  Element,
  Scene,
  Camera,
  FreeDrawElement,
  TextElement,
  ImageElement,
  ArrowElement,
  NodeElement,
  Point,
} from "./types";
import { getStroke } from "perfect-freehand";
import { getViewportBounds, boundsIntersect, getElementBounds } from "./utils";

export type RenderOptions = {
  selectedIds?: Set<string>;
  hoveredId?: string | null;
  marquee?: { start: Point; current: Point } | null;
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private imageCache: Map<string, HTMLImageElement | ImageBitmap> = new Map();
  private getImageBitmap?: (src: string) => Promise<ImageBitmap>;

  constructor(
    canvas: HTMLCanvasElement,
    getImageBitmap?: (src: string) => Promise<ImageBitmap>
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;
    this.getImageBitmap = getImageBitmap;
  }

  render(scene: Scene, options: RenderOptions = {}): void {
    const { camera, background, elements } = scene;
    const { selectedIds = new Set(), hoveredId = null } = options;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.fillStyle = background.color;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (background.grid) {
      this.renderGrid(camera, background.grid);
    }

    this.ctx.save();
    this.ctx.translate(camera.x, camera.y);
    this.ctx.scale(camera.zoom, camera.zoom);

    const viewport = getViewportBounds(camera, this.canvas);

    for (const element of elements) {
      if (element.locked && !selectedIds.has(element.id)) continue;

      const bounds = getElementBounds(element);
      if (!boundsIntersect(viewport, bounds)) continue;

      this.renderElement(element);

      if (selectedIds.has(element.id)) {
        this.renderSelectionBox(element, camera);
      } else if (hoveredId === element.id) {
        this.renderHoverHighlight(element);
      }
    }

    this.ctx.restore();

    // Render marquee selection if active
    if (options.marquee) {
      this.renderMarquee(options.marquee, camera);
    }
  }

  private renderGrid(
    camera: Camera,
    grid: { size: number; color: string; alpha: number }
  ): void {
    const { size, color, alpha } = grid;
    this.ctx.save();

    const startX = Math.floor(-camera.x / camera.zoom / size) * size;
    const startY = Math.floor(-camera.y / camera.zoom / size) * size;
    const endX = startX + this.canvas.width / camera.zoom + size;
    const endY = startY + this.canvas.height / camera.zoom + size;

    this.ctx.strokeStyle = color;
    this.ctx.globalAlpha = alpha;
    this.ctx.lineWidth = 1 / camera.zoom;

    this.ctx.beginPath();
    for (let x = startX; x < endX; x += size) {
      const screenX = x * camera.zoom + camera.x;
      this.ctx.moveTo(screenX, 0);
      this.ctx.lineTo(screenX, this.canvas.height);
    }
    for (let y = startY; y < endY; y += size) {
      const screenY = y * camera.zoom + camera.y;
      this.ctx.moveTo(0, screenY);
      this.ctx.lineTo(this.canvas.width, screenY);
    }
    this.ctx.stroke();

    this.ctx.restore();
  }

  private renderElement(element: Element): void {
    this.ctx.save();
    this.ctx.globalAlpha = element.opacity;

    if (element.rotation !== 0) {
      const cx = element.x + element.w / 2;
      const cy = element.y + element.h / 2;
      this.ctx.translate(cx, cy);
      this.ctx.rotate(element.rotation);
      this.ctx.translate(-cx, -cy);
    }

    switch (element.type) {
      case "freedraw":
        this.renderFreedraw(element);
        break;
      case "rectangle":
        this.renderRectangle(element);
        break;
      case "ellipse":
        this.renderEllipse(element);
        break;
      case "arrow":
        this.renderArrow(element);
        break;
      case "text":
        this.renderText(element);
        break;
      case "image":
        this.renderImage(element);
        break;
      case "node":
        this.renderNode(element);
        break;
    }

    this.ctx.restore();
  }

  private renderFreedraw(element: FreeDrawElement): void {
    if (element.points.length === 0) return;

    const options = {
      size: element.style?.size ?? element.strokeWidth * 2,
      thinning: element.style?.thinning ?? 0.5,
      smoothing: element.style?.smoothing ?? 0.5,
      streamline: element.style?.streamline ?? 0.5,
      taperStart: element.style?.taperStart ?? 0,
      taperEnd: element.style?.taperEnd ?? 0,
      simulatePressure: true,
    };

    const points = element.points.map((p) => [p[0], p[1], p[2] ?? 0.5]);
    const stroke = getStroke(points, options);

    this.ctx.fillStyle = element.stroke;
    this.ctx.beginPath();
    this.ctx.moveTo(stroke[0][0] + element.x, stroke[0][1] + element.y);
    for (let i = 1; i < stroke.length; i++) {
      this.ctx.lineTo(stroke[i][0] + element.x, stroke[i][1] + element.y);
    }
    this.ctx.closePath();
    this.ctx.fill();
  }

  private renderRectangle(element: Element): void {
    this.ctx.fillStyle = element.fill;
    this.ctx.strokeStyle = element.stroke;
    this.ctx.lineWidth = element.strokeWidth;

    if (element.fill !== "transparent") {
      this.ctx.fillRect(element.x, element.y, element.w, element.h);
    }
    if (element.strokeWidth > 0) {
      this.ctx.strokeRect(element.x, element.y, element.w, element.h);
    }
  }

  private renderEllipse(element: Element): void {
    this.ctx.fillStyle = element.fill;
    this.ctx.strokeStyle = element.stroke;
    this.ctx.lineWidth = element.strokeWidth;

    const cx = element.x + element.w / 2;
    const cy = element.y + element.h / 2;
    const rx = element.w / 2;
    const ry = element.h / 2;

    this.ctx.beginPath();
    this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);

    if (element.fill !== "transparent") {
      this.ctx.fill();
    }
    if (element.strokeWidth > 0) {
      this.ctx.stroke();
    }
  }

  private renderArrow(element: ArrowElement): void {
    if (element.points.length < 2) return;

    this.ctx.strokeStyle = element.stroke;
    this.ctx.fillStyle = element.stroke;
    this.ctx.lineWidth = element.strokeWidth;

    this.ctx.beginPath();
    this.ctx.moveTo(
      element.points[0][0] + element.x,
      element.points[0][1] + element.y
    );
    for (let i = 1; i < element.points.length; i++) {
      this.ctx.lineTo(
        element.points[i][0] + element.x,
        element.points[i][1] + element.y
      );
    }
    this.ctx.stroke();

    if (element.head === "triangle") {
      const last = element.points[element.points.length - 1];
      const prev = element.points[element.points.length - 2];
      const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
      const headLen = 10;

      this.ctx.beginPath();
      this.ctx.moveTo(last[0] + element.x, last[1] + element.y);
      this.ctx.lineTo(
        last[0] + element.x - headLen * Math.cos(angle - Math.PI / 6),
        last[1] + element.y - headLen * Math.sin(angle - Math.PI / 6)
      );
      this.ctx.lineTo(
        last[0] + element.x - headLen * Math.cos(angle + Math.PI / 6),
        last[1] + element.y - headLen * Math.sin(angle + Math.PI / 6)
      );
      this.ctx.closePath();
      this.ctx.fill();
    }
  }

  private renderText(element: TextElement): void {
    this.ctx.fillStyle = element.fill;
    this.ctx.strokeStyle = element.stroke;
    this.ctx.font = `${element.fontSize}px ${element.fontFamily}`;
    this.ctx.textAlign = element.align;

    const x = element.x + (element.align === "center" ? element.w / 2 : 0);
    const y = element.y + element.fontSize;

    if (element.fill !== "transparent") {
      this.ctx.fillText(element.text, x, y);
    }
    if (element.strokeWidth > 0) {
      this.ctx.lineWidth = element.strokeWidth;
      this.ctx.strokeText(element.text, x, y);
    }
  }

  private renderImage(element: ImageElement): void {
    const cached = this.imageCache.get(element.src);
    if (cached) {
      this.ctx.drawImage(cached, element.x, element.y, element.w, element.h);
    } else {
      this.loadImage(element.src);
      this.ctx.fillStyle = "#f3f4f6";
      this.ctx.fillRect(element.x, element.y, element.w, element.h);
    }
  }

  private renderNode(element: NodeElement): void {
    const radius = 8;

    this.ctx.fillStyle = element.fill;
    this.ctx.strokeStyle = element.stroke;
    this.ctx.lineWidth = element.strokeWidth;

    this.ctx.beginPath();
    this.ctx.roundRect(element.x, element.y, element.w, element.h, radius);
    if (element.fill !== "transparent") {
      this.ctx.fill();
    }
    if (element.strokeWidth > 0) {
      this.ctx.stroke();
    }

    if (element.preview?.title) {
      this.ctx.fillStyle = element.stroke;
      this.ctx.font = "14px sans-serif";
      this.ctx.textAlign = "left";
      this.ctx.fillText(element.preview.title, element.x + 12, element.y + 24);
    }
  }

  private renderSelectionBox(element: Element, camera: Camera): void {
    // Normalize sizes by zoom for consistent appearance
    const strokeWidth = 2 / camera.zoom;
    const dashPattern = 4 / camera.zoom;
    const handleSize = 6 / camera.zoom;
    const padding = 2 / camera.zoom;
    const rotateHandleDistance = 20 / camera.zoom;
    const rotateHandleRadius = 4 / camera.zoom;

    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = strokeWidth;
    this.ctx.setLineDash([dashPattern, dashPattern]);
    this.ctx.strokeRect(
      element.x - padding,
      element.y - padding,
      element.w + padding * 2,
      element.h + padding * 2
    );
    this.ctx.setLineDash([]);

    this.ctx.fillStyle = "#ffffff";
    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = 1 / camera.zoom;

    const { x, y, w, h } = element;

    const handles = [
      { x: x, y: y },
      { x: x + w, y: y },
      { x: x, y: y + h },
      { x: x + w, y: y + h },
      { x: x + w / 2, y: y },
      { x: x + w / 2, y: y + h },
      { x: x + w, y: y + h / 2 },
      { x: x, y: y + h / 2 },
    ];

    for (const handle of handles) {
      this.ctx.fillRect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize
      );
      this.ctx.strokeRect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize
      );
    }

    // Rotation handle
    this.ctx.beginPath();
    this.ctx.arc(
      x + w / 2,
      y - rotateHandleDistance,
      rotateHandleRadius,
      0,
      Math.PI * 2
    );
    this.ctx.fill();
    this.ctx.stroke();

    // Rotation handle connector line
    this.ctx.beginPath();
    this.ctx.moveTo(x + w / 2, y);
    this.ctx.lineTo(x + w / 2, y - rotateHandleDistance + rotateHandleRadius);
    this.ctx.stroke();
  }

  private renderHoverHighlight(element: Element): void {
    this.ctx.strokeStyle = "#93c5fd";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(
      element.x - 1,
      element.y - 1,
      element.w + 2,
      element.h + 2
    );
  }

  private renderMarquee(
    marquee: { start: Point; current: Point },
    camera: Camera
  ): void {
    const minX = Math.min(marquee.start.x, marquee.current.x);
    const minY = Math.min(marquee.start.y, marquee.current.y);
    const maxX = Math.max(marquee.start.x, marquee.current.x);
    const maxY = Math.max(marquee.start.y, marquee.current.y);
    const width = maxX - minX;
    const height = maxY - minY;

    this.ctx.save();
    this.ctx.translate(camera.x, camera.y);
    this.ctx.scale(camera.zoom, camera.zoom);

    // Draw semi-transparent fill
    this.ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
    this.ctx.fillRect(minX, minY, width, height);

    // Draw dashed border
    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = 1.5 / camera.zoom;
    this.ctx.setLineDash([5 / camera.zoom, 5 / camera.zoom]);
    this.ctx.strokeRect(minX, minY, width, height);
    this.ctx.setLineDash([]);

    this.ctx.restore();
  }

  private async loadImage(src: string): Promise<void> {
    if (this.imageCache.has(src)) return;

    try {
      if (this.getImageBitmap) {
        const bitmap = await this.getImageBitmap(src);
        this.imageCache.set(src, bitmap);
      } else {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = src;
        });
        this.imageCache.set(src, img);
      }
    } catch (error) {
      console.error("Failed to load image:", src, error);
    }
  }
}
