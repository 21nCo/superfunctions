export type ElementType =
  | "freedraw"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text"
  | "image"
  | "node";

export type BaseElement = {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  stroke: string;
  fill: string | "transparent";
  strokeWidth: number;
  opacity: number;
  locked?: boolean;
  meta?: Record<string, any>;
};

export type FreeDrawElement = BaseElement & {
  type: "freedraw";
  points: [number, number, number?][];
  style?: {
    size?: number;
    thinning?: number;
    smoothing?: number;
    streamline?: number;
    taperStart?: number;
    taperEnd?: number;
  };
};

export type RectangleElement = BaseElement & {
  type: "rectangle";
};

export type EllipseElement = BaseElement & {
  type: "ellipse";
};

export type TextElement = BaseElement & {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  align: "left" | "center" | "right";
};

export type ImageElement = BaseElement & {
  type: "image";
  src: string;
  naturalW?: number;
  naturalH?: number;
};

export type ArrowElement = BaseElement & {
  type: "arrow";
  points: [number, number][];
  head: "triangle" | "none";
};

export type NodeElement = BaseElement & {
  type: "node";
  nodeId: string;
  nodeType?: string;
  variant?: "bookmark" | "embed" | "card";
  preview?: {
    title?: string;
    icon?: string;
    excerpt?: string;
  };
};

export type Element =
  | FreeDrawElement
  | RectangleElement
  | EllipseElement
  | TextElement
  | ImageElement
  | ArrowElement
  | NodeElement;

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Background = {
  color: string;
  grid?: {
    size: number;
    color: string;
    alpha: number;
  };
};

export type Scene = {
  version: 1;
  id: string;
  elements: Element[];
  camera: Camera;
  background: Background;
};

export type ToolName =
  | "select"
  | "pan"
  | "pen"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text"
  | "image"
  | "node";

export type DrawfnEventMap = {
  pointerDown: [PointerEvent];
  pointerMove: [PointerEvent];
  pointerUp: [PointerEvent];
  elementAdded: [Element];
  elementUpdated: [Element];
  elementRemoved: [string];
  selectionChanged: [string[]];
  historyChanged: [{ canUndo: boolean; canRedo: boolean }];
  cameraChanged: [Camera];
};

export type DrawfnEvent = keyof DrawfnEventMap;

export type Point = {
  x: number;
  y: number;
};

export type Bounds = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * ToolContext provides safe mutation methods for tools.
 * Tools should use this instead of directly mutating the scene.
 * This ensures events are emitted, history is recorded, and rendering is scheduled.
 */
export interface ToolContext {
  /** Add a new element to the scene */
  addElement(element: Element): string;

  /** Update an existing element */
  updateElement(id: string, patch: Partial<Element>): void;

  /** Remove an element from the scene */
  removeElement(id: string): void;

  /** Record current state in history */
  recordHistory(): void;

  /** Get read-only copy of the scene */
  getScene(): Scene;

  /** Get read-only copy of the camera */
  getCamera(): Camera;

  /** Get reference to the Drawfn instance for advanced operations */
  getDrawfn(): any;

  /** Get current selection */
  getSelection(): Set<string>;
}
