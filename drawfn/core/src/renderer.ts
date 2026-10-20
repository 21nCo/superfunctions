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
  DrawfnError,
} from "./types";
import { getStroke } from "perfect-freehand";
import {
  getViewportBounds,
  boundsIntersect,
  getElementBounds,
  createDrawfnError,
} from "./utils";
import {
  getMidpoint,
  getOBBBounds,
  getOBBCorners,
  getSelectionHandlePoints,
} from "./geometry";

export type RenderOptions = {
  selectedIds?: Set<string>;
  hoveredId?: string | null;
  marquee?: { start: Point; current: Point } | null;
};

export class Renderer {
  private disposed = false;
  private activeImageSources = new Set<string>();
  private capacityErrors = new Set<string>();
  private readonly maxImageEntries = 64;
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private imageCache: Map<string, HTMLImageElement | ImageBitmap> = new Map();
  private pendingImageLoads: Map<
    string,
    Promise<HTMLImageElement | ImageBitmap>
  > = new Map();
  private getImageBitmap?: (src: string) => Promise<ImageBitmap>;
  private onImageLoaded?: (src: string) => void;
  private onImageError?: (error: DrawfnError, src: string) => void;

  constructor(
    canvas: HTMLCanvasElement,
    getImageBitmap?: (src: string) => Promise<ImageBitmap>,
    opts?: {
      onImageLoaded?: (src: string) => void;
      onImageError?: (error: DrawfnError, src: string) => void;
    }
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;
    this.getImageBitmap = getImageBitmap;
    this.onImageLoaded = opts?.onImageLoaded;
    this.onImageError = opts?.onImageError;
  }

  render(scene: Scene, options: RenderOptions = {}): void {
    if (this.disposed) return;
    const { camera, background, elements } = scene;
    this.retainImages(elements);
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
      const bounds =
        element.rotation !== 0 ? getOBBBounds(element) : getElementBounds(element);
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
      start: { taper: element.style?.taperStart ?? 0 },
      end: { taper: element.style?.taperEnd ?? 0 },
      simulatePressure: element.points.every(point => point[2] === undefined),
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

    const x = element.x + (element.align === "center" ? element.w / 2 : element.align === "right" ? element.w : 0);
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
      void this.loadImage(element.src).catch(() => {
        // Image-load failures are surfaced through onImageError; avoid unhandled rejections.
      });
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
    const strokeWidth = 2 / camera.zoom;
    const dashPattern = 4 / camera.zoom;
    const handleSize = 6 / camera.zoom;
    const rotateHandleDistance = 20 / camera.zoom;
    const rotateHandleRadius = 4 / camera.zoom;
    const corners = getOBBCorners(element);
    const handles = getSelectionHandlePoints(element, camera.zoom);

    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = strokeWidth;
    this.ctx.setLineDash([dashPattern, dashPattern]);
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i += 1) {
      this.ctx.lineTo(corners[i].x, corners[i].y);
    }
    this.ctx.closePath();
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    this.ctx.fillStyle = "#ffffff";
    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = 1 / camera.zoom;

    for (const handle of handles) {
      if (handle.type === "rotate") continue;
      this.ctx.fillRect(
        handle.point.x - handleSize / 2,
        handle.point.y - handleSize / 2,
        handleSize,
        handleSize
      );
      this.ctx.strokeRect(
        handle.point.x - handleSize / 2,
        handle.point.y - handleSize / 2,
        handleSize,
        handleSize
      );
    }

    const rotateHandle = handles.find((handle) => handle.type === "rotate");
    const topMidpoint = getMidpoint(corners[0], corners[1]);

    this.ctx.beginPath();
    this.ctx.arc(rotateHandle!.point.x, rotateHandle!.point.y, rotateHandleRadius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.moveTo(topMidpoint.x, topMidpoint.y);
    this.ctx.lineTo(rotateHandle!.point.x, rotateHandle!.point.y);
    this.ctx.stroke();
  }

