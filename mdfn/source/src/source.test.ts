// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { createModeController, createPreview, createSourceEditor, sourceInternals } from "./index";

describe("@mdfn/source", () => {
  it("synchronizes CodeMirror changes through the shared controller", () => {
    const controller = createEditor({ markdown: "# Source\n", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    document.body.append(target);
    const editor = createSourceEditor({ target, controller });
    controller.dispatch(new Transaction().replaceSource(2, 8, "Changed").withSource("external"));
    expect(editor.view.state.doc.toString()).toBe("# Changed\n");
    expect(createPreview(controller).html).toContain("Changed");
    editor.destroy();
  });

  it("provides deterministic mode state", () => {
    const modes = createModeController();
    modes.setMode("split");
    expect(modes.getMode()).toBe("split");
    modes.destroy();
  });

  it("computes the smallest UTF-16 source replacement", () => {
    expect(sourceInternals.smallestSourceChange("prefix old suffix", "prefix new suffix")).toEqual({ from: 7, to: 10, insert: "new" });
    expect(sourceInternals.smallestSourceChange("👋 old", "👋 new")).toEqual({ from: 3, to: 6, insert: "new" });
    expect(sourceInternals.smallestSourceChange("same", "same")).toBeUndefined();
  });
});
