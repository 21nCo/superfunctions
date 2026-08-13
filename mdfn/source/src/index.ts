import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic as CodeMirrorDiagnostic } from "@codemirror/lint";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState as CodeMirrorState } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { Transaction, type EditorController } from "@mdfn/core";
import { renderHtml, type RenderPolicy } from "@mdfn/render";

export type EditorMode = "visual" | "source" | "split" | "preview" | "read-only";

export interface SourceEditorOptions {
  readonly target: HTMLElement;
  readonly controller: EditorController;
  readonly readOnly?: boolean;
  readonly lineNumbers?: boolean;
  readonly ariaLabel?: string;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
}

export interface SourceEditor {
  readonly view: EditorView;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

function diagnostics(controller: EditorController): CodeMirrorDiagnostic[] {
  const length = controller.getState().markdown.length;
  return controller.getState().diagnostics.map((entry) => ({
    from: Math.max(0, Math.min(length, entry.source?.from ?? 0)),
    to: Math.max(0, Math.min(length, entry.source?.to ?? entry.source?.from ?? 0)),
    severity: entry.severity === "error" ? "error" : entry.severity === "warning" ? "warning" : "info",
    message: entry.message,
    source: entry.extension ?? "mdfn",
  }));
}

function smallestSourceChange(previous: string, next: string): { from: number; to: number; insert: string } | undefined {
  if (previous === next) return undefined;
  let from = 0;
  const shared = Math.min(previous.length, next.length);
  while (from < shared && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let previousTo = previous.length;
  let nextTo = next.length;
  while (previousTo > from && nextTo > from && previous.charCodeAt(previousTo - 1) === next.charCodeAt(nextTo - 1)) {
    previousTo -= 1;
    nextTo -= 1;
  }
  return { from, to: previousTo, insert: next.slice(from, nextTo) };
}

export function createSourceEditor(options: SourceEditorOptions): SourceEditor {
  if (typeof document === "undefined") throw new Error("MDFN_SOURCE_BROWSER_REQUIRED");
  let syncing = false;
  const editable = new Compartment();
  const extensions = [
    options.lineNumbers === false ? [] : lineNumbers(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage }),
    history(),
    lintGutter(),
    linter(() => diagnostics(options.controller), { delay: 100 }),
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    editable.of(EditorView.editable.of(!(options.readOnly ?? false))),
    EditorView.contentAttributes.of({ "aria-label": options.ariaLabel ?? "Markdown source", "data-mdfn-editor": "source" }),
    EditorView.domEventHandlers({
      focus: () => { options.onFocus?.(); return false; },
      blur: () => { options.onBlur?.(); return false; },
    }),
    EditorView.updateListener.of((update) => {
      if (syncing || (!update.docChanged && !update.selectionSet)) return;
      let transaction = new Transaction().withSource("source");
      if (update.docChanged) {
        const previous = options.controller.getState().markdown;
        const change = smallestSourceChange(previous, update.state.doc.toString());
        if (change) transaction = transaction.replaceSource(change.from, change.to, change.insert);
      }
      const main = update.state.selection.main;
      transaction = transaction.setSelection({ kind: "text", anchor: main.anchor, head: main.head });
      options.controller.dispatch(transaction);
    }),
  ];
  const view = new EditorView({
    parent: options.target,
    state: CodeMirrorState.create({ doc: options.controller.getState().markdown, extensions }),
  });
  const unsubscribe = options.controller.subscribe((change) => {
    if (change.source === "source") return;
    const current = view.state.doc.toString();
    const selection = change.current.selection?.kind === "text"
      ? { anchor: change.current.selection.anchor, head: change.current.selection.head }
      : undefined;
    const documentChanged = current !== change.current.markdown;
    if (!documentChanged && !change.selectionChanged) return;
    syncing = true;
    view.dispatch({
      ...(documentChanged ? { changes: { from: 0, to: current.length, insert: change.current.markdown } } : {}),
      ...(selection ? { selection } : {}),
    });
    syncing = false;
  });
  return {
    view,
    focus() { view.focus(); },
    setReadOnly(readOnly) { view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!readOnly)) }); },
    destroy() { unsubscribe(); view.destroy(); },
  };
}

export interface PreviewResult {
  readonly html: string;
  readonly diagnostics: ReturnType<typeof renderHtml>["diagnostics"];
}

export function createPreview(controller: EditorController, policy?: RenderPolicy): PreviewResult {
  const rendered = renderHtml(controller.getState().document, policy);
  return { html: rendered.html, diagnostics: rendered.diagnostics };
}

export interface ModeController {
  getMode(): EditorMode;
  setMode(mode: EditorMode): void;
  subscribe(listener: (mode: EditorMode) => void): () => void;
  destroy(): void;
}

export function createModeController(initial: EditorMode = "visual"): ModeController {
  let mode = initial;
  let destroyed = false;
  const listeners = new Set<(mode: EditorMode) => void>();
  return {
    getMode() { if (destroyed) throw new Error("MDFN_MODE_CONTROLLER_DESTROYED"); return mode; },
    setMode(next) { if (destroyed) throw new Error("MDFN_MODE_CONTROLLER_DESTROYED"); if (next === mode) return; mode = next; listeners.forEach((listener) => listener(mode)); },
    subscribe(listener) { if (destroyed) throw new Error("MDFN_MODE_CONTROLLER_DESTROYED"); listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { destroyed = true; listeners.clear(); },
  };
}

export const MDFN_SOURCE_VERSION = "0.1.0" as const;

export const sourceInternals = Object.freeze({ smallestSourceChange });
