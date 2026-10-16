import type {
  Scene,
  Element,
  Camera,
  ToolName,
  SceneChangeReason,
  DrawfnEvent,
  DrawfnEventMap,
  DrawfnError,
  HistoryChangedEvent,
  DrawfnResult,
  ElementType,
  FreeDrawElement,
  Point,
  ToolContext,
  Bounds,
} from "./types";
import { Renderer } from "./renderer";
import { History } from "./history";
import {
  clamp,
  createDrawfnError,
  deepClone,
  generateId,
  getElementBounds,
  isFiniteNumber,
  isRecord,
  MAX_CAMERA_ZOOM,
  MAX_FREEDRAW_POINTS,
  MAX_SCENE_ELEMENTS,
  MIN_CAMERA_ZOOM,
  screenToCanvas,
} from "./utils";
import { ToolManager } from "./tools/tool-manager";
import { getOBBBounds, getTupleBounds, isPointInOBB } from "./geometry";
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

const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
const DEFAULT_BACKGROUND_COLOR = "#ffffff";
const VALID_ELEMENT_TYPES = new Set<ElementType>([
  "freedraw",
  "rectangle",
  "ellipse",
  "arrow",
  "text",
  "image",
  "node",
]);
const VALID_TEXT_ALIGN = new Set(["left", "center", "right"]);
const VALID_NODE_VARIANTS = new Set(["bookmark", "embed", "card"]);

function invalidScene(
  message: string,
  details?: Record<string, unknown>
): DrawfnResult<never> {
  return {
    ok: false,
    error: createDrawfnError("INVALID_SCENE", message, details),
  };
}

function unsupportedSceneVersion(version: unknown): DrawfnResult<never> {
  return {
    ok: false,
    error: createDrawfnError(
      "UNSUPPORTED_SCENE_VERSION",
      `Scene version ${String(version)} is not supported.`,
      { version }
    ),
  };
}

function sceneLimitExceeded(
  message: string,
  details?: Record<string, unknown>
): DrawfnResult<never> {
  return {
    ok: false,
    error: createDrawfnError("SCENE_LIMIT_EXCEEDED", message, details),
  };
}

function normalizeOptionalNumber(
  value: unknown,
  fallback: number,
  path: string
): DrawfnResult<number> {
  if (value === undefined) {
    return { ok: true, data: fallback };
  }

  if (!isFiniteNumber(value)) {
    return invalidScene(`${path} must be a finite number.`, { path, value });
  }

  return { ok: true, data: value };
}

function normalizeOptionalString(
  value: unknown,
  fallback: string,
  path: string
): DrawfnResult<string> {
  if (value === undefined) {
    return { ok: true, data: fallback };
  }

  if (typeof value !== "string") {
    return invalidScene(`${path} must be a string.`, { path, value });
  }

  return { ok: true, data: value };
}

function normalizeOptionalBoolean(
  value: unknown,
  path: string
): DrawfnResult<boolean | undefined> {
  if (value === undefined) {
    return { ok: true, data: undefined };
  }

  if (typeof value !== "boolean") {
    return invalidScene(`${path} must be a boolean.`, { path, value });
  }

  return { ok: true, data: value };
}

function normalizeOptionalMeta(
  value: unknown,
  path: string
): DrawfnResult<Record<string, unknown> | undefined> {
  if (value === undefined) {
    return { ok: true, data: undefined };
  }

  if (!isRecord(value)) {
    return invalidScene(`${path} must be an object when provided.`, {
      path,
      value,
    });
  }

  try {
    return { ok: true, data: deepClone(value) };
  } catch {
    return invalidScene(`${path} must be JSON-serializable.`, { path });
  }
}

function normalizeMaybeNumber(
  value: unknown,
  path: string
): DrawfnResult<number | undefined> {
  if (value === undefined) {
    return { ok: true, data: undefined };
  }

  if (!isFiniteNumber(value)) {
    return invalidScene(`${path} must be a finite number.`, { path, value });
  }

  return { ok: true, data: value };
}

function normalizeCamera(cameraData: unknown): DrawfnResult<Camera> {
  if (cameraData === undefined) {
    return { ok: true, data: { ...DEFAULT_CAMERA } };
  }

  if (!isRecord(cameraData)) {
    return invalidScene("Scene.camera must be an object.", {
      path: "camera",
      value: cameraData,
    });
  }

  const x = normalizeOptionalNumber(cameraData.x, DEFAULT_CAMERA.x, "camera.x");
  if (!x.ok) return x;

  const y = normalizeOptionalNumber(cameraData.y, DEFAULT_CAMERA.y, "camera.y");
  if (!y.ok) return y;

  const zoom = normalizeOptionalNumber(
    cameraData.zoom,
    DEFAULT_CAMERA.zoom,
    "camera.zoom"
  );
  if (!zoom.ok) return zoom;

  return {
    ok: true,
    data: {
      x: x.data,
      y: y.data,
      zoom: clamp(zoom.data, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM),
    },
  };
}

function normalizeBackground(backgroundData: unknown): DrawfnResult<Scene["background"]> {
  if (backgroundData === undefined) {
    return { ok: true, data: { color: DEFAULT_BACKGROUND_COLOR } };
  }

  if (!isRecord(backgroundData)) {
    return invalidScene("Scene.background must be an object.", {
      path: "background",
      value: backgroundData,
    });
  }

  const color = normalizeOptionalString(
    backgroundData.color,
    DEFAULT_BACKGROUND_COLOR,
    "background.color"
  );
  if (!color.ok) return color;

  if (backgroundData.grid === undefined) {
    return { ok: true, data: { color: color.data } };
  }

  if (!isRecord(backgroundData.grid)) {
    return invalidScene("Scene.background.grid must be an object.", {
      path: "background.grid",
      value: backgroundData.grid,
    });
  }

  const size = normalizeOptionalNumber(
    backgroundData.grid.size,
    16,
    "background.grid.size"
  );
  if (!size.ok) return size;

  const gridColor = normalizeOptionalString(
    backgroundData.grid.color,
    "#e5e7eb",
    "background.grid.color"
  );
  if (!gridColor.ok) return gridColor;

  const alpha = normalizeOptionalNumber(
    backgroundData.grid.alpha,
    0.6,
    "background.grid.alpha"
  );
  if (!alpha.ok) return alpha;

  return {
    ok: true,
    data: {
      color: color.data,
      grid: {
        size: size.data,
        color: gridColor.data,
        alpha: alpha.data,
      },
    },
  };
}

