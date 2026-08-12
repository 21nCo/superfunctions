import { createRoot, type Accessor } from "solid-js";
import type { AdapterSnapshot } from "@mdfn/adapter-kit";
import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { createMdfnSignal } from "./index";
import { MdfnEditor } from "./index";
import { render } from "solid-js/web";

describe("@mdfn/solid", () => {
  it("updates and tears down its shared-state signal", () => {
    const controller = createEditor({ markdown: "one", projector: createMarkdownProjector() });
    let dispose = (): void => {};
    let snapshot: Accessor<AdapterSnapshot> | undefined;
    createRoot((cleanup) => {
      dispose = cleanup;
      snapshot = createMdfnSignal(controller);
    });
    expect(snapshot?.().markdown).toBe("one");
    controller.dispatch(new Transaction().replaceSource(0, 3, "two").withSource("parity"));
    expect(snapshot?.().markdown).toBe("two");
    dispose();
    controller.dispatch(new Transaction().replaceSource(0, 3, "end").withSource("cleanup"));
    expect(snapshot?.().markdown).toBe("two");
  });

  it("mounts the real adapter, replays controller changes, and cleans up", async () => {
    const controller = createEditor({ markdown: "# Mounted", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    document.body.append(target);
    let ready = (): void => {};
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const dispose = render(() => <MdfnEditor controller={controller} mode="read-only" editorRef={(handle) => { if (handle) ready(); }} />, target);
    await readyPromise;
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-solid="editor"]')).not.toBeNull();
    controller.dispatch(new Transaction().replaceSource(2, 9, "Changed").withSource("parity"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.textContent).toContain("Changed");
    dispose();
    expect(target.children).toHaveLength(0);
  });
});
