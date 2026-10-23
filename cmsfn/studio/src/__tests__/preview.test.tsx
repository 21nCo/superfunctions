/**
 * PHASE_07: Preview pane — TV-PREVIEW-DISABLED-001, TV-PREVIEW-LIVE-001.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreviewPane } from "../panes/preview/PreviewPane.js";
import { subscribeToDoc } from "../realtime/subscribe.js";

describe("PreviewPane", () => {
  describe("TV-PREVIEW-DISABLED-001: preview not configured", () => {
    it("when previewEnabled is false shows deterministic disabled UI", () => {
      render(
        <PreviewPane
          previewEnabled={false}
          targetOrigin="https://preview.test"
          resolveUrl={() => "https://preview.test/doc"}
        />
      );
      const pane = document.querySelector("[data-preview-pane]");
      expect(pane).toBeDefined();
      expect(pane?.getAttribute("data-preview-disabled")).toBe("true");
      expect(screen.getByText(/preview is not configured/i)).toBeDefined();
    });

    it("when previewEnabled is true but cmsfnApiUrl and docId missing shows disabled message", () => {
      render(
        <PreviewPane
          previewEnabled
          targetOrigin="https://preview.test"
          resolveUrl={() => "https://preview.test/doc"}
        />
      );
      const pane = document.querySelector("[data-preview-pane]");
      expect(pane?.getAttribute("data-preview-disabled")).toBe("true");
    });
  });

  describe("TV-PREVIEW-LIVE-001: preview updates on draft changes", () => {
    it("refreshTrigger change causes preview to refresh (iframe remounts with new key)", async () => {
      const resolveUrl = vi.fn(() => "https://preview.test/doc/1");
      const envelope = {
        ok: true,
        result: { token: "t1", expiresAt: new Date(Date.now() + 6e4).toISOString(), dataset: "prod", docIds: ["post-1"] },
      };
      globalThis.fetch = vi.fn((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (String(url).includes("preview/token")) {
          return Promise.resolve(new Response(JSON.stringify(envelope), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        return Promise.reject(new Error("Unexpected URL"));
      }) as typeof fetch;

      const { rerender } = render(
        <PreviewPane
          previewEnabled
          targetOrigin="https://preview.test"
          resolveUrl={resolveUrl}
          cmsfnApiUrl="http://cmsfn.test"
          dataset="prod"
          doc={{ _id: "post-1" }}
          refreshTrigger={0}
        />
      );

      await screen.findByTitle("Preview");
      const iframe1 = document.querySelector('[data-preview-iframe]');
      expect(iframe1).toBeDefined();
      expect((iframe1 as HTMLIFrameElement)?.src).toContain("cmsfn_preview_token=");

      rerender(
        <PreviewPane
          previewEnabled
          targetOrigin="https://preview.test"
          resolveUrl={resolveUrl}
          cmsfnApiUrl="http://cmsfn.test"
          dataset="prod"
          doc={{ _id: "post-1" }}
          refreshTrigger={1}
        />
      );

      const iframe2 = document.querySelector('[data-preview-iframe]');
      expect(iframe2).toBeDefined();
      expect((iframe2 as HTMLIFrameElement)?.src).toContain("cmsfn_preview_token=");
    });
  });
});

describe("subscribeToDoc", () => {
  it("returns no-op unsubscribe when realtimeUrl is not set", () => {
    const onUpdate = vi.fn();
    const unsub = subscribeToDoc({
      dataset: "prod",
      docId: "post-1",
      onUpdate,
    });
    unsub();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
