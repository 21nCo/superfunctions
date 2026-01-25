import type {
  Scene,
  Element,
  Camera,
  ToolName,
  DrawfnEvent,
  DrawfnEventMap,
  Point,
  ToolContext,
  Bounds,
} from "./types";
import { Renderer } from "./renderer";
import { History } from "./history";
import { generateId, screenToCanvas, getElementBounds } from "./utils";
import { ToolManager } from "./tools/tool-manager";
import { getOBBBounds } from "./geometry";
import { getStroke } from "perfect-freehand";

export type DrawfnOptions = {
  canvas: HTMLCanvasElement;
  overlayRoot?: HTMLElement;
  getImageBitmap?: (src: string) => Promise<ImageBitmap>;

  // Nucleus integration hooks
  onNodeClick?: (nodeId: string, element: Element) => void;
  getNodePreview?: (
    nodeId: string
  ) => Promise<{ title?: string; description?: string; icon?: string }>;
};

export class Drawfn {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private history: History;
  private toolManager: ToolManager;
  private scene: Scene;
  private listeners: Map<DrawfnEvent, Set<(...args: any[]) => void>> =
    new Map();
  private rafId: number | null = null;
  private needsRender = false;
  private selectedIds: Set<string> = new Set();
  private hoveredId: string | null = null;

  // Space-to-pan state
  private isSpacePressed = false;
  private toolBeforeSpace: ToolName | null = null;

  // Nucleus integration callbacks
  private onNodeClick?: (nodeId: string, element: Element) => void;
  private getNodePreview?: (
    nodeId: string
  ) => Promise<{ title?: string; description?: string; icon?: string }>;

  constructor(options: DrawfnOptions) {
    this.canvas = options.canvas;
    this.renderer = new Renderer(this.canvas, options.getImageBitmap);
    this.history = new History();
    this.toolManager = new ToolManager(this, options.overlayRoot);

    this.scene = this.createEmptyScene();

    // Initialize Nucleus integration callbacks
    this.onNodeClick = options.onNodeClick;
    this.getNodePreview = options.getNodePreview;

    this.setupEventListeners();
    this.scheduleRender();
  }

  private createEmptyScene(): Scene {
    return {
      version: 1,
      id: generateId(),
      elements: [],
      camera: { x: 0, y: 0, zoom: 1 },
      background: {
        color: "#ffffff",
        grid: { size: 16, color: "#e5e7eb", alpha: 0.6 },
      },
    };
  }

  load(scene: Scene): void {
    this.scene = JSON.parse(JSON.stringify(scene));
    this.selectedIds.clear();
    this.history.clear();
    this.scheduleRender();
  }

  loadScene(sceneData: any): boolean {
    try {
      // Validate scene structure
      if (!sceneData || typeof sceneData !== "object") {
        console.error("Invalid scene data: not an object");
        return false;
      }

      // Validate version compatibility
      const version = sceneData.version || "1.0.0";
      if (!this.isVersionCompatible(version)) {
        console.warn(
          `Scene version ${version} may not be fully compatible with current version`
        );
      }

      // Validate and sanitize elements
      const elements = Array.isArray(sceneData.elements)
        ? (sceneData.elements
            .map((el: any) => this.sanitizeElement(el))
            .filter((el: Element | null) => el !== null) as Element[])
        : [];

      // Create scene with defaults
      const loadedScene: Scene = {
        version: this.scene.version,
        id: sceneData.id || generateId(),
        elements,
        camera: this.sanitizeCamera(sceneData.camera),
        background: this.sanitizeBackground(sceneData.background),
      };

      this.scene = loadedScene;
      this.selectedIds.clear();
      this.history.clear();
      this.scheduleRender();

      return true;
    } catch (error) {
      console.error("Failed to load scene:", error);
      return false;
    }
  }

  private isVersionCompatible(version: string): boolean {
    const [major] = version.split(".").map(Number);
    const currentVersion = String(this.scene.version);
    const [currentMajor] = currentVersion.split(".").map(Number);
    return major === currentMajor;
  }

