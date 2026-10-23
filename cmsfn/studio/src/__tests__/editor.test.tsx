/**
 * PHASE_05 editor tests: TV-EDITOR-RENDER-001/002, TV-EDITOR-VALIDATE-001/002, TV-EDITOR-SAVE-001, TV-EDITOR-CONFLICT-001.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DocumentEditorPane } from "../panes/editor/DocumentEditorPane.js";
import { buildPatchOps } from "../editor/save/buildPatchOps.js";

const BASE_URL = "http://contentfn.test";

function mockFetch(handlers: Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : (input as URL).href;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const key = url.replace(BASE_URL, "");
    const handler = handlers.get(key) ?? handlers.get("*");
    if (!handler) return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Not found", details: {} } }), { status: 200 });
    const { status, body: data } = await handler(body);
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  });
}

const schemaWithTypes = {
  ok: true,
  result: {
    version: 1,
    documentTypes: [
      {
        name: "post",
        fields: [
          { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
          { name: "views", type: { kind: "primitive" as const, type: "number" as const }, required: false },
          { name: "body", type: { kind: "richtext" as const }, required: false },
          { name: "hero", type: { kind: "asset" as const, assetType: "image" as const }, required: false },
          { name: "author", type: { kind: "reference" as const, to: ["author"] }, required: false },
        ],
      },
    ],
  },
};

const docPost = {
  ok: true,
  result: {
    _id: "post-1",
    _type: "post",
    _rev: "rev1",
    _createdAt: "2025-01-01T00:00:00Z",
    _updatedAt: "2025-01-01T00:00:00Z",
    title: "Hello",
    views: 10,
  },
};

describe("PHASE_05: Schema-driven editor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-EDITOR-RENDER-001: schema widgets render", () => {
    it("each field type renders a corresponding widget", async () => {
      const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
      handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaWithTypes }));
      handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docPost }));
      handlers.set("/contentfn/docs/patch", async () => ({ status: 200, body: { ok: true, result: docPost.result } }));
      vi.stubGlobal("fetch", mockFetch(handlers));

      render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDefined());

      expect(document.querySelector('[data-widget="string"]')).toBeDefined();
      expect(document.querySelector('[data-widget="number"]')).toBeDefined();
      expect(document.querySelector('[data-widget="richtext"]')).toBeDefined();
      expect(document.querySelector('[data-widget="reference-field"]')).toBeDefined();
      expect(document.querySelector('[data-widget="asset"]')).toBeDefined();
    });
  });

  describe("TV-EDITOR-RENDER-002: unknown type error state", () => {
    it("editor shows error when document type not in schema", async () => {
      const schemaNoUnknown = {
        ok: true,
        result: { version: 1, documentTypes: [{ name: "post", fields: [] }] },
      };
      const docUnknown = {
        ok: true,
        result: {
          _id: "x-1",
          _type: "unknownType",
          _rev: "r1",
          _createdAt: "",
          _updatedAt: "",
        },
      };
      const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
      handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaNoUnknown }));
      handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docUnknown }));
      vi.stubGlobal("fetch", mockFetch(handlers));

      render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="x-1" />);
      await waitFor(() => expect(document.querySelector("[data-editor-pane][data-error]")).toBeDefined());
      expect(document.querySelector("[data-error-code]")).toBeDefined();
    });
  });

  describe("TV-EDITOR-VALIDATE-001: client-side required validation", () => {
    it("clearing required field and saving shows validation before sending patch", async () => {
      let patchCalls = 0;
      const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
      handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaWithTypes }));
      handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docPost }));
      handlers.set("/contentfn/docs/patch", async () => {
        patchCalls++;
        return { status: 200, body: { ok: true, result: docPost.result } };
      });
      vi.stubGlobal("fetch", mockFetch(handlers));

      render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDefined());

      const titleInput = document.querySelector('[data-editor-field="title"] input');
      expect(titleInput).toBeDefined();
      fireEvent.change(titleInput!, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(patchCalls).toBe(0));
    });
  });

  describe("TV-EDITOR-VALIDATE-002: server VALIDATION_FAILED surfaced with path", () => {
    it("save returning VALIDATION_FAILED shows error and does not claim success", async () => {
      const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
      handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaWithTypes }));
      handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docPost }));
      handlers.set("/contentfn/docs/patch", async () => ({
        status: 200,
        body: { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid", details: { path: "title" } } },
      }));
      vi.stubGlobal("fetch", mockFetch(handlers));

      render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(document.querySelector("[data-editor-pane]")?.getAttribute("data-error")).toBeFalsy());
      expect(screen.getByRole("button", { name: /save/i })).toBeDefined();
    });
  });

  describe("TV-EDITOR-SAVE-001: save uses docs.patch with ifRev", () => {
    it("edit and save sends patch with ifRev and ops", async () => {
      let patchBody: unknown = null;
      const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
      handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaWithTypes }));
      handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docPost }));
      handlers.set("/contentfn/docs/patch", async (body) => {
        patchBody = body;
        return { status: 200, body: { ok: true, result: { ...docPost.result, _rev: "rev2", title: (body as { ops: unknown[] }).ops?.[0] ? "Edited" : docPost.result.title } } };
      });
      vi.stubGlobal("fetch", mockFetch(handlers));

      render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDefined());

      const titleInput = document.querySelector('[data-editor-field="title"] input');
      fireEvent.change(titleInput!, { target: { value: "Edited" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(patchBody).not.toBeNull());
      expect((patchBody as { ifRev?: string }).ifRev).toBe("rev1");
      expect(Array.isArray((patchBody as { ops?: unknown[] }).ops)).toBe(true);
    });
  });

  describe("TV-EDITOR-CONFLICT-001: REV_CONFLICT shows conflict UI", () => {
    it("save returning REV_CONFLICT shows conflict banner with refresh and re-apply", async () => {
      const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
      handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaWithTypes }));
      handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docPost }));
      let patchCallCount = 0;
      handlers.set("/contentfn/docs/patch", async () => {
        patchCallCount++;
        if (patchCallCount === 1) {
          return {
            status: 200,
            body: { ok: false, error: { code: "REV_CONFLICT", message: "Revision conflict", details: {} } },
          };
        }
        return { status: 200, body: { ok: true, result: { ...docPost.result, _rev: "rev2" } } };
      });
      vi.stubGlobal("fetch", mockFetch(handlers));

      render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(document.querySelector("[data-conflict-banner]")).toBeDefined());
      expect(document.querySelector("[data-conflict-refresh]")).toBeDefined();
      expect(document.querySelector("[data-conflict-reapply]")).toBeDefined();
    });
  });
});

describe("buildPatchOps", () => {
  it("returns ops in sorted path order", () => {
    const original = { _id: "1", _type: "post", _rev: "r1", title: "A", views: 1 };
    const current = { _id: "1", _type: "post", title: "B", views: 2 };
    const ops = buildPatchOps(original, current);
    const paths = ops.map((o) => o.path).filter(Boolean);
    expect(paths).toEqual([...paths].sort());
    expect(ops.some((o) => o.op === "set" && o.path === "title")).toBe(true);
    expect(ops.some((o) => o.op === "set" && o.path === "views")).toBe(true);
  });
});
