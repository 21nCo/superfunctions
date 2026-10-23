/**
 * PHASE_14 collaboration UI: remote-changed banner (TV-COLLAB-002), list refresh (TV-COLLAB-001).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DocumentEditorPane } from "../panes/editor/DocumentEditorPane.js";
import { DocumentListPane } from "../panes/list/DocumentListPane.js";

const BASE_URL = "http://cf.test";
const schemaRes = { ok: true, result: { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" }, required: true }] }] } };
const docRes = { ok: true, result: { _id: "post-1", _type: "post", _rev: "r1", _createdAt: "2025-01-01T00:00:00Z", _updatedAt: "2025-01-01T00:00:00Z", title: "Hi" } };

function mockFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/schema/")) return new Response(JSON.stringify(schemaRes), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/docs/")) return new Response(JSON.stringify(docRes), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Not found", details: {} } }), { status: 200 });
  });
}

describe("TV-COLLAB-002: editor shows remote-changed banner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows remote-changed banner when remoteChanged is true", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(
      <DocumentEditorPane
        baseUrl={BASE_URL}
        dataset="prod"
        docId="post-1"
        remoteChanged
        onClearRemoteChanged={() => {}}
      />
    );
    await waitFor(() => expect(document.querySelector("[data-editor-pane]")).toBeTruthy());
    expect(document.querySelector("[data-remote-changed-banner]")).toBeTruthy();
    expect(screen.getByText(/document changed elsewhere/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
  });

  it("does not show banner when remoteChanged is false", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(
      <DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />
    );
    await waitFor(() => expect(document.querySelector("[data-editor-pane]")).toBeTruthy());
    expect(document.querySelector("[data-remote-changed-banner]")).toBeFalsy();
  });
});

describe("TV-COLLAB-001: list refresh trigger", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("queries again when refreshTrigger changes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true, result: { data: [docRes.result], nextCursor: null },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const node = { kind: "documentList" as const, title: "Posts", dataset: "prod", types: ["post"] };
    const { rerender, unmount } = render(
      <DocumentListPane baseUrl={BASE_URL} dataset="prod" node={node} refreshTrigger={0} />
    );
    await waitFor(() => expect(document.querySelector('[data-doc-id="post-1"]')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<DocumentListPane baseUrl={BASE_URL} dataset="prod" node={node} refreshTrigger={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('[data-list-loading]')).toBeNull());
    unmount();
  });
});
