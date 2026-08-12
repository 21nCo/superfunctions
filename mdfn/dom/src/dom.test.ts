// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createEditor } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
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

  it("round-trips inline code from visual projection", () => {
    const projector = createMarkdownProjector();
    const source = "Use `value` here.\n";
    const parsed = projector.parse(source);
    const pm = documentToProseMirror(parsed.document);
    const visual = proseMirrorToDocument(pm, undefined);
    expect(projector.serialize(visual, source).markdown).toContain("`value`");
  });
});