  private sanitizeElement(element: any): Element | null {
    if (!element || typeof element !== "object") return null;
    if (!element.type || !element.id) return null;

    const validTypes = [
      "freedraw",
      "rectangle",
      "ellipse",
      "arrow",
      "text",
      "image",
      "node",
    ];
    if (!validTypes.includes(element.type)) {
      console.warn(`Unknown element type: ${element.type}`);
      return null;
    }

    // Ensure required base properties
    return {
      ...element,
      id: element.id || generateId(),
      x: typeof element.x === "number" ? element.x : 0,
      y: typeof element.y === "number" ? element.y : 0,
      w: typeof element.w === "number" ? element.w : 100,
      h: typeof element.h === "number" ? element.h : 100,
      rotation: typeof element.rotation === "number" ? element.rotation : 0,
      stroke: typeof element.stroke === "string" ? element.stroke : "#000000",
      fill: typeof element.fill === "string" ? element.fill : "transparent",
      strokeWidth:
        typeof element.strokeWidth === "number" ? element.strokeWidth : 2,
      opacity: typeof element.opacity === "number" ? element.opacity : 1,
    } as Element;
  }

  private sanitizeCamera(camera: any): Camera {
    if (!camera || typeof camera !== "object") {
      return { x: 0, y: 0, zoom: 1 };
    }
    return {
      x: typeof camera.x === "number" ? camera.x : 0,
      y: typeof camera.y === "number" ? camera.y : 0,
      zoom:
        typeof camera.zoom === "number"
          ? Math.max(0.1, Math.min(5, camera.zoom))
          : 1,
    };
  }

  private sanitizeBackground(background: any): Scene["background"] {
    const defaultBg = {
      color: "#ffffff",
      grid: { size: 16, color: "#e5e7eb", alpha: 0.6 },
    };

    if (!background || typeof background !== "object") {
      return defaultBg;
    }

    return {
      color:
        typeof background.color === "string"
          ? background.color
          : defaultBg.color,
      grid:
        background.grid && typeof background.grid === "object"
          ? {
              size:
                typeof background.grid.size === "number"
                  ? background.grid.size
                  : 16,
              color:
                typeof background.grid.color === "string"
                  ? background.grid.color
                  : "#e5e7eb",
              alpha:
                typeof background.grid.alpha === "number"
                  ? background.grid.alpha
                  : 0.6,
            }
          : defaultBg.grid,
    };
  }

  getScene(): Scene {
    return JSON.parse(JSON.stringify(this.scene));
  }

  clear(): void {
    this.scene = this.createEmptyScene();
    this.selectedIds.clear();
    this.history.clear();
    this.scheduleRender();
  }

  add(element: Element): string {
    const id = element.id || generateId();
    const el = { ...element, id } as Element;

    this.recordHistory();
    this.scene.elements.push(el);
    this.emit("elementAdded", el);
    this.scheduleRender();

    return id;
  }

