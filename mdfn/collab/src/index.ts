import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Transaction, type EditorController, type MdfnJsonValue, type MdfnSidecar } from "@mdfn/core";

export interface CollaborationUser {
  readonly id: string;
  readonly name?: string;
  readonly color?: string;
  readonly metadata?: Readonly<Record<string, MdfnJsonValue>>;
}

export interface CollaborationSessionOptions {
  readonly controller: EditorController;
  readonly documentId: string;
  readonly user: CollaborationUser;
  readonly doc?: Y.Doc;
  readonly awareness?: Awareness;
  readonly authorizeUpdate?: (update: Uint8Array, origin: unknown) => boolean | Promise<boolean>;
}

export interface CollaborationSession {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  encodeUpdate(stateVector?: Uint8Array): Uint8Array;
  encodeStateVector(): Uint8Array;
  applyUpdate(update: Uint8Array, origin?: unknown): Promise<void>;
  setPresence(value: Readonly<Record<string, MdfnJsonValue>>): void;
  getPresence(): ReadonlyMap<number, unknown>;
  destroy(): void;
}

function changedRange(previous: string, current: string): { from: number; to: number; inserted: string } {
  let from = 0;
  while (from < previous.length && from < current.length && previous[from] === current[from]) from += 1;
  let oldEnd = previous.length;
  let newEnd = current.length;
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === current[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  return { from, to: oldEnd, inserted: current.slice(from, newEnd) };
}

export function createCollaborationSession(options: CollaborationSessionOptions): CollaborationSession {
  const doc = options.doc ?? new Y.Doc({ guid: options.documentId });
  const ownsAwareness = !options.awareness;
  const awareness = options.awareness ?? new Awareness(doc);
  const source = doc.getText("markdown");
  const sidecar = doc.getMap<string>("sidecar");
  const metadata = doc.getMap<string>("metadata");
  const localOrigin = Object.freeze({ session: options.user.id });
  let applyingRemote = false;
  let destroyed = false;

  const storedSchema = metadata.get("schemaHash");
  const expectedSchema = options.controller.getState().schemaHash;
  if (storedSchema && storedSchema !== expectedSchema) throw new Error(`MDFN_COLLAB_SCHEMA_MISMATCH:${storedSchema}:${expectedSchema}`);
  if (!storedSchema) metadata.set("schemaHash", expectedSchema);
  metadata.set("documentId", options.documentId);

  if (source.length === 0) source.insert(0, options.controller.getState().markdown);
  else if (source.toString() !== options.controller.getState().markdown) {
    const current = options.controller.getState().markdown;
    options.controller.dispatch(new Transaction().replaceSource(0, current.length, source.toString()).withSource("collab:initial"));
  }
  if (!sidecar.has("value") && options.controller.getState().sidecar) sidecar.set("value", JSON.stringify(options.controller.getState().sidecar));

  awareness.setLocalState({ user: options.user, documentId: options.documentId });

  const unsubscribe = options.controller.subscribe((change) => {
    if (applyingRemote || destroyed) return;
    doc.transact(() => {
      if (change.documentChanged) {
        const current = source.toString();
        const range = changedRange(current, change.current.markdown);
        if (range.to > range.from) source.delete(range.from, range.to - range.from);
        if (range.inserted) source.insert(range.from, range.inserted);
      }
      if (change.sidecarChanged) {
        if (change.current.sidecar) sidecar.set("value", JSON.stringify(change.current.sidecar));
        else sidecar.delete("value");
      }
    }, localOrigin);
  });

  const applySharedState = (transaction: Y.Transaction): void => {
    if (destroyed || transaction.origin === localOrigin) return;
    applyingRemote = true;
    try {
      const state = options.controller.getState();
      const nextSource = source.toString();
      let edit = new Transaction().withSource("collab:remote");
      if (nextSource !== state.markdown) edit = edit.replaceSource(0, state.markdown.length, nextSource);
      const value = sidecar.get("value");
      const nextSidecar = value ? JSON.parse(value) as MdfnSidecar : undefined;
      if (JSON.stringify(nextSidecar) !== JSON.stringify(state.sidecar)) edit = edit.setSidecar(nextSidecar);
      if (edit.operations.length > 0) options.controller.dispatch(edit);
    } finally { applyingRemote = false; }
  };
  doc.on("afterTransaction", applySharedState);

  return {
    doc,
    awareness,
    encodeUpdate: (stateVector) => stateVector ? Y.encodeStateAsUpdate(doc, stateVector) : Y.encodeStateAsUpdate(doc),
    encodeStateVector: () => Y.encodeStateVector(doc),
    async applyUpdate(update, origin = "transport") {
      if (destroyed) throw new Error("MDFN_COLLAB_DESTROYED");
      if (options.authorizeUpdate && !(await options.authorizeUpdate(update, origin))) throw new Error("MDFN_COLLAB_UPDATE_FORBIDDEN");
      Y.applyUpdate(doc, update, origin);
    },
    setPresence(value) { if (destroyed) throw new Error("MDFN_COLLAB_DESTROYED"); awareness.setLocalStateField("presence", value); },
    getPresence: () => awareness.getStates(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      doc.off("afterTransaction", applySharedState);
      awareness.setLocalState(null);
      if (ownsAwareness) awareness.destroy();
    },
  };
}

export { Awareness, Y };
export const MDFN_COLLAB_VERSION = "0.1.0" as const;
