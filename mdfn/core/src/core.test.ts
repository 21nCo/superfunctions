import { describe, expect, it, vi } from "vitest";
import {
  Transaction,
  createEditor,
  createSnapshot,
  hashString,
  mapAnchor,
  resolveExtensions,
  restoreSnapshot,
  type EditorProjector,
  type MdfnDocument,
  createCommentThread,
  createSuggestion,
  decideSuggestion,
  transitionReview,
  validateMdfnSidecar,
} from "./index";

const projector: EditorProjector = {
  parse(markdown) {
    return {
      document: { type: "doc", schemaVersion: 1, content: [{ type: "text", text: markdown }] },
      diagnostics: [],
      sourceHash: hashString(markdown),
    };
  },
  serialize(document) {
    return {
      markdown: document.content.map((node) => node.text ?? "").join(""),
      diagnostics: [],
      preservation: { exactUntouched: false, semanticSupported: true, opaqueUnsupported: true, touchedRegionOnly: false },
    };
  },
};

describe("@mdfn/core", () => {
  it("applies source transactions, maps anchors, and supports history", () => {
    const editor = createEditor({ markdown: "hello world", projector });
    const listener = vi.fn();
    editor.subscribe(listener);
    editor.dispatch(new Transaction().replaceSource(6, 11, "mdfn").withSource("test"));
    expect(editor.getState().markdown).toBe("hello mdfn");
    expect(listener).toHaveBeenCalledOnce();
    expect(editor.undo()).toBe(true);
    expect(editor.getState().markdown).toBe("hello world");
    expect(editor.redo()).toBe(true);
    expect(editor.getState().markdown).toBe("hello mdfn");
    expect(mapAnchor({ from: 8, to: 11 }, [{ from: 6, to: 11, insertedLength: 4 }])).toEqual({ from: 10, to: 10 });
  });

  it("validates extension dependencies, conflicts, and deterministic schema identity", () => {
    const base = {
      name: "base",
      version: "1.0.0",
      preservation: { noEdit: "exact", edited: "touched-region", unsupported: "opaque" } as const,
    };
    const registry = resolveExtensions([
      { ...base, name: "tables", dependencies: ["base"] },
      base,
    ]);
    expect(registry.extensions.map((entry) => entry.name)).toEqual(["base", "tables"]);
    expect(registry.schemaHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => resolveExtensions([{ ...base, dependencies: ["missing"] }])).toThrowError(/requires missing/);
    expect(() => resolveExtensions([base, { ...base, name: "unsafe", conflicts: ["base"] }])).toThrowError(/conflicts/);
  });

  it("invalidates cached documents when source or schema identity changes", () => {
    const editor = createEditor({ markdown: "source", projector });
    const snapshot = createSnapshot(editor.getState());
    expect(restoreSnapshot(snapshot, projector, editor.extensions.schemaHash).markdown).toBe("source");
    expect(() => restoreSnapshot({ ...snapshot, markdown: "changed" }, projector, editor.extensions.schemaHash)).toThrowError(
      "MDFN_SNAPSHOT_SOURCE_HASH_MISMATCH",
    );
    const restored = restoreSnapshot(snapshot, projector, "different");
    expect(restored.document).toEqual(projector.parse("source").document as MdfnDocument);
    const forged = {
      ...snapshot,
      document: { type: "doc", schemaVersion: 1, content: [{ type: "text", text: "forged" }] } as MdfnDocument,
    };
    expect(restoreSnapshot(forged, projector, editor.extensions.schemaHash).document).toEqual(projector.parse("source").document);
  });

  it("publishes saved-state changes without adding history", () => {
    const editor = createEditor({ markdown: "before", projector });
    editor.dispatch(new Transaction().replaceSource(0, 6, "after"));
    const listener = vi.fn();
    editor.subscribe(listener);
    editor.markSaved();
    expect(editor.getState()).toMatchObject({ markdown: "after", dirty: false, version: 2 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ source: "state:saved", documentChanged: false }));
    expect(editor.undo()).toBe(true);
    expect(editor.getState().markdown).toBe("before");
  });

  it("uses SHA-256 source identity", () => {
    expect(hashString("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("maps auditable comments and accepted suggestions through canonical transactions", () => {
    let id = 0;
    const actor = { id: "author", now: () => "2026-08-12T00:00:00.000Z", createId: () => `id-${++id}` };
    const comment = createCommentThread({ anchor: { from: 0, to: 5 }, body: "Review", actor, markdownLength: 11 });
    const suggestion = createSuggestion({ sidecar: comment.sidecar, anchor: { from: 6, to: 11 }, replacement: "mdfn", actor, markdownLength: 11 });
    const editor = createEditor({ markdown: "hello world", projector, sidecar: suggestion.sidecar });
    decideSuggestion({ controller: editor, suggestionId: suggestion.suggestion.id, decision: "accepted", actor });
    expect(editor.getState().markdown).toBe("hello mdfn");
    expect(editor.getState().sidecar?.suggestions?.[0]).toMatchObject({ status: "accepted", anchor: { from: 10, to: 10 } });
    expect(editor.getState().sidecar?.audit?.at(-1)?.action).toBe("suggestion-accepted");
    expect(transitionReview({ sidecar: editor.getState().sidecar, to: "in-review", actor }).reviewState).toBe("in-review");
  });

  it("rejects malformed, duplicate, oversized, and out-of-range sidecar data", () => {
    expect(() => validateMdfnSidecar({ comments: "invalid" })).toThrowError("MDFN_SIDECAR_COMMENTS_INVALID");
    expect(() => validateMdfnSidecar({ suggestions: [{ id: "s", anchor: { from: 0, to: 99 }, replacement: "", authorId: "a", status: "pending", createdAt: "2026-08-12T00:00:00.000Z" }] }, { markdownLength: 2 })).toThrowError("MDFN_SIDECAR_ANCHOR_INVALID");
    expect(() => validateMdfnSidecar({ assets: [{ id: "same", mediaType: "text/plain" }, { id: "same", mediaType: "text/plain" }] })).toThrowError("MDFN_SIDECAR_DUPLICATE_ID:same");
  });
});