  private renderHoverHighlight(element: Element): void {
    this.ctx.strokeStyle = "#93c5fd";
    this.ctx.lineWidth = 1;
    const corners = getOBBCorners(element);
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i += 1) {
      this.ctx.lineTo(corners[i].x, corners[i].y);
    }
    this.ctx.closePath();
    this.ctx.stroke();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const asset of new Set(this.imageCache.values())) {
      if ("close" in asset) asset.close();
    }
    this.imageCache.clear();
    this.pendingImageLoads.clear();
    this.activeImageSources.clear();
    this.capacityErrors.clear();
    this.onImageLoaded = undefined;
    this.onImageError = undefined;
  }

  private retainImages(elements: Element[]): void {
    this.activeImageSources = new Set(elements.filter((element): element is ImageElement => element.type === "image").map(element => element.src));
    for (const [src, asset] of this.imageCache) {
      if (!this.activeImageSources.has(src)) {
        this.imageCache.delete(src);
        if ("close" in asset) asset.close();
      }
    }
    for (const src of this.capacityErrors) {
      if (!this.activeImageSources.has(src)) this.capacityErrors.delete(src);
    }
  }

  private imageCapacityError(): DrawfnError {
    return createDrawfnError("SCENE_LIMIT_EXCEEDED", "Renderer cannot retain more than 64 cached or pending image sources.", { limit: this.maxImageEntries });
  }

  async preloadImages(elements: Element[]): Promise<void> {
    this.retainImages(elements);
    if (this.activeImageSources.size > this.maxImageEntries) throw this.imageCapacityError();
    await Promise.all([...this.activeImageSources].map((src) => this.loadImage(src)));
  }

  private toImageLoadError(src: string, cause: unknown): DrawfnError {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      "message" in cause &&
      "recoverable" in cause
    ) {
      return cause as DrawfnError;
    }

    return createDrawfnError("EXPORT_IMAGE_LOAD_FAILED", `Failed to load image: ${src}.`, {
      src,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  private async loadImage(src: string): Promise<HTMLImageElement | ImageBitmap> {
    if (this.disposed) throw new Error("Renderer has been disposed");
    const cached = this.imageCache.get(src);
    if (cached) return cached;

    const pending = this.pendingImageLoads.get(src);
    if (pending) return pending;

    if (this.imageCache.size + this.pendingImageLoads.size >= this.maxImageEntries) {
      const error = this.imageCapacityError();
      if (!this.capacityErrors.has(src)) {
        this.capacityErrors.add(src);
        this.onImageError?.(error, src);
      }
      throw error;
    }
    this.capacityErrors.delete(src);
    // Install the reservation before invoking even a synchronously throwing host loader.
    let resolveRequest!: (asset: HTMLImageElement | ImageBitmap) => void;
    let rejectRequest!: (error: unknown) => void;
    const request = new Promise<HTMLImageElement | ImageBitmap>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    this.pendingImageLoads.set(src, request);
    void (async () => {
      try {
        let asset: HTMLImageElement | ImageBitmap;
        if (this.getImageBitmap) {
          asset = await this.getImageBitmap(src);
        } else {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
            img.src = src;
          });
          asset = img;
        }

        if (this.disposed || !this.activeImageSources.has(src)) {
          if ("close" in asset) asset.close();
          return asset;
        }
        this.imageCache.set(src, asset);
        this.onImageLoaded?.(src);
        return asset;
      } catch (error) {
        const drawfnError = this.toImageLoadError(src, error);
        if (!this.disposed) this.onImageError?.(drawfnError, src);
        throw drawfnError;
      } finally {
        this.pendingImageLoads.delete(src);
        // A removed in-flight source may have held the last slot. Wake a
        // blocked active source once capacity actually becomes available.
        if (!this.disposed && this.imageCache.size + this.pendingImageLoads.size < this.maxImageEntries) {
          const blocked = this.capacityErrors.values().next().value;
          if (blocked !== undefined) this.onImageLoaded?.(blocked);
        }
      }
    })().then(resolveRequest, rejectRequest);
    return request;
  }
}
