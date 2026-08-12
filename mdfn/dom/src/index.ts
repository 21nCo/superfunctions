import { Transaction as MdfnTransaction, inspectMdfnUrl, type EditorController } from "@mdfn/core";
import { baseKeymap, createParagraphNear, exitCode, liftEmptyBlock, newlineInCode, setBlockType, splitBlock, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState as PmEditorState, TextSelection as PmTextSelection, type Command as PmCommand } from "prosemirror-state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, tableEditing } from "prosemirror-tables";
import { EditorView } from "prosemirror-view";
import { documentToProseMirror, mdfnSchema, proseMirrorToDocument } from "./schema";

export type DomCommand =
  | "undo" | "redo" | "bold" | "italic" | "strike" | "inline-code"
  | "paragraph" | "heading-1" | "heading-2" | "heading-3" | "blockquote" | "code-block"
  | "bullet-list" | "ordered-list" | "split-list-item" | "sink-list-item" | "lift-list-item"
  | "add-table-column" | "delete-table-column" | "add-table-row" | "delete-table-row";

export interface DomEditorOptions {
  readonly target: HTMLElement;
  readonly controller: EditorController;
  readonly readOnly?: boolean;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  readonly onFiles?: (files: readonly File[]) => void | Promise<void>;
}

export interface DomEditor {
  readonly view: EditorView;
  run(command: DomCommand): boolean;
  can(command: DomCommand): boolean;
  setLink(href: string, title?: string): boolean;
  removeLink(): boolean;
  insertTable(rows?: number, columns?: number): boolean;
  insertMarkdown(markdown: string): boolean;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

function controllerHistoryCommand(controller: EditorController, direction: "undo" | "redo"): PmCommand {
  return (_state, dispatch) => {
    const available = direction === "undo" ? controller.canUndo() : controller.canRedo();
    if (!available || !dispatch) return available;
    return direction === "undo" ? controller.undo() : controller.redo();
  };
}

function commandMap(controller: EditorController): Readonly<Record<DomCommand, PmCommand>> {
  return {
    undo: controllerHistoryCommand(controller, "undo"),
    redo: controllerHistoryCommand(controller, "redo"),
    bold: toggleMark(mdfnSchema.marks.strong),
    italic: toggleMark(mdfnSchema.marks.em),
    strike: toggleMark(mdfnSchema.marks.strike),
    "inline-code": toggleMark(mdfnSchema.marks.code),
    paragraph: setBlockType(mdfnSchema.nodes.paragraph),
    "heading-1": setBlockType(mdfnSchema.nodes.heading, { level: 1 }),
    "heading-2": setBlockType(mdfnSchema.nodes.heading, { level: 2 }),
    "heading-3": setBlockType(mdfnSchema.nodes.heading, { level: 3 }),
    blockquote: wrapIn(mdfnSchema.nodes.blockquote),
    "code-block": setBlockType(mdfnSchema.nodes.code_block),
    "bullet-list": wrapInList(mdfnSchema.nodes.bullet_list),
    "ordered-list": wrapInList(mdfnSchema.nodes.ordered_list),
    "split-list-item": splitListItem(mdfnSchema.nodes.list_item),
    "sink-list-item": sinkListItem(mdfnSchema.nodes.list_item),
    "lift-list-item": liftListItem(mdfnSchema.nodes.list_item),
    "add-table-column": addColumnAfter,
    "delete-table-column": deleteColumn,
    "add-table-row": addRowAfter,
    "delete-table-row": deleteRow,
  };
}

function topLevelStart(doc: import("prosemirror-model").Node, childIndex: number): number {
  let position = 0;
  for (let index = 0; index < childIndex; index += 1) position += doc.child(index).nodeSize;
  return position;
}

function pmPositionToSource(state: PmEditorState, position: number, fallback: number): number {
  const resolved = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
  const index = Math.min(resolved.index(0), state.doc.childCount - 1);
  if (index < 0) return 0;
  const node = state.doc.child(index);
  const from = node.attrs.mdfnFrom;
  const to = node.attrs.mdfnTo;
  if (typeof from !== "number" || typeof to !== "number") return Math.max(0, Math.min(position, fallback));
  const contentStart = topLevelStart(state.doc, index) + 1;
  return Math.max(from, Math.min(to, from + Math.max(0, position - contentStart)));
}

function selectionFromPm(state: PmEditorState, markdownLength: number) {
  return {
    kind: "text" as const,
    anchor: pmPositionToSource(state, state.selection.anchor, markdownLength),
    head: pmPositionToSource(state, state.selection.head, markdownLength),
  };
}

function sourcePositionToPm(doc: import("prosemirror-model").Node, sourcePosition: number): number {
  let position = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    const from = child.attrs.mdfnFrom;
    const to = child.attrs.mdfnTo;
    if (typeof from === "number" && typeof to === "number" && sourcePosition >= from && sourcePosition <= to) {
      return Math.max(position + 1, Math.min(position + 1 + child.content.size, position + 1 + sourcePosition - from));
    }
    position += child.nodeSize;
  }
  return Math.max(1, Math.min(doc.content.size, sourcePosition + 1));
}

