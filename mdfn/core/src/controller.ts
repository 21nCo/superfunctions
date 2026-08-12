import { applyTransaction, Transaction } from "./transaction";
import type {
  EditorCommand,
  EditorListener,
  EditorProjector,
  EditorState,
  MdfnExtension,
  StateChange,
  MdfnSelection,
  MdfnSidecar,
} from "./types";
import { resolveExtensions, type ResolvedExtensionRegistry } from "./extensions";
import { createEditorState } from "./state";

export interface EditorController {
  getState(): EditorState;
  dispatch(transaction: Transaction): StateChange;
  subscribe(listener: EditorListener): () => void;
  can(command: string): boolean;
  run(command: string): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
  markSaved(): void;
  destroy(): void;
  readonly extensions: ResolvedExtensionRegistry;
}

export interface CreateEditorInput {
  readonly markdown: string;
  readonly projector: EditorProjector;
  readonly extensions?: readonly MdfnExtension[];
  readonly historyLimit?: number;
  readonly selection?: MdfnSelection;
  readonly sidecar?: MdfnSidecar;
}

export function createEditor(input: CreateEditorInput): EditorController {
  const extensions = resolveExtensions(input.extensions ?? []);
  let state = createEditorState({ markdown: input.markdown, projector: input.projector, schemaHash: extensions.schemaHash, selection: input.selection, sidecar: input.sidecar });
  const listeners = new Set<EditorListener>();
  const undoStack: EditorState[] = [];
  const redoStack: EditorState[] = [];
  const historyLimit = Math.max(1, input.historyLimit ?? 100);
  let destroyed = false;

  const assertAlive = (): void => {
    if (destroyed) throw new Error("MDFN_EDITOR_DESTROYED");
  };

  const notify = (change: StateChange): void => {
    for (const listener of [...listeners]) listener(change);
  };

  const restore = (next: EditorState, source: string): boolean => {
    const previous = state;
    state = Object.freeze({ ...next, version: previous.version + 1 });
    notify({
      previous,
      current: state,
      changedRanges: [{ from: 0, to: previous.markdown.length, insertedLength: state.markdown.length }],
      documentChanged: true,
      selectionChanged: previous.selection !== state.selection,
      sidecarChanged: previous.sidecar !== state.sidecar,
      source,
      metadata: {},
    });
    return true;
  };

  const controller: EditorController = {
    extensions,
    getState() {
      assertAlive();
      return state;
    },
    dispatch(transaction) {
      assertAlive();
      const change = applyTransaction(state, transaction, input.projector);
      if (change.current !== state) {
        if (change.documentChanged || change.sidecarChanged) {
          undoStack.push(state);
          if (undoStack.length > historyLimit) undoStack.shift();
          redoStack.length = 0;
        }
        state = change.current;
        notify(change);
      }
      return change;
    },
    subscribe(listener) {
      assertAlive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    can(command) {
      assertAlive();
      const resolved = extensions.commands[command];
      if (!resolved) return false;
      return resolved({ state, dispatch: () => { throw new Error("MDFN_COMMAND_CAN_DISPATCH_FORBIDDEN"); } });
    },
    run(command) {
      assertAlive();
      const resolved: EditorCommand | undefined = extensions.commands[command];
      if (!resolved) return false;
      return resolved({ state, dispatch: (transaction) => controller.dispatch(transaction as Transaction) });
    },
    canUndo() {
      assertAlive();
      return undoStack.length > 0;
    },
    canRedo() {
      assertAlive();
      return redoStack.length > 0;
    },
    undo() {
      assertAlive();
      const previous = undoStack.pop();
      if (!previous) return false;
      redoStack.push(state);
      return restore(previous, "history:undo");
    },
    redo() {
      assertAlive();
      const next = redoStack.pop();
      if (!next) return false;
      undoStack.push(state);
      return restore(next, "history:redo");
    },
    markSaved() {
      assertAlive();
      if (!state.dirty) return;
      const previous = state;
      state = Object.freeze({ ...state, dirty: false, version: previous.version + 1 });
      notify({
        previous,
        current: state,
        changedRanges: [],
        documentChanged: false,
        selectionChanged: false,
        sidecarChanged: false,
        source: "state:saved",
        metadata: {},
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
  return controller;
}

export function replaceAll(currentMarkdown: string, markdown: string, source = "source"): Transaction {
  return new Transaction().replaceSource(0, currentMarkdown.length, markdown).withSource(source);
}