  update(id: string, patch: Partial<Element>): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) return;

    this.recordHistory();
    this.scene.elements[index] = {
      ...this.scene.elements[index],
      ...patch,
    } as Element;
    this.emit("elementUpdated", this.scene.elements[index]);
    this.scheduleRender();
  }

  remove(id: string): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) return;

    this.recordHistory();
    this.scene.elements.splice(index, 1);
    this.selectedIds.delete(id);
    this.emit("elementRemoved", id);
    this.scheduleRender();
  }

  bringToFront(id: string): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) return;

    this.recordHistory();
    const [element] = this.scene.elements.splice(index, 1);
    this.scene.elements.push(element);
    this.scheduleRender();
  }

  sendToBack(id: string): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) return;

    this.recordHistory();
    const [element] = this.scene.elements.splice(index, 1);
    this.scene.elements.unshift(element);
    this.scheduleRender();
  }

  setTool(tool: ToolName, opts?: any): void {
    this.toolManager.setTool(tool, opts);
  }

  getTool(): ToolName {
    return this.toolManager.getCurrentTool();
  }

  setCamera(camera: Partial<Camera>): void {
    this.scene.camera = { ...this.scene.camera, ...camera };
    this.emit("cameraChanged", this.scene.camera);
    this.scheduleRender();
  }

  getCamera(): Camera {
    return { ...this.scene.camera };
  }

  screenToCanvas(point: Point): Point {
    return screenToCanvas(point, this.scene.camera, this.canvas);
  }

  undo(): void {
    const prevScene = this.history.undo(this.scene);
    if (prevScene) {
      this.scene = prevScene;
      this.selectedIds.clear();
      this.emitHistoryChanged();
      this.scheduleRender();
    }
  }

  redo(): void {
    const nextScene = this.history.redo(this.scene);
    if (nextScene) {
      this.scene = nextScene;
      this.selectedIds.clear();
      this.emitHistoryChanged();
      this.scheduleRender();
    }
  }

  editTextElement(id: string): void {
    const element = this.scene.elements.find((el) => el.id === id);
    if (!element || element.type !== "text") return;

    // Switch to text tool
    this.setTool("text");

    // Get the text tool and call its editElement method
    const textTool = this.toolManager.getTool("text") as any;
    if (textTool && textTool.editElement) {
      textTool.editElement(id, this.canvas, this.scene);
    }
  }

  async exportPNG(opts?: {
    padding?: number;
    scale?: number;
    transparent?: boolean;
    selectedOnly?: boolean;
    fitContent?: boolean;
  }): Promise<Blob> {
    const padding = opts?.padding ?? 20;
    const scale = opts?.scale ?? 2;
    const transparent = opts?.transparent ?? false;
    const selectedOnly = opts?.selectedOnly ?? false;
    const fitContent = opts?.fitContent ?? false;

    // Determine which elements to export
    const elementsToExport = selectedOnly
      ? this.scene.elements.filter((el) => this.selectedIds.has(el.id))
      : this.scene.elements;

    // Calculate canvas size
    let canvasWidth = this.canvas.width;
    let canvasHeight = this.canvas.height;
    let offsetX = 0;
    let offsetY = 0;

    if (fitContent && elementsToExport.length > 0) {
      const bounds = this.getContentBounds(elementsToExport);
      canvasWidth = (bounds.w + padding * 2) * scale;
      canvasHeight = (bounds.h + padding * 2) * scale;
      offsetX = -(bounds.x - padding);
      offsetY = -(bounds.y - padding);
    }

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvasWidth * (fitContent ? 1 : scale);
    tempCanvas.height = canvasHeight * (fitContent ? 1 : scale);
    const ctx = tempCanvas.getContext("2d")!;

    ctx.scale(scale, scale);

    if (fitContent) {
      ctx.translate(offsetX, offsetY);
    }

    if (!transparent) {
      ctx.fillStyle = this.scene.background.color;
      ctx.fillRect(
        fitContent ? -offsetX : 0,
        fitContent ? -offsetY : 0,
        fitContent ? canvasWidth / scale : this.canvas.width,
        fitContent ? canvasHeight / scale : this.canvas.height
      );
    }

    // Create temporary scene with only elements to export
    const exportScene: Scene = {
      ...this.scene,
      elements: elementsToExport,
    };

    const tempRenderer = new Renderer(tempCanvas);
    tempRenderer.render(exportScene);

    return new Promise((resolve, reject) => {
      tempCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to export PNG"));
      }, "image/png");
    });
  }

  private getContentBounds(elements: Element[]): Bounds {
    if (elements.length === 0) {
      return { x: 0, y: 0, w: 800, h: 600 };
    }

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const element of elements) {
      // Use OBB bounds for rotated elements
      const bounds =
        element.rotation !== 0
          ? getOBBBounds(element)
          : getElementBounds(element);

      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.w);
      maxY = Math.max(maxY, bounds.y + bounds.h);
    }

    return {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    };
  }

  async exportSVG(opts?: {
    padding?: number;
    scale?: number;
  }): Promise<string> {
    const padding = opts?.padding ?? 20;
    const scale = opts?.scale ?? 1;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.canvas.width * scale}" height="${this.canvas.height * scale}" viewBox="0 0 ${this.canvas.width} ${this.canvas.height}">`;
    svg += `<rect width="100%" height="100%" fill="${this.scene.background.color}"/>`;

    for (const element of this.scene.elements) {
      svg += this.elementToSVG(element);
    }

    svg += "</svg>";
    return svg;
  }

  private elementToSVG(element: Element): string {
    let transform = "";
    if (element.rotation !== 0) {
      const cx = element.x + element.w / 2;
      const cy = element.y + element.h / 2;
      transform = ` transform="rotate(${(element.rotation * 180) / Math.PI} ${cx} ${cy})"`;
    }

    const commonAttrs = `opacity="${element.opacity}" stroke="${element.stroke}" stroke-width="${element.strokeWidth}" fill="${element.fill}"${transform}`;

    switch (element.type) {
      case "rectangle":
        return `<rect x="${element.x}" y="${element.y}" width="${element.w}" height="${element.h}" ${commonAttrs}/>`;

      case "ellipse":
        const cx = element.x + element.w / 2;
        const cy = element.y + element.h / 2;
        return `<ellipse cx="${cx}" cy="${cy}" rx="${element.w / 2}" ry="${element.h / 2}" ${commonAttrs}/>`;

      case "text":
        const textEl = element as any;
        return `<text x="${element.x}" y="${element.y + textEl.fontSize}" font-family="${textEl.fontFamily}" font-size="${textEl.fontSize}" ${commonAttrs}>${this.escapeXml(textEl.text)}</text>`;

      case "freedraw": {
        const freedraw = element as any;
        if (freedraw.points.length === 0) return "";

        const points = freedraw.points.map((p: any) => [
          p[0],
          p[1],
          p[2] ?? 0.5,
        ]);
        const stroke = getStroke(points, {
          size: freedraw.style?.size ?? element.strokeWidth * 2,
          thinning: freedraw.style?.thinning ?? 0.5,
          smoothing: freedraw.style?.smoothing ?? 0.5,
          streamline: freedraw.style?.streamline ?? 0.5,
          simulatePressure: true,
        });

        let pathData = `M ${stroke[0][0] + element.x} ${stroke[0][1] + element.y}`;
        for (let i = 1; i < stroke.length; i++) {
          pathData += ` L ${stroke[i][0] + element.x} ${stroke[i][1] + element.y}`;
        }
        pathData += " Z";

        return `<path d="${pathData}" fill="${element.stroke}" opacity="${element.opacity}"${transform}/>`;
      }

      case "arrow": {
        const arrow = element as any;
        if (arrow.points.length < 2) return "";

        let pathData = `M ${arrow.points[0][0] + element.x} ${arrow.points[0][1] + element.y}`;
        for (let i = 1; i < arrow.points.length; i++) {
          pathData += ` L ${arrow.points[i][0] + element.x} ${arrow.points[i][1] + element.y}`;
        }

        let svg = `<path d="${pathData}" stroke="${element.stroke}" stroke-width="${element.strokeWidth}" fill="none" opacity="${element.opacity}"${transform}/>`;

        if (arrow.head === "triangle") {
          const last = arrow.points[arrow.points.length - 1];
          const prev = arrow.points[arrow.points.length - 2];
          const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
          const headLen = 10;

          const tip = [last[0] + element.x, last[1] + element.y];
          const left = [
            tip[0] - headLen * Math.cos(angle - Math.PI / 6),
            tip[1] - headLen * Math.sin(angle - Math.PI / 6),
          ];
          const right = [
            tip[0] - headLen * Math.cos(angle + Math.PI / 6),
            tip[1] - headLen * Math.sin(angle + Math.PI / 6),
          ];

          svg += `<polygon points="${tip[0]},${tip[1]} ${left[0]},${left[1]} ${right[0]},${right[1]}" fill="${element.stroke}" opacity="${element.opacity}"${transform}/>`;
        }

        return svg;
      }

      case "image": {
        const img = element as any;
        return `<image x="${element.x}" y="${element.y}" width="${element.w}" height="${element.h}" href="${this.escapeXml(img.src)}" opacity="${element.opacity}"${transform}/>`;
      }

      case "node": {
        const node = element as any;
        let svg = `<rect x="${element.x}" y="${element.y}" width="${element.w}" height="${element.h}" rx="8" ${commonAttrs}/>`;
        if (node.preview?.title) {
          svg += `<text x="${element.x + 12}" y="${element.y + 24}" font-family="sans-serif" font-size="14" fill="${element.stroke}">${this.escapeXml(node.preview.title)}</text>`;
        }
        return svg;
      }

      default:
        return "";
    }
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  on<E extends DrawfnEvent>(
    event: E,
    handler: (...args: DrawfnEventMap[E]) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);

    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  private emit<E extends DrawfnEvent>(
    event: E,
    ...args: DrawfnEventMap[E]
  ): void {
    this.listeners.get(event)?.forEach((handler) => handler(...args));
  }

  private emitHistoryChanged(): void {
    this.emit("historyChanged", {
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
    });
  }

  private recordHistory(): void {
    this.history.push(this.scene);
    this.emitHistoryChanged();
  }

  private createToolContext(): ToolContext {
    return {
      addElement: (element: Element) => this.add(element),
      updateElement: (id: string, patch: Partial<Element>) =>
        this.update(id, patch),
      removeElement: (id: string) => this.remove(id),
      recordHistory: () => this.recordHistory(),
      getScene: () => this.getScene(),
      getCamera: () => this.getCamera(),
      getDrawfn: () => this,
      getSelection: () => this.selectedIds,
    };
  }

  private setupEventListeners(): void {
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("wheel", this.handleWheel);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.emit("pointerDown", e);
    const context = this.createToolContext();
    this.toolManager.handlePointerDown(e, context, this.selectedIds);
    this.scheduleRender();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    this.emit("pointerMove", e);
    const context = this.createToolContext();
    this.toolManager.handlePointerMove(e, context);
    this.scheduleRender();
  };

  private handlePointerUp = (e: PointerEvent): void => {
    this.emit("pointerUp", e);
    const context = this.createToolContext();
    this.toolManager.handlePointerUp(e, context);
    this.scheduleRender();
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const delta = e.deltaY * -0.001;
    const oldZoom = this.scene.camera.zoom;
    const newZoom = Math.max(0.1, Math.min(5, oldZoom + delta));

    // Get the point in canvas coordinates before zoom
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      this.scene.camera,
      this.canvas
    );

    // Update zoom
    this.scene.camera.zoom = newZoom;

    // Adjust camera position to keep the point under cursor stable
    // Formula: newCamera = point - (point - oldCamera) * (newZoom / oldZoom)
    const zoomRatio = newZoom / oldZoom;
    this.scene.camera.x = point.x - (point.x - this.scene.camera.x) * zoomRatio;
    this.scene.camera.y = point.y - (point.y - this.scene.camera.y) * zoomRatio;

    this.emit("cameraChanged", this.scene.camera);
    this.scheduleRender();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Space-to-pan modality
    if (e.key === " " && !this.isSpacePressed && e.target === this.canvas) {
      e.preventDefault();
      this.isSpacePressed = true;
      this.toolBeforeSpace = this.getTool();
      this.setTool("pan");
      this.canvas.style.cursor = "grab";
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      this.selectedIds.forEach((id) => this.remove(id));
    } else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === "y") {
      e.preventDefault();
      this.redo();
    } else {
      const context = this.createToolContext();
      this.toolManager.handleKeyDown(e, context);
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    // Release space-to-pan
    if (e.key === " " && this.isSpacePressed) {
      this.isSpacePressed = false;
      if (this.toolBeforeSpace) {
        this.setTool(this.toolBeforeSpace);
        this.toolBeforeSpace = null;
      }
      this.canvas.style.cursor = "default";
    }
  };

  private scheduleRender(): void {
    this.needsRender = true;
    if (this.rafId !== null) return;

    this.rafId = requestAnimationFrame(() => {
      if (this.needsRender) {
        // Get marquee state from select tool if active
        const marquee = this.toolManager.getMarquee();

        this.renderer.render(this.scene, {
          selectedIds: this.selectedIds,
          hoveredId: this.hoveredId,
          marquee,
        });
        this.needsRender = false;
      }
      this.rafId = null;
    });
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.listeners.clear();
  }

  getSelectedIds(): string[] {
    return Array.from(this.selectedIds);
  }

  setSelection(ids: string[]): void {
    this.selectedIds = new Set(ids);
    this.emit("selectionChanged", ids);
    this.scheduleRender();
  }

  getElements(): Element[] {
    return [...this.scene.elements];
  }

  getElementById(id: string): Element | undefined {
    return this.scene.elements.find((el) => el.id === id);
  }
}