export function sanitizePastedHtml(html: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  document.querySelectorAll("script,style,iframe,object,embed").forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      const name = attribute.name.toLowerCase();
      if (name === "href" && !inspectMdfnUrl(attribute.value, { allowedSchemes: ["http", "https", "mailto"], allowRelative: true }).safe) element.removeAttribute(attribute.name);
      if (name === "src" && !inspectMdfnUrl(attribute.value, { allowedSchemes: ["http", "https"], allowRelative: true }).safe) element.removeAttribute(attribute.name);
    }
  });
  return document.body.innerHTML;
}

export function createDomEditor(options: DomEditorOptions): DomEditor {
  if (typeof document === "undefined") throw new Error("MDFN_DOM_BROWSER_REQUIRED");
  let readOnly = options.readOnly ?? false;
  let syncing = false;
  const commands = commandMap(options.controller);
  const plugins = [
    keymap({
      "Mod-z": commands.undo,
      "Shift-Mod-z": commands.redo,
      "Mod-y": commands.redo,
      "Mod-b": commands.bold,
      "Mod-i": commands.italic,
      "Mod-`": commands["inline-code"],
      Enter: splitListItem(mdfnSchema.nodes.list_item),
      "Mod-[": liftListItem(mdfnSchema.nodes.list_item),
      "Mod-]": sinkListItem(mdfnSchema.nodes.list_item),
    }),
    keymap({ Enter: createParagraphNear, "Mod-Enter": exitCode, Backspace: liftEmptyBlock, "Shift-Enter": newlineInCode, "Mod-Shift-\\": splitBlock }),
    keymap(baseKeymap),
    tableEditing(),
    gapCursor(),
    dropCursor(),
  ];
  let previousPmDocument = documentToProseMirror(options.controller.getState().document);
  const state = PmEditorState.create({ schema: mdfnSchema, doc: previousPmDocument, plugins });
  const view = new EditorView(options.target, {
    state,
    editable: () => !readOnly,
    attributes: { role: "textbox", "aria-multiline": "true", "data-mdfn-editor": "visual", ...(options.attributes ?? {}) },
    transformPastedHTML: sanitizePastedHtml,
    handleDOMEvents: {
      focus: () => { options.onFocus?.(); return false; },
      blur: () => { options.onBlur?.(); return false; },
      drop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (files.length === 0) return false;
        event.preventDefault();
        if (options.onFiles && !readOnly) void options.onFiles(files);
        return true;
      },
      paste: (_view, event) => {
        const files = [...((event as ClipboardEvent).clipboardData?.files ?? [])];
        if (files.length === 0) return false;
        event.preventDefault();
        if (options.onFiles && !readOnly) void options.onFiles(files);
        return true;
      },
    },
    dispatchTransaction(transaction) {
      const next = view.state.apply(transaction);
      const before = view.state.doc;
      view.updateState(next);
      if (syncing) return;
      let edit = new MdfnTransaction().withSource(transaction.docChanged ? "visual:document" : "visual:selection");
      if (transaction.docChanged) {
        const document = proseMirrorToDocument(next.doc, before, options.controller.getState().document.schemaVersion);
        edit = edit.replaceDocument(document);
        previousPmDocument = next.doc;
      }
      if (transaction.selectionSet || transaction.docChanged) edit = edit.setSelection(selectionFromPm(next, options.controller.getState().markdown.length));
      if (edit.operations.length > 0) options.controller.dispatch(edit);
    },
  });

  const unsubscribe = options.controller.subscribe((change) => {
    if (change.source.startsWith("visual:")) return;
    if (!change.documentChanged && change.selectionChanged && change.current.selection?.kind === "text") {
      const anchor = sourcePositionToPm(view.state.doc, change.current.selection.anchor);
      const head = sourcePositionToPm(view.state.doc, change.current.selection.head);
      const selection = PmTextSelection.create(view.state.doc, anchor, head);
      view.updateState(view.state.apply(view.state.tr.setSelection(selection).setMeta("addToHistory", false)));
      return;
    }
    const nextDoc = documentToProseMirror(change.current.document);
    if (view.state.doc.eq(nextDoc)) return;
    syncing = true;
    previousPmDocument = nextDoc;
    const nextState = PmEditorState.create({ schema: mdfnSchema, doc: nextDoc, plugins });
    if (change.current.selection?.kind === "text") {
      const anchor = sourcePositionToPm(nextDoc, change.current.selection.anchor);
      const head = sourcePositionToPm(nextDoc, change.current.selection.head);
      view.updateState(nextState.apply(nextState.tr.setSelection(PmTextSelection.create(nextDoc, anchor, head))));
    } else view.updateState(nextState);
    syncing = false;
  });

  return {
    view,
    run(command) {
      if (readOnly) return false;
      const resolved = commands[command];
      return resolved(view.state, view.dispatch, view);
    },
    can(command) {
      if (readOnly) return false;
      return commands[command](view.state, undefined, view);
    },
    setLink(href, title) {
      if (readOnly || !inspectMdfnUrl(href, { allowedSchemes: ["http", "https", "mailto"], allowRelative: true }).safe) return false;
      return toggleMark(mdfnSchema.marks.link, { href, title: title ?? null })(view.state, view.dispatch, view);
    },
    removeLink() {
      if (readOnly) return false;
      const { from, to } = view.state.selection;
      if (from === to) return false;
      view.dispatch(view.state.tr.removeMark(from, to, mdfnSchema.marks.link));
      return true;
    },
    insertTable(rows = 2, columns = 2) {
      if (readOnly || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 100 || columns > 100) return false;
      const tableRows = Array.from({ length: rows }, () => mdfnSchema.nodes.table_row.create(
        null,
        Array.from({ length: columns }, () => mdfnSchema.nodes.table_cell.create(
          null,
          mdfnSchema.nodes.paragraph.create(),
        )),
      ));
      const table = mdfnSchema.nodes.table.create(null, tableRows);
      view.dispatch(view.state.tr.replaceSelectionWith(table).scrollIntoView());
      return true;
    },
    insertMarkdown(markdown) {
      if (readOnly) return false;
      const state = options.controller.getState();
      const selection = state.selection?.kind === "text" ? state.selection : { anchor: state.markdown.length, head: state.markdown.length };
      const from = Math.min(selection.anchor, selection.head);
      const to = Math.max(selection.anchor, selection.head);
      options.controller.dispatch(new MdfnTransaction().replaceSource(from, to, markdown).setSelection({ kind: "text", anchor: from + markdown.length, head: from + markdown.length }).withSource("visual:insert-markdown"));
      return true;
    },
    focus() { view.focus(); },
    setReadOnly(value) { readOnly = value; view.setProps({ editable: () => !readOnly }); },
    destroy() { unsubscribe(); view.destroy(); },
  };
}

export { mdfnSchema, documentToProseMirror, proseMirrorToDocument } from "./schema";
export const MDFN_DOM_VERSION = "0.1.0" as const;
