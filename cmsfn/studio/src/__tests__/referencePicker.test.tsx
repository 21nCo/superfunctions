/**
 * PHASE_09: Reference picker — TV-REF-PICKER-001, TV-REF-PICKER-002.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReferenceField } from "../editor/widgets/reference/ReferenceField.js";

const BASE_URL = "http://contentfn.test";

describe("PHASE_09: Reference picker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-REF-PICKER-001: open picker, select doc → document stores canonical reference", () => {
    it("selecting a candidate calls onChange with canonical { _type: 'reference', _ref }", async () => {
      const candidates = {
        ok: true,
        result: {
          data: [
            { _id: "author-1", _type: "author", title: "Alice" },
            { _id: "author-2", _type: "author", title: "Bob" },
          ],
          nextCursor: null,
        },
      };
      let onChangeValue: unknown = undefined;
      const handlers = new Map<string, (body: unknown) => unknown>();
      handlers.set("/contentfn/query", () => candidates);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          const path = url.replace(BASE_URL, "");
          const body = init?.body ? JSON.parse(init.body as string) : undefined;
          const res = handlers.get(path) ?? handlers.get("*");
          const data = typeof res === "function" ? res(body) : res;
          return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
        })
      );

      render(
        <ReferenceField
          allowContentfnAuthorization
          value={undefined}
          onChange={(v) => {
            onChangeValue = v;
          }}
          baseUrl={BASE_URL}
          dataset="prod"
          allowedTypes={["author"]}
        />
      );

      const openBtn = screen.getByRole("button", { name: /choose reference/i });
      fireEvent.click(openBtn);

      await waitFor(() => expect(document.querySelector("[data-ref-picker-list]")).toBeDefined());
      const selectBtn = screen.getByRole("button", { name: /alice/i });
      fireEvent.click(selectBtn);

      expect(onChangeValue).toEqual({ _type: "reference", _ref: "author-1" });
    });
  });

  describe("TV-REF-PICKER-002: role denies doc.read → picker shows deterministic no access", () => {
    it("when hasDocRead is false, picker shows no access state", async () => {
      render(
        <ReferenceField
          allowContentfnAuthorization
          value={undefined}
          onChange={() => {}}
          baseUrl={BASE_URL}
          dataset="prod"
          allowedTypes={["author"]}
          hasDocRead={false}
        />
      );

      const openBtn = screen.getByRole("button", { name: /choose reference/i });
      fireEvent.click(openBtn);

      await waitFor(() => expect(document.querySelector("[data-ref-picker-denied]")).toBeDefined());
      expect(document.querySelector("[data-ref-picker-denied-message]")).toBeDefined();
      expect(screen.getByText(/no access/i)).toBeDefined();
    });
  });
});