function normalizePointTuple(
  point: unknown,
  path: string
): DrawfnResult<[number, number, number?]> {
  if (!Array.isArray(point) || point.length < 2 || point.length > 3) {
    return invalidScene(`${path} must be a [x, y, pressure?] tuple.`, {
      path,
      value: point,
    });
  }

  if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
    return invalidScene(`${path} coordinates must be finite numbers.`, {
      path,
      value: point,
    });
  }

  if (point[2] !== undefined && !isFiniteNumber(point[2])) {
    return invalidScene(`${path}[2] must be a finite number when provided.`, {
      path,
      value: point,
    });
  }

  return {
    ok: true,
    data:
      point[2] === undefined
        ? [point[0], point[1]]
        : [point[0], point[1], point[2]],
  };
}

function normalizeArrowPointTuple(
  point: unknown,
  path: string
): DrawfnResult<[number, number]> {
  if (!Array.isArray(point) || point.length !== 2) {
    return invalidScene(`${path} must be a [x, y] tuple.`, { path, value: point });
  }

  if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
    return invalidScene(`${path} coordinates must be finite numbers.`, {
      path,
      value: point,
    });
  }

  return { ok: true, data: [point[0], point[1]] };
}

function isRepairableLegacyFreedraw(
  points: Array<[number, number, number?]>,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  if (points.length === 0) return false;

  const [first] = points;
  if (first[0] !== x || first[1] !== y) {
    return false;
  }

  const maxLocalX = Math.max(Math.abs(w), 1);
  const maxLocalY = Math.max(Math.abs(h), 1);

  return points.slice(1).every(([px, py]) => {
    return (
      px >= -maxLocalX &&
      px <= maxLocalX &&
      py >= -maxLocalY &&
      py <= maxLocalY
    );
  });
}

function normalizeFreedrawPoints(
  pointsData: unknown,
  base: Pick<FreeDrawElement, "x" | "y" | "w" | "h">
): DrawfnResult<Pick<FreeDrawElement, "points" | "w" | "h">> {
  if (!Array.isArray(pointsData)) {
    return invalidScene("freedraw.points must be an array.", {
      path: "elements[].points",
      value: pointsData,
    });
  }

  if (pointsData.length > MAX_FREEDRAW_POINTS) {
    return sceneLimitExceeded(
      `FreeDraw elements cannot exceed ${MAX_FREEDRAW_POINTS} points.`,
      { limit: MAX_FREEDRAW_POINTS, actual: pointsData.length }
    );
  }

  const normalizedPoints: Array<[number, number, number?]> = [];
  for (let i = 0; i < pointsData.length; i += 1) {
    const point = normalizePointTuple(pointsData[i], `freedraw.points[${i}]`);
    if (!point.ok) return point;
    normalizedPoints.push(point.data);
  }

  let canonicalPoints = normalizedPoints;
  const [firstPoint] = normalizedPoints;

  if (firstPoint) {
    const isCanonical = firstPoint[0] === 0 && firstPoint[1] === 0;
    if (!isCanonical) {
      if (isRepairableLegacyFreedraw(normalizedPoints, base.x, base.y, base.w, base.h)) {
        canonicalPoints = [
          [0, 0, firstPoint[2]],
          ...normalizedPoints.slice(1),
        ];
      } else {
        return invalidScene(
          "FreeDraw points must use element-local coordinates or match the known legacy repair rule.",
          {
            elementOrigin: { x: base.x, y: base.y },
            firstPoint,
          }
        );
      }
    }
  }

  const bounds = getTupleBounds(canonicalPoints);
  return {
    ok: true,
    data: {
      points: canonicalPoints,
      w: bounds.w,
      h: bounds.h,
    },
  };
}

