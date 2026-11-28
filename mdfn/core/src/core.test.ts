import { describe, expect, it, vi } from "vitest";
import {
  Transaction,
  createEditor,
  createSnapshot,
  hashString,
  mapAnchor,
  mapSidecar,
  resolveExtensions,
  restoreSnapshot,
  smallestSourceChange,
  type EditorProjector,
  type MdfnDocument,
  type MdfnExtension,
  type MdfnSelection,
  createCommentThread,
  createSuggestion,
  decideSuggestion,
  transitionReview,
  validateMdfnSidecar,
} from "./index";
import { immutableValue } from "./immutable";

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
  it("preserves own JSON prototype-named metadata without changing the object prototype", () => {
    const metadata = JSON.parse('{"__proto__":{"secret":"own-data"},"constructor":"literal"}');
    const sidecar = validateMdfnSidecar({ assets: [{ id: "a", mediaType: "text/plain", metadata }] })!;
    const cloned = sidecar.assets![0].metadata!;
    expect(Object.hasOwn(cloned, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(metadata));
    expect(Object.isFrozen(cloned.__proto__)).toBe(true);
  });

  it("reuses unchanged immutable sidecar data and reports only actual anchor changes", () => {
    const input = { assets: [{ id: "a", mediaType: "text/plain", metadata: { large: ["data"] } }], comments: [{ id: "c", anchor: { from: 1, to: 2 }, resolved: false, messages: [{ id: "m", authorId: "a", body: "note", createdAt: "2026-08-12T00:00:00Z" }] }] };
    // A shallow-frozen input must still be detached from mutable descendants.
    const editor = createEditor({ markdown: "abc", projector, sidecar: Object.freeze(input) });
    const before = editor.getState().sidecar!;
    input.assets[0].metadata.large[0] = "mutated";
    expect(before.assets![0].metadata!.large).toEqual(["data"]);
    expect(editor.dispatch(new Transaction().replaceSource(3, 3, "d")).sidecarChanged).toBe(false);
    expect(editor.getState().sidecar).toBe(before);
    expect(editor.dispatch(new Transaction().replaceSource(0, 0, "x")).sidecarChanged).toBe(true);
    const after = editor.getState().sidecar!;
    expect(after.assets).toBe(before.assets);
    expect(after.comments![0].messages).toBe(before.comments![0].messages);
    expect(after.comments![0].anchor).toEqual({ from: 2, to: 3 });
    expect(before.comments![0].anchor).toEqual({ from: 1, to: 2 });
  });

  it("detaches and deep-freezes projected documents before exposing editor state", () => {
    const projected: MdfnDocument = {
      type: "doc",
      schemaVersion: 1,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "mutable" }],
        source: { from: 0, to: 7, raw: "mutable", preservation: "exact" },
      }],
    };
    const mutableProjector: EditorProjector = {
      parse: () => ({ document: projected, diagnostics: [] }),
      serialize: projector.serialize,
    };
    const editor = createEditor({ markdown: "mutable", projector: mutableProjector });
    const state = editor.getState();

    expect(state.document).not.toBe(projected);
    expect(Object.isFrozen(state.document)).toBe(true);
    expect(Object.isFrozen(state.document.content)).toBe(true);
    expect(Object.isFrozen(state.document.content[0])).toBe(true);
    expect(Object.isFrozen(state.document.content[0]?.source)).toBe(true);

    const originalText = state.document.content[0]?.content?.[0]?.text;
    const projectedText = projected.content[0]?.content?.[0];
    if (projectedText) (projectedText as { text?: string }).text = "changed elsewhere";
    expect(editor.getState().document.content[0]?.content?.[0]?.text).toBe(originalText);
  });

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

  it("keeps same-text source replacements out of mapping and history", () => {
    let id = 0;
    const comment = createCommentThread({
      anchor: { from: 6, to: 11 },
      body: "Keep this anchor",
      actor: { id: "author", now: () => "2026-08-31T00:00:00.000Z", createId: () => `same-text-${++id}` },
      markdownLength: 11,
    });
    const editor = createEditor({
      markdown: "hello world",
      projector,
      selection: { kind: "text", anchor: 8, head: 8 },
      sidecar: comment.sidecar,
    });
    const previous = editor.getState();
    const listener = vi.fn();
    editor.subscribe(listener);

    const change = editor.dispatch(new Transaction().replaceSource(0, 11, "hello world"));

    expect(change).toMatchObject({
      previous,
      current: previous,
      changedRanges: [],
      documentChanged: false,
      selectionChanged: false,
      sidecarChanged: false,
    });
    expect(editor.getState().selection).toEqual({ kind: "text", anchor: 8, head: 8 });
    expect(editor.getState().sidecar?.comments?.[0]?.anchor).toEqual({ from: 6, to: 11 });
    expect(editor.canUndo()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes the minimal changed range when restoring history", () => {
    const editor = createEditor({ markdown: "before after", projector });
    const listener = vi.fn();
    editor.subscribe(listener);
    editor.dispatch(new Transaction().replaceSource(12, 12, "!"));
    listener.mockClear();
    expect(editor.undo()).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      changedRanges: [{ from: 12, to: 13, insertedLength: 0 }],
      documentChanged: true,
    }));
  });

  it("replays exact disjoint ranges when restoring large history entries", () => {
    const markdown = `A${"x".repeat(600)}Z`;
    const editor = createEditor({ markdown, projector });
    const listener = vi.fn();
    editor.subscribe(listener);
    editor.dispatch(new Transaction()
      .replaceSource(0, 1, "B")
      .replaceSource(markdown.length - 1, markdown.length, "Y"));
    listener.mockClear();

    expect(editor.undo()).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      changedRanges: [
        { from: markdown.length - 1, to: markdown.length, insertedLength: 1 },
        { from: 0, to: 1, insertedLength: 1 },
      ],
    }));
    listener.mockClear();
    expect(editor.redo()).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      changedRanges: [
        { from: 0, to: 1, insertedLength: 1 },
        { from: markdown.length - 1, to: markdown.length, insertedLength: 1 },
      ],
    }));
  });

  it("invalidates local history when a non-history collaboration change arrives", () => {
    const editor = createEditor({ markdown: "shared", projector });
    editor.dispatch(new Transaction().replaceSource(6, 6, " local"));
    expect(editor.canUndo()).toBe(true);

    editor.dispatch(new Transaction()
      .replaceSource(0, editor.getState().markdown.length, "remote state")
      .withSource("collaboration")
      .withMetadata({ addToHistory: false }));

    expect(editor.getState().markdown).toBe("remote state");
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
    expect(editor.undo()).toBe(false);
  });

  it("keeps selection fields supplied through a prototype", () => {
    const editor = createEditor({ markdown: "abc\n", projector });
    editor.dispatch(new Transaction().setSelection(Object.create({ kind: "text", anchor: 1, head: 2 })));
    expect(editor.getState().selection).toEqual({ kind: "text", anchor: 1, head: 2 });
  });

  it("commits the selection values it validated when fields are getters", () => {
    const editor = createEditor({ markdown: "abc\n", projector });
    const reads = { anchor: 0, head: 0, nodeId: 0 };
    const text = {
      kind: "text",
      get anchor() { reads.anchor += 1; return reads.anchor === 1 ? 1 : 999; },
      get head() { reads.head += 1; return reads.head === 1 ? 2 : -1; },
    } as unknown as MdfnSelection;
    editor.dispatch(new Transaction().setSelection(text));
    expect(editor.getState().selection).toEqual({ kind: "text", anchor: 1, head: 2 });
    expect(reads).toMatchObject({ anchor: 1, head: 1 });

    const node = {
      kind: "node",
      get nodeId() { reads.nodeId += 1; return reads.nodeId === 1 ? "paragraph-1" : 42; },
    } as unknown as MdfnSelection;
    editor.dispatch(new Transaction().setSelection(node));
    expect(editor.getState().selection).toEqual({ kind: "node", nodeId: "paragraph-1" });
    expect(reads.nodeId).toBe(1);
  });

  it("maps canonical selections through source replacement", () => {
    const editor = createEditor({
      markdown: "hello world",
      projector,
      selection: { kind: "text", anchor: 8, head: 8 },
    });
    const replacement = "a completely different document";
    const change = editor.dispatch(new Transaction().replaceSource(0, 11, replacement));
    expect(change.selectionChanged).toBe(true);
    expect(editor.getState().selection).toEqual({ kind: "text", anchor: replacement.length, head: replacement.length });

    editor.dispatch(new Transaction().replaceSource(0, 0, "prefix "));
    expect(editor.getState().selection).toEqual({ kind: "text", anchor: replacement.length + 7, head: replacement.length + 7 });
    expect(Object.isFrozen(editor.getState().selection)).toBe(true);
  });

  it("maps sidecar anchors through structural document replacement", () => {
    let id = 0;
    const comment = createCommentThread({
      anchor: { from: 6, to: 11 },
      body: "Track this",
      actor: { id: "author", now: () => "2026-08-13T00:00:00.000Z", createId: () => `anchor-${++id}` },
      markdownLength: 11,
    });
    const editor = createEditor({ markdown: "hello world", projector, sidecar: comment.sidecar });
    editor.dispatch(new Transaction().replaceDocument(projector.parse("prefix hello world").document));
    expect(editor.getState().sidecar?.comments?.[0]?.anchor).toEqual({ from: 13, to: 18 });
  });

  it("reparses serialized documents before retaining source spans", () => {
    const editor = createEditor({ markdown: "abc", projector });
    const edited = { ...projector.parse("abcd").document, source: { from: 0, to: 3, raw: "abc", dirty: true } } as MdfnDocument;
    editor.dispatch(new Transaction().replaceDocument(edited));
    expect(editor.getState().document).toEqual(projector.parse("abcd").document);
  });

  it("clears node selections when source edits can invalidate node identity", () => {
    const editor = createEditor({ markdown: "hello", projector, selection: { kind: "node", nodeId: "paragraph-1" } });
    const change = editor.dispatch(new Transaction().replaceSource(5, 5, " world"));
    expect(change.selectionChanged).toBe(true);
    expect(editor.getState().selection).toBeNull();
  });

  it("rejects invalid text selections during creation and transactions", () => {
    expect(() => createEditor({
      markdown: "abc",
      projector,
      selection: { kind: "text", anchor: -1, head: 0 },
    })).toThrowError("MDFN_SELECTION_RANGE_INVALID");

    const editor = createEditor({ markdown: "abc", projector });
    for (const selection of [
      { kind: "text" as const, anchor: 0.5, head: 0 },
      { kind: "text" as const, anchor: 0, head: 4 },
    ]) {
      expect(() => editor.dispatch(new Transaction().setSelection(selection)))
        .toThrowError("MDFN_SELECTION_RANGE_INVALID");
    }
    expect(editor.getState().selection).toBeNull();
  });

  it("validates, detaches, and freezes every selection variant", () => {
    for (const selection of [
      { kind: "unknown" },
      { kind: "node" },
      { kind: "node", nodeId: "" },
      { kind: "node", nodeId: "paragraph-1", extra: true },
      { kind: "text", anchor: 0, head: 0, extra: true },
    ]) {
      expect(() => createEditor({ markdown: "abc", projector, selection: selection as never }))
        .toThrowError("MDFN_SELECTION_INVALID");
    }

    const selection = { kind: "node" as const, nodeId: "paragraph-1" };
    const editor = createEditor({ markdown: "abc", projector, selection });
    expect(() => editor.dispatch(new Transaction().setSelection(undefined as never)))
      .toThrowError("MDFN_SELECTION_INVALID");
    expect(editor.getState().selection).toEqual(selection);
    expect(editor.getState().selection).not.toBe(selection);
    expect(Object.isFrozen(editor.getState().selection)).toBe(true);
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

  it("rejects non-adjacent migrations and applies every migration in a schema transition", () => {
    const preservation = { noEdit: "exact", edited: "semantic", unsupported: "opaque" } as const;
    try {
      resolveExtensions([{ name: "invalid", version: "1", preservation, migrations: [{ from: 1, to: 1, migrate: (document) => document }] }]);
      throw new Error("expected invalid migration to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "MDFN_EXTENSION_MIGRATION_INVALID" });
    }
    const registry = resolveExtensions([
      { name: "first", version: "1", preservation, migrations: [{ from: 1, to: 2, migrate: (document) => ({ ...document, content: [...document.content, { type: "text", text: "first" }] }) }] },
      { name: "second", version: "1", preservation, migrations: [{ from: 1, to: 2, migrate: (document) => ({ ...document, content: [...document.content, { type: "text", text: "second" }] }) }] },
    ]);
    const migrated = registry.migrate({ type: "doc", schemaVersion: 1, content: [] }, 1, 2);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.content.map((node) => node.text)).toEqual(["first", "second"]);
  });

  it("resolves executable extension keymaps, text rules, and plugin cleanup", () => {
    let setup = 0;
    let cleanup = 0;
    const command = () => true;
    const extension: MdfnExtension = {
      name: "lifecycle",
      version: "1.0.0",
      preservation: { noEdit: "exact", edited: "semantic", unsupported: "opaque" } as const,
      commands: { insert: command },
      keymap: { "Mod-Alt-l": "insert" },
      inputRules: [{ name: "arrow", match: /->/, replace: () => "→" }],
      pasteRules: [{ name: "ellipsis", match: /\.\.\./, replace: () => "…" }],
      plugins: [{ name: "observe", setup: () => { setup += 1; return () => { cleanup += 1; }; } }],
    };
    const registry = resolveExtensions([extension]);
    expect(registry.keymap["Mod-Alt-l"]).toBe("lifecycle:insert");
    expect(registry.inputRules).toHaveLength(1);
    const editor = createEditor({ markdown: "", projector, extensions: [extension] });
    expect(setup).toBe(1);
    editor.destroy();
    expect(cleanup).toBe(1);
    expect(() => resolveExtensions([extension, { ...extension, name: "other" }])).toThrowError(/Duplicate key binding/);
  });

  it("unwinds initialized plugins in reverse order when later setup fails", () => {
    const lifecycle: string[] = [];
    const extension: MdfnExtension = {
      name: "setup-failure",
      version: "1.0.0",
      preservation: { noEdit: "exact", edited: "semantic", unsupported: "opaque" },
      plugins: [
        { name: "first", setup: () => { lifecycle.push("setup:first"); return () => { lifecycle.push("cleanup:first"); }; } },
        { name: "second", setup: () => { lifecycle.push("setup:second"); return () => { lifecycle.push("cleanup:second"); }; } },
        { name: "failing", setup: () => { lifecycle.push("setup:failing"); throw new Error("plugin setup failed"); } },
      ],
    };

    expect(() => createEditor({ markdown: "", projector, extensions: [extension] }))
      .toThrow("plugin setup failed");
    expect(lifecycle).toEqual([
      "setup:first", "setup:second", "setup:failing", "cleanup:second", "cleanup:first",
    ]);
  });

  it("checks dispatching commands without mutating editor state", () => {
    const extension = {
      name: "dispatching-command",
      version: "1.0.0",
      preservation: { noEdit: "exact", edited: "semantic", unsupported: "opaque" } as const,
      commands: {
        append: ({ state, dispatch }) => {
          dispatch(new Transaction().replaceSource(state.markdown.length, state.markdown.length, "!"));
          return true;
        },
      },
    };
    const editor = createEditor({ markdown: "safe", projector, extensions: [extension] });
    expect(editor.can("dispatching-command:append")).toBe(true);
    expect(editor.getState().markdown).toBe("safe");
    expect(editor.run("dispatching-command:append")).toBe(true);
    expect(editor.getState().markdown).toBe("safe!");
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

  it("keeps freshly projected diagnostics when restoring a cached document", () => {
    const editor = createEditor({ markdown: "source", projector });
    const snapshot = createSnapshot(editor.getState());
    const diagnosticProjector: EditorProjector = {
      ...projector,
      parse(markdown) {
        const parsed = projector.parse(markdown);
        return {
          ...parsed,
          diagnostics: [{ code: "MDFN_POLICY_CHANGED", message: "Current policy warning", severity: "warning" }],
        };
      },
    };

    expect(restoreSnapshot(snapshot, diagnosticProjector, editor.extensions.schemaHash).diagnostics)
      .toMatchObject([{ code: "MDFN_POLICY_CHANGED" }]);
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

  it("derives restored dirty state from the current saved revision", () => {
    const editor = createEditor({ markdown: "one", projector });
    editor.dispatch(new Transaction().replaceSource(0, 3, "two"));
    editor.markSaved();
    expect(editor.undo()).toBe(true);
    expect(editor.getState()).toMatchObject({ markdown: "one", dirty: true });
    expect(editor.redo()).toBe(true);
    expect(editor.getState()).toMatchObject({ markdown: "two", dirty: false });
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
    expect(() => validateMdfnSidecar({ comments: [{ id: "thread", anchor: { from: 0, to: 0 }, resolved: false, messages: [
      { id: "one", authorId: "a", body: "one", createdAt: "2026-08-12T00:00:00.000Z" },
      { id: "two", authorId: "a", body: "two", createdAt: "2026-08-12T00:00:00.000Z" },
    ] }] }, { maxEntries: 2 })).toThrowError("MDFN_SIDECAR_ENTRY_LIMIT_EXCEEDED");
    expect(() => validateMdfnSidecar({ assets: [{ id: "asset", mediaType: "text/plain", metadata: { nested: "x".repeat(33) } }] }, { maxTextLength: 32 })).toThrowError("MDFN_SIDECAR_ASSET_INVALID");
    expect(() => validateMdfnSidecar({ assets: [{ id: "asset", mediaType: "text/plain", metadata: { values: [1, 2, 3] } }] }, { maxEntries: 4 })).toThrowError("MDFN_SIDECAR_ENTRY_LIMIT_EXCEEDED");
    expect(() => validateMdfnSidecar({ comments: [
      { id: "one", anchor: { from: 0, to: 0 }, resolved: false, messages: [{ id: "m1", authorId: "a", body: "123456", createdAt: "2026-08-12T00:00:00.000Z" }] },
      { id: "two", anchor: { from: 0, to: 0 }, resolved: false, messages: [{ id: "m2", authorId: "a", body: "789012", createdAt: "2026-08-12T00:00:00.000Z" }] },
    ] }, { maxTextLength: 8, maxAggregateTextLength: 10 })).toThrowError("MDFN_SIDECAR_TEXT_LIMIT_EXCEEDED");
    expect(() => validateMdfnSidecar({ extra: "x".repeat(1_000_000) })).toThrowError("MDFN_SIDECAR_INVALID");
    expect(() => validateMdfnSidecar({ assets: [{ id: "asset", mediaType: "text/plain", extra: "unbounded" }] })).toThrowError("MDFN_SIDECAR_ASSET_INVALID");

    const input = { assets: [{ id: "asset", mediaType: "text/plain", metadata: { nested: ["original"] } }] };
    const validated = validateMdfnSidecar(input)!;
    input.assets[0]!.metadata.nested[0] = "mutated";
    input.assets.push({ id: "later", mediaType: "text/plain", metadata: { nested: [] } });
    expect(validated.assets).toEqual([{ id: "asset", mediaType: "text/plain", metadata: { nested: ["original"] } }]);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.assets)).toBe(true);
    expect(Object.isFrozen(validated.assets?.[0]?.metadata)).toBe(true);
    expect(Object.isFrozen(validated.assets?.[0]?.metadata?.nested)).toBe(true);
  });

  it("bounds aggregate editorial text by maxTextLength unless another limit is configured", () => {
    const message = (index: number) => ({ id: `m${index}`, authorId: "a", body: "x".repeat(6), createdAt: "2026-01-01T00:00:00.000Z" });
    const sidecar = { comments: [{ id: "c", anchor: { from: 0, to: 0 }, resolved: false, messages: [0, 1, 2, 3].map(message) }] };
    expect(() => validateMdfnSidecar(sidecar, { maxTextLength: 8 })).toThrowError("MDFN_SIDECAR_TEXT_LIMIT_EXCEEDED");
    expect(validateMdfnSidecar(sidecar, { maxTextLength: 8, maxAggregateTextLength: 24 })?.comments).toHaveLength(1);
  });

  describe("anchor mapping matches the dev implementation", () => {
    type Range = { from: number; to: number; insertedLength: number };
    type Anchor = Parameters<typeof mapAnchor>[0];
    type Sidecar = NonNullable<Parameters<typeof mapSidecar>[0]>;
    // Inline copy of mapAnchor/mapSidecar on dev before reuse was ported; the
    // ported versions must behave the same for every input that is not reused.
    const devMapPosition = (position: number, range: Range, affinity: "before" | "after") => {
      const delta = range.insertedLength - (range.to - range.from);
      if (position < range.from || (position === range.from && affinity === "before")) return position;
      if (position > range.to || (position === range.to && affinity === "after")) return position + delta;
      return affinity === "before" ? range.from : range.from + range.insertedLength;
    };
    const devMapAnchor = (anchor: Anchor, ranges: readonly Range[]): Anchor =>
      ranges.reduce<Anchor>((current, range) => {
        const affinity = current.affinity ?? "after";
        const from = devMapPosition(current.from, range, affinity === "before" ? "before" : "after");
        const to = devMapPosition(current.to, range, affinity === "after" ? "after" : "before");
        return { ...current, from: Math.min(from, to), to: Math.max(from, to) };
      }, anchor);
    const devMapSidecar = (sidecar: Sidecar | undefined, ranges: readonly Range[]) => {
      if (!sidecar || ranges.length === 0) return sidecar;
      return immutableValue({
        ...sidecar,
        comments: sidecar.comments?.map((thread) => ({ ...thread, anchor: devMapAnchor(thread.anchor, ranges) })),
        suggestions: sidecar.suggestions?.map((suggestion) => ({ ...suggestion, anchor: devMapAnchor(suggestion.anchor, ranges) })),
      });
    };
    const outcome = (run: () => unknown) => {
      try {
        const value = run();
        return { value, frozen: Object.isFrozen(value) };
      } catch (error) {
        return { error: String(error) };
      }
    };
    // Each case builds fresh inputs per call, because its getters and proxies keep state.
    const sameAsDevAnchor = (make: () => [Anchor, readonly Range[]]) => {
      const ported = outcome(() => mapAnchor(...make()));
      expect(ported).toEqual(outcome(() => devMapAnchor(...make())));
      return ported;
    };
    const sameAsDevSidecar = (make: () => [Sidecar | undefined, readonly Range[]]) => {
      const ported = outcome(() => mapSidecar(...make()));
      expect(ported).toEqual(outcome(() => devMapSidecar(...make())));
      return ported;
    };
    const insertAtZero = (): Range[] => [{ from: 0, to: 0, insertedLength: 1 }];
    const thread = (anchor: Anchor) => ({ id: "c", anchor, resolved: false, messages: [] });
    const suggestion = (anchor: Anchor) => ({ id: "s", anchor, replacement: "x", authorId: "a", status: "pending" as const, createdAt: "2026-08-12T00:00:00.000Z" });
    // The has trap reports index 0 present on the first check only.
    const presentOnce = () => {
      let checks = 0;
      return new Proxy(insertAtZero(), { has: (target, key) => (key === "0" ? ++checks === 1 : Reflect.has(target, key)) });
    };
    const throwingRanges = () => new Proxy(insertAtZero(), {
      has: (target, key) => { if (key === "0") throw new Error("range checked"); return Reflect.has(target, key); },
      get: (target, key, receiver) => { if (key === "0") throw new Error("range read"); return Reflect.get(target, key, receiver); },
    });
    const withAffinityGetter = (onRead: () => void) => Object.defineProperty({ from: 3, to: 3 }, "affinity", {
      enumerable: true,
      get: () => { onRead(); return undefined; },
    }) as unknown as Anchor;

    it("applies a range seen once by the has trap inside a one-entry sidecar", () => {
      expect(sameAsDevAnchor(() => [{ from: 3, to: 3 }, presentOnce()]).value).toEqual({ from: 4, to: 4 });
      expect(sameAsDevSidecar(() => [{ comments: [thread({ from: 3, to: 3 })] }, presentOnce()]).value?.comments?.[0]?.anchor).toEqual({ from: 4, to: 4 });
      expect(sameAsDevSidecar(() => [{ suggestions: [suggestion({ from: 3, to: 3 })] }, presentOnce()]).value?.suggestions?.[0]?.anchor).toEqual({ from: 4, to: 4 });
    });

    it("does not probe the ranges when a sidecar has no anchors", () => {
      expect(sameAsDevSidecar(() => [{ comments: [] }, throwingRanges()])).not.toHaveProperty("error");
      expect(sameAsDevSidecar(() => [{ suggestions: [] }, throwingRanges()])).not.toHaveProperty("error");
      expect(sameAsDevSidecar(() => [{}, throwingRanges()])).not.toHaveProperty("error");
    });

    it("handles holes, inherited fields and getters the way dev does", () => {
      sameAsDevAnchor(() => [{ from: 1, to: 2 }, new Array(1)]);
      sameAsDevSidecar(() => [{ comments: [thread({ from: 1, to: 2 })] }, new Array(1)]);
      const sparse = (): Range[] => { const ranges: Range[] = []; ranges[1] = { from: 0, to: 0, insertedLength: 1 }; return ranges; };
      expect(sameAsDevAnchor(() => [{ from: 1, to: 2 }, sparse()]).value).toEqual({ from: 2, to: 3 });
      sameAsDevSidecar(() => [{ comments: [thread({ from: 1, to: 2 })] }, sparse()]);

      const inherited = () => Object.assign(Object.create({ affinity: "before" }), { from: 2, to: 2 }) as Anchor;
      const atAnchor = (): Range[] => [{ from: 2, to: 2, insertedLength: 3 }];
      sameAsDevAnchor(() => [inherited(), atAnchor()]);
      sameAsDevSidecar(() => [{ comments: [thread(inherited())] }, new Array(1)]);
      sameAsDevSidecar(() => [{ comments: [thread(inherited())] }, atAnchor()]);

      class Thread {
        readonly id = "c";
        readonly resolved = false;
        readonly messages = [];
        get anchor() { return { from: 1, to: 2 }; }
      }
      class GetterSidecar {
        get comments() { return [new Thread()]; }
        get suggestions() { return [suggestion({ from: 0, to: 1 })]; }
      }
      sameAsDevSidecar(() => [new GetterSidecar() as unknown as Sidecar, [{ from: 5, to: 5, insertedLength: 1 }]]);
      sameAsDevSidecar(() => [{ comments: null } as unknown as Sidecar, insertAtZero()]);
    });

    it("visits ranges as native reduce does when getters change them", () => {
      const deletingFirst = (): [Anchor, Range[]] => { const ranges = insertAtZero(); return [withAffinityGetter(() => { delete ranges[0]; }), ranges]; };
      expect(sameAsDevAnchor(deletingFirst).value).toMatchObject({ from: 4, to: 4 });
      sameAsDevSidecar(() => { const [anchor, ranges] = deletingFirst(); return [{ comments: [thread(anchor)] }, ranges]; });

      const appending = (): [Anchor, Range[]] => { const ranges = insertAtZero(); return [withAffinityGetter(() => { ranges.push({ from: 0, to: 0, insertedLength: 5 }); }), ranges]; };
      expect(sameAsDevAnchor(appending).value).toMatchObject({ from: 4, to: 4 });

      const fractional = () => new Proxy([...insertAtZero(), { from: 0, to: 0, insertedLength: 5 }], {
        get: (target, key, receiver) => (key === "length" ? 1.5 : Reflect.get(target, key, receiver)),
      });
      expect(sameAsDevAnchor(() => [{ from: 3, to: 3 }, fractional()]).value).toEqual({ from: 4, to: 4 });
      sameAsDevSidecar(() => [{ comments: [thread({ from: 3, to: 3 })] }, fractional()]);

      // Collection getters that replace or append ranges before the entries are mapped.
      const replacing = (): [Sidecar, Range[]] => {
        const ranges = insertAtZero();
        return [Object.defineProperty({}, "comments", { enumerable: true, get: () => { ranges[0] = { from: 0, to: 0, insertedLength: 5 }; return [thread({ from: 1, to: 2 })]; } }) as Sidecar, ranges];
      };
      expect(sameAsDevSidecar(replacing).value?.comments?.[0]?.anchor).toEqual({ from: 6, to: 7 });
      const growing = (): [Sidecar, Range[]] => {
        const ranges = insertAtZero();
        return [Object.defineProperties({}, {
          comments: { enumerable: true, get: () => [thread({ from: 1, to: 2 })] },
          suggestions: { enumerable: true, get: () => { ranges.push({ from: 0, to: 0, insertedLength: 5 }); return [suggestion({ from: 1, to: 2 })]; } },
        }) as Sidecar, ranges];
      };
      sameAsDevSidecar(growing);
    });

    it("reuses only unchanged values it already detached and never returns a caller-owned sidecar", () => {
      const later = (): Range[] => [{ from: 9, to: 9, insertedLength: 1 }];
      const frozenAnchor = immutableValue({ from: 1, to: 2 });
      expect(mapAnchor(frozenAnchor, later())).toBe(frozenAnchor);
      const owned = { from: 1, to: 2 };
      const copied = mapAnchor(owned, later());
      expect(copied).not.toBe(owned);
      owned.from = 0;
      expect(copied).toEqual({ from: 1, to: 2 });

      const frozenSidecar = immutableValue({ comments: [thread({ from: 1, to: 2 })], suggestions: [suggestion({ from: 4, to: 5 })] }) as Sidecar;
      expect(mapSidecar(frozenSidecar, later())).toBe(frozenSidecar);
      const moved = mapSidecar(frozenSidecar, [{ from: 3, to: 3, insertedLength: 1 }])!;
      expect(moved).not.toBe(frozenSidecar);
      expect(Object.isFrozen(moved)).toBe(true);
      expect(moved.comments![0]).toBe(frozenSidecar.comments![0]);
      expect(moved.suggestions![0]!.anchor).toEqual({ from: 5, to: 6 });
      expect(moved).toEqual(devMapSidecar(frozenSidecar, [{ from: 3, to: 3, insertedLength: 1 }]));

      const callerOwned = { comments: [thread({ from: 1, to: 2 })] };
      const mapped = sameAsDevSidecar(() => [callerOwned, later()]);
      expect(mapped.value).not.toBe(callerOwned);
      expect(mapped.frozen).toBe(true);
    });
  });

  it("reports sidecar changes caused by source anchor mapping", () => {
    const sidecar = {
      comments: [{ id: "thread", anchor: { from: 1, to: 2 }, resolved: false, messages: [{ id: "message", authorId: "a", body: "note", createdAt: "2026-08-12T00:00:00.000Z" }] }],
    } as const;
    const editor = createEditor({ markdown: "abc", projector, sidecar });
    const change = editor.dispatch(new Transaction().replaceSource(0, 0, "x"));
    expect(change.sidecarChanged).toBe(true);
    expect(editor.getState().sidecar?.comments?.[0]?.anchor).toEqual({ from: 2, to: 3 });
    expect(Object.isFrozen(editor.getState().sidecar)).toBe(true);
    expect(Object.isFrozen(editor.getState().sidecar?.comments)).toBe(true);
    expect(Object.isFrozen(editor.getState().sidecar?.comments?.[0])).toBe(true);
    expect(Object.isFrozen(editor.getState().sidecar?.comments?.[0]?.anchor)).toBe(true);
  });

  it("keeps unchanged anchors stable when a textarea edit is reduced to its smallest source range", () => {
    const sidecar = {
      comments: [{ id: "thread", anchor: { from: 1, to: 2 }, resolved: false, messages: [{ id: "message", authorId: "a", body: "note", createdAt: "2026-08-12T00:00:00.000Z" }] }],
    } as const;
    const editor = createEditor({ markdown: "abc", projector, sidecar });
    const change = smallestSourceChange("abc", "abcd");
    expect(change).toEqual({ from: 3, to: 3, insert: "d" });
    editor.dispatch(new Transaction().replaceSource(change!.from, change!.to, change!.insert));
    expect(editor.getState().sidecar?.comments?.[0]?.anchor).toEqual({ from: 1, to: 2 });
  });
});
