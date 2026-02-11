/**
 * PHASE_04 list pane tests: TV-LIST-QUERY-001, TV-LIST-PAGINATION-001, TV-LIST-QUERY-002.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DocumentListPane } from "../panes/list/DocumentListPane.js";

const BASE_URL = "http://contentfn.test";

function mockFetch(handler: (url: string, body: unknown) => Promise<Response>) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : (input as URL).href;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(url, body);
  });
}

describe("PHASE_04: Document lists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-LIST-QUERY-001: list uses CFQL deterministically", () => {
    it("opens document list pane for types [post] and issues CFQL with dataset, types, limit", async () => {
      const fetchMock = mockFetch(async (url, body) => {
        expect(url).toBe(`${BASE_URL}/contentfn/query`);
        expect(body).toBeDefined();
        expect(body.dataset).toBe("prod");
        expect(body.types).toEqual(["post"]);
        expect(typeof body.limit).toBe("number");
        return new Response(
          JSON.stringify({
            ok: true,
            result: { data: [], nextCursor: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DocumentListPane
          baseUrl={BASE_URL}
          dataset="prod"
          node={{
            kind: "documentList",
            title: "Posts",
            dataset: "prod",
            types: ["post"],
          }}
          limit={20}
        />
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `${BASE_URL}/contentfn/query`,
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
          })
        );
      });
      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.dataset).toBe("prod");
      expect(callBody.types).toEqual(["post"]);
      expect(callBody.limit).toBe(20);
    });
  });

  describe("TV-LIST-PAGINATION-001: pagination uses opaque cursor", () => {
    it("passes nextCursor back to ContentFn unchanged when clicking Next page", async () => {
      const opaqueCursor = "opaque-cursor-abc123";
      const fetchMock = mockFetch(async (_url, body) => {
        if (body.cursor) {
          expect(body.cursor).toBe(opaqueCursor);
          return new Response(
            JSON.stringify({
              ok: true,
              result: { data: [{ _id: "doc3", _type: "post", _rev: "r3", _createdAt: "", _updatedAt: "" }], nextCursor: null },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              data: [
                { _id: "doc1", _type: "post", _rev: "r1", _createdAt: "", _updatedAt: "" },
                { _id: "doc2", _type: "post", _rev: "r2", _createdAt: "", _updatedAt: "" },
              ],
              nextCursor: opaqueCursor,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DocumentListPane
          baseUrl={BASE_URL}
          dataset="prod"
          node={{ kind: "documentList", title: "Posts", dataset: "prod", types: ["post"] }}
          limit={2}
        />
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("button", { name: /next page/i })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /next page/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(secondCallBody.cursor).toBe(opaqueCursor);
    });
  });

  describe("TV-LIST-QUERY-002: list query error surfaced deterministically", () => {
    it("shows error state and retry when ContentFn returns error", async () => {
      const fetchMock = mockFetch(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "QUERY_INVALID", message: "Invalid query", details: {} },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DocumentListPane
          baseUrl={BASE_URL}
          dataset="prod"
          node={{ kind: "documentList", title: "Posts", dataset: "prod", types: ["post"] }}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeDefined();
      });
      const errorEl = document.querySelector("[data-list-error]");
      expect(errorEl).toBeTruthy();
      expect(errorEl?.getAttribute("data-error-code")).toBe("QUERY_INVALID");
      const retryBtn = document.querySelector("[data-list-error-retry]");
      expect(retryBtn).toBeTruthy();
    });
  });
});
