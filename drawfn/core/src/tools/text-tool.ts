import { BaseTool } from "./base-tool";
import type { TextElement, ToolContext } from "../types";
import { canvasToScreen, generateId, screenToCanvas } from "../utils";

type TextEditSession = {
  mode: "create" | "edit";
  element: TextElement;
  context: ToolContext;
  blurHandler: () => void;
  outsideClickHandler: (event: MouseEvent) => void;
  outsideClickTimer: number | null;
};

export class TextTool extends BaseTool {
  name = "text";
  private overlayRoot: HTMLElement | null = null;
  private activeTextarea: HTMLTextAreaElement | null = null;
  private activeSession: TextEditSession | null = null;

  constructor(overlayRoot?: HTMLElement) {
    super();
    this.overlayRoot = overlayRoot || document.body;
  }

  handlePointerDown(e: PointerEvent, context: ToolContext): void {
    e.preventDefault();
    this.commitText();

    const canvas = e.target as HTMLCanvasElement;
    const scene = context.getScene();
    const point = screenToCanvas(
      { x: e.clientX, y: e.clientY },
      scene.camera,
      canvas
    );

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

    context.getDrawfn().stageTextElement(element);
    this.showTextInput(canvas, context, element, "create");
  }

  editElement(id: string, canvas: HTMLCanvasElement, context: ToolContext): void {
    this.commitText();

    const scene = context.getScene();
    const element = scene.elements.find((el: any) => el.id === id);
    if (!element || element.type !== "text") return;

    this.showTextInput(canvas, context, element, "edit");
    this.activeTextarea?.select();
  }

  private showTextInput(
    canvas: HTMLCanvasElement,
    context: ToolContext,
    element: TextElement,
    mode: "create" | "edit"
  ): void {
    if (!this.overlayRoot) return;

    const scene = context.getScene();
    const textarea = document.createElement("textarea");
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? rect.width / canvas.width : 1;
    const scaleY = rect.height > 0 ? rect.height / canvas.height : 1;
    const screenPoint = canvasToScreen({ x: element.x, y: element.y }, scene.camera);

    Object.assign(textarea.style, {
      position: "fixed",
      left: `${screenPoint.x * scaleX + rect.left}px`,
      top: `${screenPoint.y * scaleY + rect.top}px`,
      width: `${element.w * scene.camera.zoom * scaleX}px`,
      minHeight: `${element.h * scene.camera.zoom * scaleY}px`,
      font: `${element.fontSize * scene.camera.zoom * scaleY}px ${element.fontFamily}`,
      color: element.fill,
      background: "transparent",
      border: "2px solid #3b82f6",
      outline: "none",
      resize: "none",
      padding: "4px",
      zIndex: "10000",
    });

    textarea.value = element.text;

    this.activeTextarea = textarea;
    this.overlayRoot.appendChild(textarea);

    const blurHandler = () => {
      this.commitText();
    };
    const outsideClickHandler = (e: MouseEvent) => {
      if (e.target !== textarea) {
        this.commitText();
      }
    };

    this.activeSession = {
      mode,
      element,
      context,
      blurHandler,
      outsideClickHandler,
      outsideClickTimer: null,
    };

    textarea.addEventListener("blur", blurHandler);
    textarea.focus();

    this.activeSession.outsideClickTimer = window.setTimeout(() => {
      document.addEventListener("pointerdown", outsideClickHandler);
    }, 0);
  }

  private cleanupSession(revertProvisional: boolean): void {
    const session = this.activeSession;
    const textarea = this.activeTextarea;

    if (session?.outsideClickTimer != null) {
      window.clearTimeout(session.outsideClickTimer);
    }

    if (textarea && session) {
      textarea.removeEventListener("blur", session.blurHandler);
    }
    if (session) {
      document.removeEventListener("pointerdown", session.outsideClickHandler);
      if (revertProvisional && session.mode === "create") {
        session.context.getDrawfn().discardStagedTextElement(session.element.id);
      }
    }

    textarea?.remove();
    this.activeTextarea = null;
    this.activeSession = null;
  }

  private commitText(): void {
    if (!this.activeTextarea || !this.activeSession) {
      this.cleanupSession(false);
      return;
    }

    const session = this.activeSession;
    const text = this.activeTextarea.value;

    this.cleanupSession(false);

    if (session.mode === "create") {
      session.context.getDrawfn().discardStagedTextElement(session.element.id);
      if (text.trim() !== "") {
        session.context.getDrawfn().commitTextElement({ ...session.element, text }, true);
      }
    } else {
      const latest = session.context
        .getScene()
        .elements.find((element) => element.id === session.element.id);
      if (latest?.type === "text" && latest.text !== text) {
        session.context.getDrawfn().commitTextElement({ ...latest, text }, false);
      }
    }
  }

  deactivate(): void {
    this.cleanupSession(true);
    super.deactivate();
  }
}
