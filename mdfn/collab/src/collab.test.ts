import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { createCollaborationSession, Y } from "./index";

describe("collaboration", () => {
  it("exchanges offline updates and projects them through the controller", async () => {
    const projector = createMarkdownProjector();
    const a = createEditor({ markdown: "one", projector });
    const sessionA = createCollaborationSession({ controller: a, documentId: "d", user: { id: "a" } });
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, sessionA.encodeUpdate());
    const b = createEditor({ markdown: "stale", projector });
    const sessionB = createCollaborationSession({ controller: b, documentId: "d", user: { id: "b" }, doc: remoteDoc });
    a.dispatch(new Transaction().replaceSource(0, 3, "two").withSource("test"));
    await sessionB.applyUpdate(sessionA.encodeUpdate(sessionB.encodeStateVector()));
    expect(b.getState().markdown).toBe("two");
    sessionA.destroy(); sessionB.destroy();
  });
});