function normalizeElement(
  elementData: unknown,
  index: number
): DrawfnResult<Element> {
  if (!isRecord(elementData)) {
    return invalidScene("Scene elements must be objects.", {
      path: `elements[${index}]`,
      value: elementData,
    });
  }

  const type = elementData.type;
  if (typeof type !== "string" || !VALID_ELEMENT_TYPES.has(type as ElementType)) {
    return invalidScene(`elements[${index}].type is invalid.`, {
      path: `elements[${index}].type`,
      value: type,
    });
  }

  const x = normalizeOptionalNumber(elementData.x, 0, `elements[${index}].x`);
  if (!x.ok) return x;
  const y = normalizeOptionalNumber(elementData.y, 0, `elements[${index}].y`);
  if (!y.ok) return y;
  const w = normalizeOptionalNumber(elementData.w, 100, `elements[${index}].w`);
  if (!w.ok) return w;
  const h = normalizeOptionalNumber(elementData.h, 100, `elements[${index}].h`);
  if (!h.ok) return h;
  const rotation = normalizeOptionalNumber(
    elementData.rotation,
    0,
    `elements[${index}].rotation`
  );
  if (!rotation.ok) return rotation;
  const stroke = normalizeOptionalString(
    elementData.stroke,
    "#000000",
    `elements[${index}].stroke`
  );
  if (!stroke.ok) return stroke;
  const fill = normalizeOptionalString(
    elementData.fill,
    "transparent",
    `elements[${index}].fill`
  );
  if (!fill.ok) return fill;
  const strokeWidth = normalizeOptionalNumber(
    elementData.strokeWidth,
    2,
    `elements[${index}].strokeWidth`
  );
  if (!strokeWidth.ok) return strokeWidth;
  const opacity = normalizeOptionalNumber(
    elementData.opacity,
    1,
    `elements[${index}].opacity`
  );
  if (!opacity.ok) return opacity;
  const locked = normalizeOptionalBoolean(
    elementData.locked,
    `elements[${index}].locked`
  );
  if (!locked.ok) return locked;
  const meta = normalizeOptionalMeta(elementData.meta, `elements[${index}].meta`);
  if (!meta.ok) return meta;

  const base = {
    id:
      typeof elementData.id === "string" && elementData.id.length > 0
        ? elementData.id
        : generateId(),
    type: type as ElementType,
    x: x.data,
    y: y.data,
    w: Math.max(0, w.data),
    h: Math.max(0, h.data),
    rotation: rotation.data,
    stroke: stroke.data,
    fill: fill.data,
    strokeWidth: Math.max(0, strokeWidth.data),
    opacity: clamp(opacity.data, 0, 1),
    ...(locked.data === undefined ? {} : { locked: locked.data }),
    ...(meta.data === undefined ? {} : { meta: meta.data }),
  };

  switch (type) {
    case "freedraw": {
      const points = normalizeFreedrawPoints(elementData.points, base);
      if (!points.ok) return points;

      if (elementData.style !== undefined && !isRecord(elementData.style)) {
        return invalidScene("freedraw.style must be an object when provided.", {
          path: `elements[${index}].style`,
          value: elementData.style,
        });
      }

      const styleSource = isRecord(elementData.style) ? elementData.style : {};
      const size = normalizeOptionalNumber(
        styleSource.size,
        4,
        `elements[${index}].style.size`
      );
      if (!size.ok) return size;
      const thinning = normalizeOptionalNumber(
        styleSource.thinning,
        0.5,
        `elements[${index}].style.thinning`
      );
      if (!thinning.ok) return thinning;
      const smoothing = normalizeOptionalNumber(
        styleSource.smoothing,
        0.5,
        `elements[${index}].style.smoothing`
      );
      if (!smoothing.ok) return smoothing;
      const streamline = normalizeOptionalNumber(
        styleSource.streamline,
        0.5,
        `elements[${index}].style.streamline`
      );
      if (!streamline.ok) return streamline;
      const taperStart = normalizeOptionalNumber(
        styleSource.taperStart,
        0,
        `elements[${index}].style.taperStart`
      );
      if (!taperStart.ok) return taperStart;
      const taperEnd = normalizeOptionalNumber(
        styleSource.taperEnd,
        0,
        `elements[${index}].style.taperEnd`
      );
      if (!taperEnd.ok) return taperEnd;

      return {
        ok: true,
        data: {
          ...base,
          type: "freedraw",
          points: points.data.points,
          w: points.data.w,
          h: points.data.h,
          style: {
            size: size.data,
            thinning: thinning.data,
            smoothing: smoothing.data,
            streamline: streamline.data,
            taperStart: taperStart.data,
            taperEnd: taperEnd.data,
          },
        },
      };
    }

    case "rectangle":
      return { ok: true, data: { ...base, type: "rectangle" } };

    case "ellipse":
      return { ok: true, data: { ...base, type: "ellipse" } };

    case "arrow": {
      if (!Array.isArray(elementData.points)) {
        return invalidScene("arrow.points must be an array.", {
          path: `elements[${index}].points`,
          value: elementData.points,
        });
      }

      const points: Array<[number, number]> = [];
      for (let i = 0; i < elementData.points.length; i += 1) {
        const point = normalizeArrowPointTuple(
          elementData.points[i],
          `elements[${index}].points[${i}]`
        );
        if (!point.ok) return point;
        points.push(point.data);
      }

      const head =
        elementData.head === undefined ? "triangle" : elementData.head;
      if (head !== "triangle" && head !== "none") {
        return invalidScene("arrow.head must be 'triangle' or 'none'.", {
          path: `elements[${index}].head`,
          value: head,
        });
      }

      return {
        ok: true,
        data: {
          ...base,
          type: "arrow",
          points,
          head,
        },
      };
    }

    case "text": {
      const text = normalizeOptionalString(
        elementData.text,
        "",
        `elements[${index}].text`
      );
      if (!text.ok) return text;
      const fontFamily = normalizeOptionalString(
        elementData.fontFamily,
        "sans-serif",
        `elements[${index}].fontFamily`
      );
      if (!fontFamily.ok) return fontFamily;
      const fontSize = normalizeOptionalNumber(
        elementData.fontSize,
        16,
        `elements[${index}].fontSize`
      );
      if (!fontSize.ok) return fontSize;
      const align = elementData.align === undefined ? "left" : elementData.align;
      if (typeof align !== "string" || !VALID_TEXT_ALIGN.has(align)) {
        return invalidScene("text.align must be left, center, or right.", {
          path: `elements[${index}].align`,
          value: align,
        });
      }

      return {
        ok: true,
        data: {
          ...base,
          type: "text",
          text: text.data,
          fontFamily: fontFamily.data,
          fontSize: Math.max(0, fontSize.data),
          align: align as "left" | "center" | "right",
        },
      };
    }

    case "image": {
      if (typeof elementData.src !== "string" || elementData.src.length === 0) {
        return invalidScene("image.src must be a non-empty string.", {
          path: `elements[${index}].src`,
          value: elementData.src,
        });
      }

      const naturalW = normalizeMaybeNumber(
        elementData.naturalW,
        `elements[${index}].naturalW`
      );
      if (!naturalW.ok) return naturalW;
      const naturalH = normalizeMaybeNumber(
        elementData.naturalH,
        `elements[${index}].naturalH`
      );
      if (!naturalH.ok) return naturalH;

      return {
        ok: true,
        data: {
          ...base,
          type: "image",
          src: elementData.src,
          ...(naturalW.data === undefined ? {} : { naturalW: naturalW.data }),
          ...(naturalH.data === undefined ? {} : { naturalH: naturalH.data }),
        },
      };
    }

    case "node": {
      if (typeof elementData.nodeId !== "string" || elementData.nodeId.length === 0) {
        return invalidScene("node.nodeId must be a non-empty string.", {
          path: `elements[${index}].nodeId`,
          value: elementData.nodeId,
        });
      }

      const nodeType = normalizeOptionalString(
        elementData.nodeType,
        "",
        `elements[${index}].nodeType`
      );
      if (!nodeType.ok && elementData.nodeType !== undefined) return nodeType;

      const variant =
        elementData.variant === undefined ? undefined : elementData.variant;
      if (
        variant !== undefined &&
        (typeof variant !== "string" || !VALID_NODE_VARIANTS.has(variant))
      ) {
        return invalidScene("node.variant is invalid.", {
          path: `elements[${index}].variant`,
          value: variant,
        });
      }

      if (elementData.preview !== undefined && !isRecord(elementData.preview)) {
        return invalidScene("node.preview must be an object when provided.", {
          path: `elements[${index}].preview`,
          value: elementData.preview,
        });
      }

      const preview = isRecord(elementData.preview) ? elementData.preview : undefined;
      const title = preview
        ? normalizeOptionalString(preview.title, "", `elements[${index}].preview.title`)
        : { ok: true as const, data: "" };
      if (!title.ok && preview?.title !== undefined) return title;
      const icon = preview
        ? normalizeOptionalString(preview.icon, "", `elements[${index}].preview.icon`)
        : { ok: true as const, data: "" };
      if (!icon.ok && preview?.icon !== undefined) return icon;
      const excerpt = preview
        ? normalizeOptionalString(
            preview.excerpt,
            "",
            `elements[${index}].preview.excerpt`
          )
        : { ok: true as const, data: "" };
      if (!excerpt.ok && preview?.excerpt !== undefined) return excerpt;
      const nodeTypeValue = nodeType.ok ? nodeType.data : "";
      const titleValue = title.ok ? title.data : "";
      const iconValue = icon.ok ? icon.data : "";
      const excerptValue = excerpt.ok ? excerpt.data : "";

      return {
        ok: true,
        data: {
          ...base,
          type: "node",
          nodeId: elementData.nodeId,
          ...(elementData.nodeType === undefined ? {} : { nodeType: nodeTypeValue }),
          ...(variant === undefined
            ? {}
            : { variant: variant as "bookmark" | "embed" | "card" }),
          ...(preview === undefined
            ? {}
            : {
                preview: {
                  ...(preview.title === undefined ? {} : { title: titleValue }),
                  ...(preview.icon === undefined ? {} : { icon: iconValue }),
                  ...(preview.excerpt === undefined ? {} : { excerpt: excerptValue }),
                },
              }),
        },
      };
    }
  }

  return invalidScene(`elements[${index}].type is invalid.`, {
    path: `elements[${index}].type`,
    value: type,
  });
}

