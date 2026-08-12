// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createEditor } from "@mdfn/core";
import { createMarkdownProjector, parseMarkdown } from "@mdfn/markdown";
import { commonmarkExtension, createDirectiveExtension } from "@mdfn/extensions";
import { TextSelection } from "prosemirror-state";
import { createDomEditor, documentToProseMirror, proseMirrorToDocument } from "./index";

describe("@mdfn/dom", () => {
  it("projects documents without losing top-level source metadata", () => {
    const projector = createMarkdownProjector();
    const parsed = projector.parse("# Title\n\nParagraph.\n");
    const pm = documentToProseMirror(parsed.document);
    const roundTrip = proseMirrorToDocument(pm, pm);
    expect(roundTrip.content.map((node) => node.type)).toEqual(["heading", "paragraph"]);
    expect(roundTrip.content[0].source?.raw).toBe("# Title");
    expect(roundTrip.content[0].source?.dirty).toBe(false);
  });

  it("mounts a vanilla editor and dispatches shared controller changes", () => {
    const projector = createMarkdownProjector();
    const controller = createEditor({ markdown: "Text.\n", projector });
    const target = document.createElement("div");
    document.body.append(target);
    const editor = createDomEditor({ target, controller });
    expect(target.querySelector('[data-mdfn-editor="visual"]')).not.toBeNull();
    expect(target.querySelector('[role="textbox"][aria-multiline="true"]')).not.toBeNull();
    expect(editor.can("bold")).toBe(true);
    editor.setReadOnly(true);
    expect(editor.can("bold")).toBe(false);
    expect(editor.run("bold")).toBe(false);
    editor.destroy();
    expect(target.querySelector('[data-mdfn-editor="visual"]')).toBeNull();
  });

  it("uses controller history and selection as the only canonical authority", () => {
    const projector = createMarkdownProjector();
    const controller = createEditor({ markdown: "a\n", projector });
    const target = document.createElement("div");
    document.body.append(target);
    const editor = createDomEditor({ target, controller });
    editor.view.dispatch(editor.view.state.tr.insertText("b", 2));
    expect(controller.getState().markdown).toBe("ab\n");
    expect(controller.getState().selection?.kind).toBe("text");
    expect(editor.run("undo")).toBe(true);
    expect(controller.getState().markdown).toBe("a\n");
    expect(editor.view.state.doc.textContent).toBe("a");
    expect(editor.can("undo")).toBe(false);
    expect(editor.run("redo")).toBe(true);
    expect(controller.getState().markdown).toBe("ab\n");
    expect(editor.view.state.doc.textContent).toBe("ab");
    editor.destroy();
  });

  it("round-trips inline code from visual projection", () => {
    const projector = createMarkdownProjector();
    const source = "Use `value` here.\n";
    const parsed = projector.parse(source);
    const pm = documentToProseMirror(parsed.document);
    const visual = proseMirrorToDocument(pm, undefined);
    expect(projector.serialize(visual, source).markdown).toContain("`value`");
  });

  it("keeps extension identity and unsafe URLs inert in the visual model", () => {
    const callout = createDirectiveExtension({ name: "callout" });
    const extensionDocument = parseMarkdown(":::callout\nBody\n:::\n", { extensions: [commonmarkExtension, callout] }).document;
    const projected = documentToProseMirror(extensionDocument);
    expect(projected.firstChild?.type.name).toBe("extension_block");
    expect(projected.firstChild?.attrs.nodeType).toBe("directive-callout");
    expect(proseMirrorToDocument(projected, projected).content[0]).toMatchObject({ type: "directive-callout", text: "Body" });

    const unsafe = documentToProseMirror(parseMarkdown("[click](javascript:alert(1))\n").document);
    const link = unsafe.firstChild?.firstChild?.marks[0];
    expect(link?.attrs).toMatchObject({ blocked: true, href: "", sourceHref: "javascript:alert(1)" });
  });

  it("blocks unsafe link commands, inserts tables, and routes file drops to the host", async () => {
    const controller = createEditor({ markdown: "link", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    document.body.append(target);
    const dropped: File[][] = [];
    const editor = createDomEditor({ target, controller, onFiles: (files) => { dropped.push([...files]); } });
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 5)));
    expect(editor.setLink("java%0ascript:alert(1)")).toBe(false);
    expect(editor.setLink("https://example.com")).toBe(true);
    expect(editor.insertTable(2, 2)).toBe(true);
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
    target.querySelector(".ProseMirror")?.dispatchEvent(event);
    await Promise.resolve();
    expect(dropped).toEqual([[file]]);
    editor.destroy();
  });
});
