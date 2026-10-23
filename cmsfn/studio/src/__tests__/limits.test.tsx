/**
 * PHASE_13: Limits — TV-LIMIT-RICHTEXT-001, precheck unit tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DocumentEditorPane } from "../panes/editor/DocumentEditorPane.js";
import { countRichtextBlocks, checkRichtextLimits, MAX_RICHTEXT_BLOCKS } from "../limits/precheck.js";

const BASE_URL = "http://contentfn.test";

describe("limits/precheck", () => {
  it("countRichtextBlocks returns array length", () => {
    expect(countRichtextBlocks([])).toBe(0);
    expect(countRichtextBlocks([{ _type: "block" }])).toBe(1);
    expect(countRichtextBlocks(Array(100).fill({ _type: "block" }))).toBe(100);
  });

  it("checkRichtextLimits passes when under limit", () => {
    const docType = {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "body", type: { kind: "richtext" as const }, required: false },
      ],
    };
    const result = checkRichtextLimits(
      { title: "Hi", body: Array(100).fill({ _type: "block" }) },
      docType as import("@contentfn/core").ContentfnDocumentType
    );
    expect(result.ok).toBe(true);
  });

  it("TV-LIMIT-RICHTEXT-001: checkRichtextLimits rejects when over max blocks", () => {
    const docType = {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "body", type: { kind: "richtext" as const }, required: false },
      ],
    };
    const overLimit = MAX_RICHTEXT_BLOCKS + 1;
    const result = checkRichtextLimits(
      { title: "Hi", body: Array(overLimit).fill({ _type: "block" }) },
      docType as import("@contentfn/core").ContentfnDocumentType
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe("body");
    }
  });
});

describe("TV-LIMIT-RICHTEXT-001: editor save rejected when richtext too large", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("save with richtext over max blocks does not call patchDoc", async () => {
    const schemaWithRichtext = {
      ok: true,
      result: {
        version: 1,
        documentTypes: [
          {
            name: "post",
            fields: [
              { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
              { name: "body", type: { kind: "richtext" as const }, required: false },
            ],
          },
        ],
      },
    };
    const docWithHugeRichtext = {
      ok: true,
      result: {
        _id: "post-1",
        _type: "post",
        _rev: "rev1",
        _createdAt: "2025-01-01T00:00:00Z",
        _updatedAt: "2025-01-01T00:00:00Z",
        title: "Hello",
        body: Array(MAX_RICHTEXT_BLOCKS + 1)
          .fill(null)
          .map((_, i) => ({ _type: "block", children: [{ _type: "span", text: `block ${i}` }] })),
      },
    };
    let patchCalls = 0;
    const handlers = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown }>>();
    handlers.set("/contentfn/schema/get", async () => ({ status: 200, body: schemaWithRichtext }));
    handlers.set("/contentfn/docs/get", async () => ({ status: 200, body: docWithHugeRichtext }));
    handlers.set("/contentfn/docs/patch", async () => {
      patchCalls++;
      return { status: 200, body: { ok: true, result: {} } };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        const path = url.replace(BASE_URL, "");
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const handler = handlers.get(path);
        if (handler) {
          const { status, body: data } = await handler(body);
          return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }), { status: 404 });
      })
    );

    render(<DocumentEditorPane baseUrl={BASE_URL} dataset="prod" docId="post-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDefined());
    screen.getByRole("button", { name: /save/i }).click();
    await waitFor(() => expect(patchCalls).toBe(0), { timeout: 500 });
  });
});