function normalizeSceneData(sceneData: unknown): DrawfnResult<Scene> {
  if (!isRecord(sceneData)) {
    return invalidScene("Scene data must be an object.", { value: sceneData });
  }

  if (sceneData.version !== 1 && sceneData.version !== "1") {
    return unsupportedSceneVersion(sceneData.version);
  }

  if (!Array.isArray(sceneData.elements)) {
    return invalidScene("Scene.elements must be an array.", {
      path: "elements",
      value: sceneData.elements,
    });
  }

  if (sceneData.elements.length > MAX_SCENE_ELEMENTS) {
    return sceneLimitExceeded(
      `Scenes cannot exceed ${MAX_SCENE_ELEMENTS} elements.`,
      { limit: MAX_SCENE_ELEMENTS, actual: sceneData.elements.length }
    );
  }

  const camera = normalizeCamera(sceneData.camera);
  if (!camera.ok) return camera;

  const background = normalizeBackground(sceneData.background);
  if (!background.ok) return background;

  const elements: Element[] = [];
  for (let i = 0; i < sceneData.elements.length; i += 1) {
    const element = normalizeElement(sceneData.elements[i], i);
    if (!element.ok) return element;
    elements.push(element.data);
  }

  return {
    ok: true,
    data: {
      version: 1,
      id:
        typeof sceneData.id === "string" && sceneData.id.length > 0
          ? sceneData.id
          : generateId(),
      elements,
      camera: camera.data,
      background: background.data,
    },
  };
}

