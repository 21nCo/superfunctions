import { Transaction as MdfnTransaction, type EditorController } from "@mdfn/core";
import { baseKeymap, createParagraphNear, exitCode, liftEmptyBlock, newlineInCode, setBlockType, splitBlock, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState as PmEditorState, type Command as PmCommand } from "prosemirror-state";
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
}

export interface DomEditor {
  readonly view: EditorView;
  run(command: DomCommand): boolean;
  can(command: DomCommand): boolean;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

function commandMap(): Readonly<Record<DomCommand, PmCommand>> {
  return {
    undo,
    redo,
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

function sanitizePastedHtml(html: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  document.querySelectorAll("script,style,iframe,object,embed").forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (["href", "src"].includes(attribute.name.toLowerCase()) && /^\s*(?:javascript|vbscript|data):/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  });
  return document.body.innerHTML;
}

export function createDomEditor(options: DomEditorOptions): DomEditor {
  if (typeof document === "undefined") throw new Error("MDFN_DOM_BROWSER_REQUIRED");
  let readOnly = options.readOnly ?? false;
  let syncing = false;
  const commands = commandMap();
  const plugins = [
    history(),
    keymap({
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
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
    },
    dispatchTransaction(transaction) {
      const next = view.state.apply(transaction);
      const before = view.state.doc;
      view.updateState(next);
      if (!transaction.docChanged || syncing) return;
      const document = proseMirrorToDocument(next.doc, before, options.controller.getState().document.schemaVersion);
      options.controller.dispatch(new MdfnTransaction().replaceDocument(document).withSource("visual"));
      previousPmDocument = next.doc;
    },
  });

  const unsubscribe = options.controller.subscribe((change) => {
    if (change.source === "visual") return;
    const nextDoc = documentToProseMirror(change.current.document);
    if (view.state.doc.eq(nextDoc)) return;
    syncing = true;
    previousPmDocument = nextDoc;
    view.updateState(PmEditorState.create({ schema: mdfnSchema, doc: nextDoc, plugins }));
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
    focus() { view.focus(); },
    setReadOnly(value) { readOnly = value; view.setProps({ editable: () => !readOnly }); },
    destroy() { unsubscribe(); view.destroy(); },
  };
}

export { mdfnSchema, documentToProseMirror, proseMirrorToDocument } from "./schema";
export const MDFN_DOM_VERSION = "0.1.0" as const;
