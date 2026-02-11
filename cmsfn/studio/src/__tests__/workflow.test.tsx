/**
 * PHASE_06: Workflow state + publish/unpublish — TV-WF-STATE-001, TV-WORKFLOW-DRAFT-001, TV-WORKFLOW-PUBLISH-001, TV-WORKFLOW-UNPUBLISH-001.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { writeCmsMetadata } from "../workflow/writeCmsMetadata.js";
import { WorkflowControls } from "../workflow/WorkflowControls.js";
import { PublishButton } from "../publish/PublishButton.js";
import { DocumentEditorPane } from "../panes/editor/DocumentEditorPane.js";

describe("writeCmsMetadata", () => {
  it("TV-WF-STATE-001: produces _cms shape with workflow and state in_review", () => {
    const meta = writeCmsMetadata("in_review", { workflowName: "default" });
    expect(meta.workflow).toBe("default");
    expect(meta.state).toBe("in_review");
    expect(meta.updatedAt).toBeDefined();
    expect(typeof meta.updatedAt).toBe("string");
  });
});

describe("WorkflowControls", () => {
  it("TV-WF-STATE-001: moving to in_review sends patch with _cms.workflow and _cms.state", async () => {
    const BASE_URL = "http://contentfn.test";
    let lastPatchBody: unknown = null;
    const patchHandler = vi.fn((_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      lastPatchBody = body;
      return Promise.resolve({
        status: 200,
        body: {
          ok: true,
          result: {
            _id: "drafts.post-1",
            _type: "post",
            _rev: "rev-2",
            _cms: { workflow: "default", state: "in_review", updatedAt: new Date().toISOString() },
          },
        },
      });
    });
    const handlers = new Map<string, (url: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>>();
    handlers.set("/contentfn/docs/patch", patchHandler);
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const key = [...handlers.keys()].find((k) => url.includes(k));
      const h = key ? handlers.get(key) : undefined;
      if (h) {
        return (h(url, init) as Promise<{ status: number; body: unknown }>).then((r) =>
          new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } })
        );
      }
      return Promise.reject(new Error("No handler"));
    }) as typeof fetch;

    const onStateSaved = vi.fn();
    render(
      <WorkflowControls
        baseUrl={BASE_URL}
        dataset="prod"
        docId="drafts.post-1"
        currentRev="rev-1"
        currentCms={{ workflow: "default", state: "draft", updatedAt: "" }}
        onStateSaved={onStateSaved}
      />
    );

    const inReviewBtn = screen.getByRole("button", { name: /in review/i });
    fireEvent.click(inReviewBtn);

    await waitFor(() => {
      expect(patchHandler).toHaveBeenCalled();
    });
    expect(lastPatchBody).toBeDefined();
    const patch = lastPatchBody as { ops?: Array<{ op: string; path: string; value: unknown }> };
    expect(patch?.ops).toBeDefined();
    const cmsOp = patch.ops?.find((o) => o.path === "_cms" && o.op === "set");
    expect(cmsOp).toBeDefined();
    const value = cmsOp?.value as { workflow?: string; state?: string };
    expect(value?.workflow).toBe("default");
    expect(value?.state).toBe("in_review");
  });
});

describe("PublishButton", () => {
  it("TV-WORKFLOW-PUBLISH-001: click Publish calls POST /cmsfn/publish with dataset and id", async () => {
    const CMSFN_URL = "http://cmsfn.test";
    let publishBody: unknown = null;
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/cmsfn/publish")) {
        publishBody = init?.body ? JSON.parse(init.body as string) : null;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      return Promise.reject(new Error("Unexpected URL"));
    }) as typeof fetch;

    const onPublished = vi.fn();
    render(
      <PublishButton
        cmsfnApiUrl={CMSFN_URL}
        dataset="prod"
        docId="post-1"
        onPublished={onPublished}
      />
    );

    const publishBtn = screen.getByRole("button", { name: /publish/i });
    fireEvent.click(publishBtn);

    await waitFor(() => {
      expect(publishBody).toEqual({ dataset: "prod", id: "post-1" });
      expect(onPublished).toHaveBeenCalled();
    });
  });

  it("TV-WORKFLOW-UNPUBLISH-001: click Unpublish calls POST /cmsfn/unpublish", async () => {
    const CMSFN_URL = "http://cmsfn.test";
    let unpublishBody: unknown = null;
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/cmsfn/unpublish")) {
        unpublishBody = init?.body ? JSON.parse(init.body as string) : null;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      return Promise.reject(new Error("Unexpected URL"));
    }) as typeof fetch;

    const onUnpublished = vi.fn();
    render(
      <PublishButton
        cmsfnApiUrl={CMSFN_URL}
        dataset="prod"
        docId="post-1"
        isPublished
        onUnpublished={onUnpublished}
      />
    );

    const unpublishBtn = screen.getByRole("button", { name: /unpublish/i });
    fireEvent.click(unpublishBtn);

    await waitFor(() => {
      expect(unpublishBody).toEqual({ dataset: "prod", id: "post-1" });
      expect(onUnpublished).toHaveBeenCalled();
    });
  });
});

describe("DocumentEditorPane workflow UI", () => {
  it("TV-WORKFLOW-DRAFT-001: open draft doc shows Draft state and workflow controls", async () => {
    const BASE_URL = "http://contentfn.test";
    const schemaWithTypes = {
      documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "string" }, required: false }] }],
    };
    const docDraft = {
      _id: "drafts.post-1",
      _type: "post",
      _rev: "rev-1",
      title: "Hello",
      _cms: { workflow: "default", state: "draft", updatedAt: new Date().toISOString() },
    };
    const handlers = new Map<string, () => Promise<{ status: number; body: unknown }>>();
    handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: { ok: true, result: schemaWithTypes } }));
    handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: { ok: true, result: docDraft } }));
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const key = [...handlers.keys()].find((k) => url.includes(k));
      const h = key ? handlers.get(key) : undefined;
      if (h) return (h() as Promise<{ status: number; body: unknown }>).then((r) => new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } }));
      return Promise.reject(new Error("No handler"));
    }) as typeof fetch;

    render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="drafts.post-1" />);

    await waitFor(() => {
      const controls = document.querySelector("[data-workflow-controls]");
      expect(controls).toBeDefined();
    });
    const controls = document.querySelector("[data-workflow-controls]");
    expect(controls?.getAttribute("data-current-state")).toBe("draft");
    const pane = document.querySelector("[data-editor-pane]");
    expect(pane?.getAttribute("data-draft-indicator")).toBe("true");
  });
});
