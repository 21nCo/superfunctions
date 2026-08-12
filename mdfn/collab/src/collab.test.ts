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

  it("queues offline edits, compacts them, reconnects, and converges", async () => {
    const left = createEditor({ markdown: "one", projector: createMarkdownProjector() });
    const right = createEditor({ markdown: "stale", projector: createMarkdownProjector() });
    let rightSession: ReturnType<typeof createCollaborationSession>;
    const events: string[] = [];
    const leftSession = createCollaborationSession({
      controller: left,
      documentId: "offline",
      user: { id: "left" },
      online: false,
      compactionThresholdBytes: 1,
      onAudit: (event) => events.push(event.type),
      sendUpdate: (update) => rightSession.applyUpdate(update, "left"),
    });
    const rightDoc = new Y.Doc();
    Y.applyUpdate(rightDoc, leftSession.encodeUpdate());
    rightSession = createCollaborationSession({
      controller: right,
      documentId: "offline",
      user: { id: "right" },
      doc: rightDoc,
    });
    left.dispatch(new Transaction().replaceSource(0, 3, "offline edit").withSource("test"));
    expect(leftSession.pendingUpdateCount()).toBe(1);
    expect(right.getState().markdown).toBe("one");
    await leftSession.setOnline(true);
    expect(right.getState().markdown).toBe("offline edit");
    expect(leftSession.pendingUpdateCount()).toBe(0);
    expect(events).toEqual(expect.arrayContaining(["local-update", "compact", "online", "flush"]));
    leftSession.destroy();
    rightSession.destroy();
  });

  it("rejects incompatible schema metadata before mutating the live document", async () => {
    const projector = createMarkdownProjector();
    const controller = createEditor({ markdown: "safe", projector });
    const session = createCollaborationSession({ controller, documentId: "d", user: { id: "a" } });
    const baseline = session.encodeStateVector();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, session.encodeUpdate());
    peer.getMap("metadata").set("schemaHash", "incompatible");
    await expect(session.applyUpdate(Y.encodeStateAsUpdate(peer, baseline), "peer")).rejects.toThrowError(/MDFN_COLLAB_SCHEMA_MISMATCH/);
    expect(session.doc.getMap("metadata").get("schemaHash")).toBe(controller.getState().schemaHash);
    session.destroy(); controller.destroy(); peer.destroy();
  });

  it("rejects malformed sidecars, unauthorized updates, and oversized payloads", async () => {
    const projector = createMarkdownProjector();
    const controller = createEditor({ markdown: "safe", projector });
    const session = createCollaborationSession({ controller, documentId: "d", user: { id: "a" }, maxUpdateBytes: 4096, authorizeUpdate: (_update, origin) => origin !== "forbidden" });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, session.encodeUpdate());
    const baseline = session.encodeStateVector();
    peer.getMap("sidecar").set("value", JSON.stringify({ comments: "invalid" }));
    const update = Y.encodeStateAsUpdate(peer, baseline);
    await expect(session.applyUpdate(update, "peer")).rejects.toThrowError(/MDFN_COLLAB_SIDECAR_INVALID/);
    await expect(session.applyUpdate(update, "forbidden")).rejects.toThrowError("MDFN_COLLAB_UPDATE_FORBIDDEN");
    await expect(session.applyUpdate(new Uint8Array(4097), "peer")).rejects.toThrowError(/MDFN_COLLAB_UPDATE_TOO_LARGE/);
    session.destroy(); controller.destroy(); peer.destroy();
  });
});
