import { createRoot, type Accessor } from "solid-js";
import type { AdapterSnapshot } from "@mdfn/adapter-kit";
import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { createMdfnSignal } from "./index";

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
});