type GestureTransaction = {
  snapshot: Scene;
  reason: SceneChangeReason;
  changedElementIds: Set<string>;
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
  private destroyed = false;
  private canvasSizeObserver?: MutationObserver;
  private originalTabIndex: string | null = null;
  private selectedIds: Set<string> = new Set();
  private hoveredId: string | null = null;
  private activeGesture: GestureTransaction | null = null;
  private activePointerId: number | null = null;
  private pointerStart: Point | null = null;
  private pointerMoved = false;
  private pointerSelection: string[] = [];
  private getImageBitmap?: (src: string) => Promise<ImageBitmap>;

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
    this.originalTabIndex = this.canvas.getAttribute("tabindex");
    if (this.originalTabIndex === null) this.canvas.tabIndex = 0;
    this.getImageBitmap = options.getImageBitmap;
    this.renderer = new Renderer(this.canvas, options.getImageBitmap, {
      onImageLoaded: (src) => {
        const imageStillPresent = this.scene.elements.some((element) => {
          return element.type === "image" && element.src === src;
        });

        if (imageStillPresent) {
          this.scheduleRender();
        }
      },
      onImageError: (error) => {
        this.emit("error", error);
      },
    });
    this.history = new History();
    this.toolManager = new ToolManager(this, options.overlayRoot);

    this.scene = this.createEmptyScene();

    // Initialize Nucleus integration callbacks
    this.onNodeClick = options.onNodeClick;
    this.getNodePreview = options.getNodePreview;

    this.setupEventListeners();
    // Updating backing dimensions clears native canvas pixels without changing the scene.
    this.canvasSizeObserver = new MutationObserver(() => this.scheduleRender());
    this.canvasSizeObserver.observe(this.canvas, { attributes: true, attributeFilter: ["width", "height"] });
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

  private applyLoadedScene(scene: Scene): void {
    this.activeGesture = null;
    this.scene = deepClone(scene);
    this.hoveredId = null;
    this.history.clear();
    this.setSelection([]);
    this.emitHistoryChanged();
    this.emitSceneChanged("load", []);
    for (const element of this.scene.elements) this.resolveNodePreview(element);
    this.scheduleRender();
  }

  private sceneStateEquals(left: Scene, right: Scene): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  beginGesture(reason: SceneChangeReason = "update"): void {
    if (this.activeGesture) {
      return;
    }

    this.activeGesture = {
      snapshot: this.getScene(),
      reason,
      changedElementIds: new Set(),
    };
  }

  private trackGestureMutation(
    reason: SceneChangeReason,
    changedElementIds: string[]
  ): void {
    if (!this.activeGesture) {
      return;
    }

    if (reason === "add" || this.activeGesture.reason !== "add") {
      this.activeGesture.reason = reason;
    }

    changedElementIds.forEach((id) => this.activeGesture?.changedElementIds.add(id));
  }

  private completeGesture(): void {
    if (!this.activeGesture) {
      return;
    }

    const transaction = this.activeGesture;
    this.activeGesture = null;

    if (this.sceneStateEquals(transaction.snapshot, this.scene)) {
      return;
    }

    this.history.push(transaction.snapshot);
    this.emitHistoryChanged();
    this.emitSceneChanged(
      transaction.reason,
      Array.from(transaction.changedElementIds)
    );
  }

  load(scene: Scene): void {
    const normalizedScene = normalizeSceneData(scene);
    if (!normalizedScene.ok) {
      this.emit("error", normalizedScene.error);
      return;
    }

    this.applyLoadedScene(normalizedScene.data);
  }

  loadScene(sceneData: unknown): DrawfnResult<Scene> {
    const normalizedScene = normalizeSceneData(sceneData);
    if (!normalizedScene.ok) {
      this.emit("error", normalizedScene.error);
      return normalizedScene;
    }

    this.applyLoadedScene(normalizedScene.data);
    return { ok: true, data: this.getScene() };
  }

  getScene(): Scene {
    return deepClone(this.scene);
  }

  clear(): void {
    this.activeGesture = null;
    this.scene = this.createEmptyScene();
    this.history.clear();
    this.setSelection([]);
    this.emitHistoryChanged();
    this.emitSceneChanged("clear", []);
    this.scheduleRender();
  }

  add(element: Element): string {
    const id = element.id || generateId();
    const normalizedElement = normalizeElement({ ...element, id }, 0);
    if (!normalizedElement.ok) {
      this.emit("error", normalizedElement.error);
      return id;
    }

    const previousScene = this.getScene();
    this.scene.elements.push(normalizedElement.data);
    this.resolveNodePreview(normalizedElement.data);
    this.emit("elementAdded", normalizedElement.data);
    if (this.activeGesture) {
      this.trackGestureMutation("add", [id]);
    } else {
      this.history.push(previousScene);
      this.emitHistoryChanged();
      this.emitSceneChanged("add", [id]);
    }
    this.scheduleRender();

    return id;
  }

  private resolveNodePreview(element: Element): void {
    if (element.type !== "node" || element.preview || !this.getNodePreview) return;
    const loader = this.getNodePreview;
    void Promise.resolve().then(() => loader(element.nodeId)).then(preview => {
      // Removal, scene replacement, editing, or destruction invalidates the request.
      if (this.destroyed || !this.scene.elements.includes(element)) return;
      this.update(element.id, { preview: { title: preview.title, icon: preview.icon, excerpt: preview.description } });
    }).catch(cause => {
      if (this.destroyed || !this.scene.elements.includes(element)) return;
      this.emit("error", createDrawfnError("NODE_PREVIEW_FAILED", `Failed to load preview for node ${element.nodeId}.`, {
        nodeId: element.nodeId, cause: cause instanceof Error ? cause.message : String(cause),
      }));
    });
  }

  update(id: string, patch: Partial<Element>): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) {
      this.emit(
        "error",
        createDrawfnError("ELEMENT_NOT_FOUND", `Element ${id} was not found.`, {
          id,
        })
      );
      return;
    }

    const normalizedElement = normalizeElement(
      {
        ...this.scene.elements[index],
        ...patch,
      },
      index
    );
    if (!normalizedElement.ok) {
      this.emit("error", normalizedElement.error);
      return;
    }

    const previousScene = this.getScene();
    this.scene.elements[index] = normalizedElement.data;
    this.emit("elementUpdated", this.scene.elements[index]);
    if (this.activeGesture) {
      this.trackGestureMutation("update", [id]);
    } else {
      this.history.push(previousScene);
      this.emitHistoryChanged();
      this.emitSceneChanged("update", [id]);
    }
    this.scheduleRender();
  }

  remove(id: string): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) {
      this.emit(
        "error",
        createDrawfnError("ELEMENT_NOT_FOUND", `Element ${id} was not found.`, {
          id,
        })
      );
      return;
    }

    const previousScene = this.getScene();
    this.scene.elements.splice(index, 1);
    if (this.selectedIds.has(id)) {
      this.setSelection(this.getSelectedIds().filter((selectedId) => selectedId !== id));
    }
    this.emit("elementRemoved", id);
    if (this.activeGesture) {
      this.trackGestureMutation("remove", [id]);
    } else {
      this.history.push(previousScene);
      this.emitHistoryChanged();
      this.emitSceneChanged("remove", [id]);
    }
    this.scheduleRender();
  }

  bringToFront(id: string): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) {
      this.emit(
        "error",
        createDrawfnError("ELEMENT_NOT_FOUND", `Element ${id} was not found.`, {
          id,
        })
      );
      return;
    }
    if (index === this.scene.elements.length - 1) return;

    const previousScene = this.getScene();
    const [element] = this.scene.elements.splice(index, 1);
    this.scene.elements.push(element);
    this.history.push(previousScene);
    this.emitHistoryChanged();
    this.emitSceneChanged("reorder", [id]);
    this.scheduleRender();
  }

  sendToBack(id: string): void {
    const index = this.scene.elements.findIndex((el) => el.id === id);
    if (index === -1) {
      this.emit(
        "error",
        createDrawfnError("ELEMENT_NOT_FOUND", `Element ${id} was not found.`, {
          id,
        })
      );
      return;
    }
    if (index === 0) return;

    const previousScene = this.getScene();
    const [element] = this.scene.elements.splice(index, 1);
    this.scene.elements.unshift(element);
    this.history.push(previousScene);
    this.emitHistoryChanged();
    this.emitSceneChanged("reorder", [id]);
    this.scheduleRender();
  }

  setTool(tool: ToolName, opts?: any): void {
    this.toolManager.setTool(tool, opts);
  }

  getTool(): ToolName {
    return this.toolManager.getCurrentTool();
  }

  setCamera(camera: Partial<Camera>): void {
    const normalized = normalizeCamera({ ...this.scene.camera, ...camera });
    if (!normalized.ok) {
      this.emit("error", normalized.error);
      return;
    }
    this.scene.camera = normalized.data;
    this.emit("cameraChanged", this.scene.camera);
    this.emitSceneChanged("camera", []);
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
      prevScene.camera = { ...this.scene.camera };
      this.scene = prevScene;
      this.setSelection([]);
      this.emitHistoryChanged();
      this.emitSceneChanged("undo", []);
      this.scheduleRender();
    }
  }

  redo(): void {
    const nextScene = this.history.redo(this.scene);
    if (nextScene) {
      nextScene.camera = { ...this.scene.camera };
      this.scene = nextScene;
      this.setSelection([]);
      this.emitHistoryChanged();
      this.emitSceneChanged("redo", []);
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
      textTool.editElement(id, this.canvas, this.createToolContext());
    }
  }

  stageTextElement(element: Element): void {
    const existingIndex = this.scene.elements.findIndex((el) => el.id === element.id);
    if (existingIndex === -1) {
      this.scene.elements.push(deepClone(element));
    } else {
      this.scene.elements[existingIndex] = deepClone(element);
    }
    this.scheduleRender();
  }

  discardStagedTextElement(id: string): void {
    const index = this.scene.elements.findIndex((element) => element.id === id);
    if (index === -1) {
      return;
    }

    this.scene.elements.splice(index, 1);
    if (this.selectedIds.has(id)) {
      this.setSelection(this.getSelectedIds().filter((selectedId) => selectedId !== id));
    }
    this.scheduleRender();
  }

  private resolveExportElements(selectedOnly: boolean): DrawfnResult<Element[]> {
    const elements = selectedOnly
      ? this.scene.elements.filter((el) => this.selectedIds.has(el.id))
      : this.scene.elements;

    if (selectedOnly && elements.length === 0) {
      return {
        ok: false,
        error: createDrawfnError(
          "EXPORT_EMPTY_SELECTION",
          "Cannot export an empty selection.",
          { selectedOnly: true }
        ),
      };
    }

    return { ok: true, data: elements };
  }

  private failExport(error: DrawfnError): never {
    this.emit("error", error);
    throw error;
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
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(padding) || padding < 0) {
      return this.failExport(createDrawfnError("EXPORT_RENDER_FAILED", "Export scale must be positive and padding non-negative, both finite."));
    }
    const transparent = opts?.transparent ?? false;
    const selectedOnly = opts?.selectedOnly ?? false;
    const fitContent = opts?.fitContent ?? false;

    const exportElements = this.resolveExportElements(selectedOnly);
    if (!exportElements.ok) {
      return this.failExport(exportElements.error);
    }
    const elementsToExport = exportElements.data;

    let canvasWidth = this.canvas.width * scale;
    let canvasHeight = this.canvas.height * scale;
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
    tempCanvas.width = canvasWidth;
    tempCanvas.height = canvasHeight;
    const ctx = tempCanvas.getContext("2d");
    if (!ctx) {
      return this.failExport(
        createDrawfnError(
          "EXPORT_RENDER_FAILED",
          "Failed to create a 2D canvas context for PNG export."
        )
      );
    }

    // Create temporary scene with only elements to export
    const exportScene: Scene = {
      ...this.scene,
      elements: elementsToExport,
      camera: fitContent
        ? { x: offsetX * scale, y: offsetY * scale, zoom: scale }
        : { x: this.scene.camera.x * scale, y: this.scene.camera.y * scale, zoom: this.scene.camera.zoom * scale },
      background: transparent
        ? { color: "transparent" }
        : this.scene.background,
    };

    const tempRenderer = new Renderer(tempCanvas, this.getImageBitmap);
    try {
      await tempRenderer.preloadImages(elementsToExport);
      tempRenderer.render(exportScene);
    } catch (error) {
      const drawfnError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        "recoverable" in error
          ? (error as DrawfnError)
          : createDrawfnError("EXPORT_RENDER_FAILED", "Failed to export PNG.", {
              cause: error instanceof Error ? error.message : String(error),
            });
      return this.failExport(drawfnError);
    } finally {
      tempRenderer.dispose();
    }

    return new Promise((resolve, reject) => {
      tempCanvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        const error = createDrawfnError(
          "EXPORT_RENDER_FAILED",
          "Failed to export PNG."
        );
        this.emit("error", error);
        reject(error);
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
    selectedOnly?: boolean;
    fitContent?: boolean;
  }): Promise<string> {
    const padding = opts?.padding ?? 20;
    const scale = opts?.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(padding) || padding < 0) {
      return this.failExport(createDrawfnError("EXPORT_RENDER_FAILED", "Export scale must be positive and padding non-negative, both finite."));
    }
    const selectedOnly = opts?.selectedOnly ?? false;
    const fitContent = opts?.fitContent ?? false;
    const exportElements = this.resolveExportElements(selectedOnly);
    if (!exportElements.ok) {
      return this.failExport(exportElements.error);
    }
    const elementsToExport = exportElements.data;

    const bounds = fitContent
      ? this.getContentBounds(elementsToExport)
      : { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
    const viewBoxX = fitContent ? bounds.x - padding : 0;
    const viewBoxY = fitContent ? bounds.y - padding : 0;
    const viewBoxW = fitContent ? bounds.w + padding * 2 : this.canvas.width;
    const viewBoxH = fitContent ? bounds.h + padding * 2 : this.canvas.height;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewBoxW * scale}" height="${viewBoxH * scale}" viewBox="${viewBoxX} ${viewBoxY} ${viewBoxW} ${viewBoxH}">`;
    svg += `<rect x="${viewBoxX}" y="${viewBoxY}" width="${viewBoxW}" height="${viewBoxH}" fill="${this.escapeXml(this.scene.background.color)}"/>`;

    if (!fitContent) svg += `<g transform="translate(${this.scene.camera.x} ${this.scene.camera.y}) scale(${this.scene.camera.zoom})">`;
    for (const element of elementsToExport) {
      svg += this.elementToSVG(element);
    }

    if (!fitContent) svg += "</g>";
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

    const commonAttrs = `opacity="${element.opacity}" stroke="${this.escapeXml(element.stroke)}" stroke-width="${element.strokeWidth}" fill="${this.escapeXml(element.fill)}"${transform}`;

    switch (element.type) {
      case "rectangle":
        return `<rect x="${element.x}" y="${element.y}" width="${element.w}" height="${element.h}" ${commonAttrs}/>`;

      case "ellipse":
        const cx = element.x + element.w / 2;
        const cy = element.y + element.h / 2;
        return `<ellipse cx="${cx}" cy="${cy}" rx="${element.w / 2}" ry="${element.h / 2}" ${commonAttrs}/>`;

      case "text":
        const textEl = element as any;
        return `<text x="${element.x + (textEl.align === "center" ? element.w / 2 : textEl.align === "right" ? element.w : 0)}" text-anchor="${textEl.align === "center" ? "middle" : textEl.align === "right" ? "end" : "start"}" y="${element.y + textEl.fontSize}" font-family="${this.escapeXml(textEl.fontFamily)}" font-size="${textEl.fontSize}" ${commonAttrs}>${this.escapeXml(textEl.text)}</text>`;

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
          simulatePressure: freedraw.points.every((point: number[]) => point[2] === undefined),
          start: { taper: freedraw.style?.taperStart ?? 0 },
          end: { taper: freedraw.style?.taperEnd ?? 0 },
        });

        let pathData = `M ${stroke[0][0] + element.x} ${stroke[0][1] + element.y}`;
        for (let i = 1; i < stroke.length; i++) {
          pathData += ` L ${stroke[i][0] + element.x} ${stroke[i][1] + element.y}`;
        }
        pathData += " Z";

        return `<path d="${pathData}" fill="${this.escapeXml(element.stroke)}" opacity="${element.opacity}"${transform}/>`;
      }

      case "arrow": {
        const arrow = element as any;
        if (arrow.points.length < 2) return "";

        let pathData = `M ${arrow.points[0][0] + element.x} ${arrow.points[0][1] + element.y}`;
        for (let i = 1; i < arrow.points.length; i++) {
          pathData += ` L ${arrow.points[i][0] + element.x} ${arrow.points[i][1] + element.y}`;
        }

        let svg = `<path d="${pathData}" stroke="${this.escapeXml(element.stroke)}" stroke-width="${element.strokeWidth}" fill="none" opacity="${element.opacity}"${transform}/>`;

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

          svg += `<polygon points="${tip[0]},${tip[1]} ${left[0]},${left[1]} ${right[0]},${right[1]}" fill="${this.escapeXml(element.stroke)}" opacity="${element.opacity}"${transform}/>`;
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
          svg += `<text x="${element.x + 12}" y="${element.y + 24}" font-family="sans-serif" font-size="14" fill="${this.escapeXml(element.stroke)}" opacity="${element.opacity}"${transform}>${this.escapeXml(node.preview.title)}</text>`;
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

  getHistoryState(): HistoryChangedEvent {
    return {
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      depth: this.history.depth(),
    };
  }

  private emitHistoryChanged(): void {
    this.emit("historyChanged", this.getHistoryState());
  }

  private emitSceneChanged(
    reason: SceneChangeReason,
    changedElementIds: string[]
  ): void {
    this.emit("sceneChanged", {
      reason,
      scene: this.getScene(),
      changedElementIds,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
    });
  }

  private recordHistory(): void {
    this.beginGesture("update");
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
      setSelection: (ids: string[]) => this.setSelection(ids),
    };
  }

  private setupEventListeners(): void {
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointerup", this.handleWindowPointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.addEventListener("wheel", this.handleWheel);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.canvas.focus({ preventScroll: true });
    this.activePointerId = e.pointerId;
    this.pointerStart = { x: e.clientX, y: e.clientY };
    this.pointerMoved = false;
    this.pointerSelection = this.getSelectedIds();
    if (typeof this.canvas.setPointerCapture === "function") {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore pointer-capture failures and fall back to window-level completion.
      }
    }

    this.emit("pointerDown", e);
    const context = this.createToolContext();
    this.toolManager.handlePointerDown(e, context, this.selectedIds);
    this.scheduleRender();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.pointerStart && Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) > 4) this.pointerMoved = true;
    this.emit("pointerMove", e);
    const context = this.createToolContext();
    this.toolManager.handlePointerMove(e, context);
    this.scheduleRender();
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) {
      return;
    }

    const isClick = this.pointerStart !== null && !this.pointerMoved && Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) <= 4;
    this.pointerStart = null;
    this.activePointerId = null;
    this.emit("pointerUp", e);
    const context = this.createToolContext();
    this.toolManager.handlePointerUp(e, context);
    this.completeGesture();
    if (isClick && e.button === 0 && this.getTool() === "select" && this.onNodeClick) {
      const point = this.screenToCanvas({ x: e.clientX, y: e.clientY });
      const hit = [...this.scene.elements].reverse().find(element => isPointInOBB(point, element));
      if (hit?.type === "node") this.onNodeClick(hit.nodeId, deepClone(hit));
    }
    this.scheduleRender();
  };

  private handlePointerCancel = (e: PointerEvent): void => {
    if (this.activePointerId === null || e.pointerId !== this.activePointerId) return;
    this.toolManager.handlePointerCancel(e, this.createToolContext());
    const transaction = this.activeGesture;
    this.activeGesture = null;
    this.activePointerId = null;
    this.pointerStart = null;
    if (transaction) {
      const interrupted = new Map(this.scene.elements.map(element => [element.id, element]));
      transaction.snapshot.camera = { ...this.scene.camera };
      this.scene = transaction.snapshot;
      for (const id of transaction.changedElementIds) {
        const restored = this.scene.elements.find(element => element.id === id);
        if (!restored && interrupted.has(id)) this.emit("elementRemoved", id);
        else if (restored) this.emit(interrupted.has(id) ? "elementUpdated" : "elementAdded", restored);
      }
      this.emitSceneChanged("update", Array.from(transaction.changedElementIds));
    }
    this.setSelection(this.pointerSelection.filter(id => this.scene.elements.some(element => element.id === id)));
    this.scheduleRender();
  };

  private handleWindowPointerUp = (e: PointerEvent): void => {
    if (this.activePointerId === null || e.pointerId !== this.activePointerId) {
      return;
    }

    const forwarded = {
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      pressure: e.pressure,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      button: e.button,
      buttons: e.buttons,
      pointerType: e.pointerType,
      target: this.canvas,
      currentTarget: this.canvas,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
    } as unknown as PointerEvent;

    this.handlePointerUp(forwarded);
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const delta = e.deltaY * -0.001;
    const newZoom = clamp(
      this.scene.camera.zoom + delta,
      MIN_CAMERA_ZOOM,
      MAX_CAMERA_ZOOM
    );
    const rect = this.canvas.getBoundingClientRect();

    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      this.scene.camera,
      this.canvas
    );

    this.scene.camera.zoom = newZoom;
    this.scene.camera.x = (e.clientX - rect.left) * (rect.width > 0 ? this.canvas.width / rect.width : 1) - point.x * newZoom;
    this.scene.camera.y = (e.clientY - rect.top) * (rect.height > 0 ? this.canvas.height / rect.height : 1) - point.y * newZoom;

    this.emit("cameraChanged", this.scene.camera);
    this.emitSceneChanged("camera", []);
    this.scheduleRender();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    const isTextEntryTarget =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        /^(text|search|email|url|tel|password)$/i.test(target.type)) ||
      (target instanceof HTMLElement && target.isContentEditable);
    const isDrawfnInteractionTarget =
      target === this.canvas;
    if (!isDrawfnInteractionTarget) return;

    // Space-to-pan modality
    if (e.key === " " && !this.isSpacePressed && target === this.canvas) {
      e.preventDefault();
      this.isSpacePressed = true;
      this.toolBeforeSpace = this.getTool();
      this.setTool("pan");
      this.canvas.style.cursor = "grab";
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (isTextEntryTarget || !isDrawfnInteractionTarget) {
        return;
      }
      this.selectedIds.forEach((id) => {
        if (!this.scene.elements.find(element => element.id === id)?.locked) this.remove(id);
      });
    } else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      if (!isDrawfnInteractionTarget) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === "y") {
      if (!isDrawfnInteractionTarget) {
        return;
      }
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
    if (this.destroyed) return;
    this.needsRender = true;
    if (this.rafId !== null) return;

    this.rafId = requestAnimationFrame(() => {
      if (!this.destroyed && this.needsRender) {
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.dispose();
    this.canvasSizeObserver?.disconnect();
    if (this.originalTabIndex === null) this.canvas.removeAttribute("tabindex");
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    const textTool = this.toolManager.getTool("text");
    textTool?.deactivate();
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointerup", this.handleWindowPointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.listeners.clear();
  }

  getSelectedIds(): string[] {
    return Array.from(this.selectedIds);
  }

  setSelection(ids: string[]): void {
    const nextIds = Array.from(new Set(ids));
    const currentIds = this.getSelectedIds();
    const changed =
      currentIds.length !== nextIds.length ||
      currentIds.some((id, index) => id !== nextIds[index]);

    if (!changed) {
      return;
    }

    this.selectedIds = new Set(nextIds);
    this.emit("selectionChanged", nextIds);
    this.scheduleRender();
  }

  getElements(): Element[] {
    return [...this.scene.elements];
  }

  getElementById(id: string): Element | undefined {
    return this.scene.elements.find((el) => el.id === id);
  }
}
