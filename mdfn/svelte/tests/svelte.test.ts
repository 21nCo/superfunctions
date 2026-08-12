import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { createMdfnStore } from "../src/store";

describe("@mdfn/svelte", () => {
  it("updates and tears down its shared-state store", () => {
    const controller = createEditor({ markdown: "one", projector: createMarkdownProjector() });
    const values: string[] = [];
    const unsubscribe = createMdfnStore(controller).subscribe((snapshot) => values.push(snapshot.markdown));
    controller.dispatch(new Transaction().replaceSource(0, 3, "two").withSource("parity"));
    expect(values).toEqual(["one", "two"]);
    unsubscribe();
    controller.dispatch(new Transaction().replaceSource(0, 3, "end").withSource("cleanup"));
    expect(values).toEqual(["one", "two"]);
  });
});
