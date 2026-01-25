import { BaseTool } from "./base-tool";
import type { TextElement, Point, ToolContext } from "../types";
import { generateId, screenToCanvas } from "../utils";

export class TextTool extends BaseTool {
  name = "text";
  private overlayRoot: HTMLElement | null = null;
  private activeTextarea: HTMLTextAreaElement | null = null;
  private activeElementId: string | null = null;
  private activeContext: ToolContext | null = null;

  constructor(overlayRoot?: HTMLElement) {
    super();
    this.overlayRoot = overlayRoot || document.body;
  }

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    if (this.activeTextarea && this.activeContext) {
      this.commitText(this.activeContext);
    }

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

    context.recordHistory();

    const element: TextElement = {
      id: generateId(),
      type: "text",
      x: point.x,
      y: point.y,
      w: 200,
      h: 40,
      rotation: 0,
      stroke: "#000000",
      fill: "#000000",
      strokeWidth: 0,
      opacity: 1,
      text: "",
      fontFamily: "sans-serif",
      fontSize: 16,
      align: "left",
    };

    this.activeElementId = context.addElement(element);
    this.activeContext = context;

    this.showTextInput(canvas, context, element);
  }

  editElement(id: string, canvas: HTMLCanvasElement, scene: any): void {
    const element = scene.elements.find((el: any) => el.id === id);
    if (!element || element.type !== "text") return;

    // Create a temporary context for editing
    // Note: This is a simplified approach - in production you'd want proper context
    this.activeElementId = id;

    // Show text input for existing element
    const textarea = document.createElement("textarea");
    const rect = canvas.getBoundingClientRect();

    const screenX = element.x * scene.camera.zoom + scene.camera.x + rect.left;
    const screenY = element.y * scene.camera.zoom + scene.camera.y + rect.top;

    Object.assign(textarea.style, {
      position: "fixed",
      left: `${screenX}px`,
      top: `${screenY}px`,
      width: `${element.w * scene.camera.zoom}px`,
      minHeight: `${element.h * scene.camera.zoom}px`,
      font: `${element.fontSize * scene.camera.zoom}px ${element.fontFamily}`,
      color: element.fill,
      background: "transparent",
      border: "2px solid #3b82f6",
      outline: "none",
      resize: "none",
      padding: "4px",
      zIndex: "10000",
    });

    textarea.value = element.text;
    textarea.focus();
    textarea.select(); // Select all text for easy editing

    this.activeTextarea = textarea;
    if (this.overlayRoot) {
      this.overlayRoot.appendChild(textarea);
    }

    // Handle blur to commit changes
    const handleBlur = () => {
      if (this.activeTextarea && this.activeElementId) {
        element.text = this.activeTextarea.value;
        this.activeTextarea.remove();
        this.activeTextarea = null;
        this.activeElementId = null;
      }
    };

    textarea.addEventListener("blur", handleBlur);
  }

  private showTextInput(
    canvas: HTMLCanvasElement,
    context: ToolContext,
    element: TextElement
  ): void {
    if (!this.overlayRoot) return;

    const scene = context.getScene();
    const textarea = document.createElement("textarea");
    const rect = canvas.getBoundingClientRect();

    const screenX = element.x * scene.camera.zoom + scene.camera.x + rect.left;
    const screenY = element.y * scene.camera.zoom + scene.camera.y + rect.top;

    Object.assign(textarea.style, {
      position: "fixed",
      left: `${screenX}px`,
      top: `${screenY}px`,
      width: `${element.w * scene.camera.zoom}px`,
      minHeight: `${element.h * scene.camera.zoom}px`,
      font: `${element.fontSize * scene.camera.zoom}px ${element.fontFamily}`,
      color: element.fill,
      background: "transparent",
      border: "2px solid #3b82f6",
      outline: "none",
      resize: "none",
      padding: "4px",
      zIndex: "10000",
    });

    textarea.value = element.text;
    textarea.focus();

    this.activeTextarea = textarea;
    this.overlayRoot.appendChild(textarea);

    const handleClickOutside = (e: MouseEvent) => {
      if (e.target !== textarea) {
        this.commitText(context);
        document.removeEventListener("click", handleClickOutside);
      }
    };

    textarea.addEventListener("blur", () => {
      this.commitText(context);
      document.removeEventListener("click", handleClickOutside);
    });

    setTimeout(() => {
      document.addEventListener("click", handleClickOutside);
    }, 0);
  }

  private commitText(context: ToolContext): void {
    if (!this.activeTextarea || !this.activeElementId) return;

    const text = this.activeTextarea.value;

    if (text.trim() === "") {
      context.removeElement(this.activeElementId);
    } else {
      context.updateElement(this.activeElementId, { text });
    }

    this.activeTextarea.remove();
    this.activeTextarea = null;
    this.activeElementId = null;
    this.activeContext = null;
  }

  deactivate(): void {
    if (this.activeTextarea) {
      this.activeTextarea.remove();
      this.activeTextarea = null;
    }
    this.activeElementId = null;
    this.activeContext = null;
    super.deactivate();
  }
}
