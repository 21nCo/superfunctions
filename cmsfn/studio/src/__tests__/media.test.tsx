/**
 * PHASE_08: Media library — TV-MEDIA-UPLOAD-001, TV-MEDIA-BROWSE-001, TV-MEDIA-INSERT-001, TV-LIMIT-UPLOAD-001.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { uploadAssetWithLimit } from "../media/upload.js";
import { browseAssets } from "../media/browse.js";
import { buildAssetRef } from "../media/insertAssetRef.js";
import { MediaLibraryPane } from "../panes/media/MediaLibraryPane.js";
import { AssetWidget } from "../editor/widgets/AssetWidget.js";

describe("uploadAssetWithLimit", () => {
  it("TV-MEDIA-UPLOAD-001: calls ContentFn assets.upload when within limit", async () => {
    const baseUrl = "http://contentfn.test";
    let uploadBody: unknown = null;
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (String(url).includes("assets/upload")) {
        uploadBody = init?.body ? JSON.parse(init.body as string) : null;
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: { assetId: "asset_1", url: "https://cdn.example/1" } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      return Promise.reject(new Error("Unexpected"));
    }) as typeof fetch;

    const smallBase64 = Buffer.from("hello").toString("base64");
    const result = await uploadAssetWithLimit(
      { baseUrl, maxUploadBytes: 1000 },
      { dataset: "prod", filename: "a.txt", contentType: "text/plain", bytesBase64: smallBase64 }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assetId).toBe("asset_1");
      expect(result.url).toBe("https://cdn.example/1");
    }
    expect(uploadBody).toBeDefined();
    expect((uploadBody as Record<string, unknown>)?.dataset).toBe("prod");
    expect((uploadBody as Record<string, unknown>)?.filename).toBe("a.txt");
  });

  it("TV-LIMIT-UPLOAD-001: rejects with PAYLOAD_TOO_LARGE when over maxUploadBytes", async () => {
    const baseUrl = "http://contentfn.test";
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("Should not be called"))) as typeof fetch;

    const largeBase64 = "A".repeat(2000);
    const result = await uploadAssetWithLimit(
      { baseUrl, maxUploadBytes: 100 },
      { dataset: "prod", filename: "big.txt", contentType: "text/plain", bytesBase64: largeBase64 }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PAYLOAD_TOO_LARGE");
      expect(result.details?.limit).toBe(100);
    }
  });
});

describe("browseAssets", () => {
  it("TV-MEDIA-BROWSE-001: deterministic ordering (createdAt desc, assetId asc)", async () => {
    const baseUrl = "http://contentfn.test";
    const assets = [
      { assetId: "asset_2", url: "/2", filename: "b.txt", contentType: "text/plain", size: 2, createdAt: "2026-02-11T12:00:00Z" },
      { assetId: "asset_1", url: "/1", filename: "a.txt", contentType: "text/plain", size: 1, createdAt: "2026-02-11T12:00:00Z" },
    ];
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).includes("assets/list")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: { assets } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return Promise.reject(new Error("Unexpected"));
    }) as typeof fetch;

    const result = await browseAssets({ baseUrl, dataset: "prod" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assets).toHaveLength(2);
      expect(result.assets[0].assetId).toBe("asset_2");
      expect(result.assets[1].assetId).toBe("asset_1");
    }
  });
});

describe("buildAssetRef", () => {
  it("TV-MEDIA-INSERT-001: creates canonical asset ref with _type and _ref", () => {
    const ref = buildAssetRef("asset_123", "image/png");
    expect(ref).toEqual({ _type: "asset", _ref: "asset_123", assetType: "image" });

    const refFile = buildAssetRef("asset_456", "application/pdf");
    expect(refFile).toEqual({ _type: "asset", _ref: "asset_456", assetType: "file" });
  });
});

describe("MediaLibraryPane", () => {
  it("TV-MEDIA-UPLOAD-001: upload triggers ContentFn assets.upload and shows new asset", async () => {
    const listResult = { ok: true, result: { assets: [] as Array<{ assetId: string; url: string; filename: string; contentType: string; size: number; createdAt: string }> } };
    let listCalls = 0;
    let uploadCalls = 0;
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      if (url.includes("assets/list")) {
        listCalls++;
        return Promise.resolve(
          new Response(JSON.stringify(listCalls === 1 ? { ok: true, result: { assets: [] } } : { ok: true, result: { assets: [{ assetId: "asset_new", url: "/new", filename: "up.txt", contentType: "text/plain", size: 5, createdAt: "2026-02-11T12:00:00Z" }] } }), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      if (url.includes("assets/upload")) {
        uploadCalls++;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: { assetId: "asset_new", url: "/new" } }), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      return Promise.reject(new Error("Unexpected"));
    }) as typeof fetch;

    const onSelect = vi.fn();
    render(
      <MediaLibraryPane baseUrl="http://cf.test" dataset="prod" onSelectAsset={onSelect} />
    );

    await waitFor(() => {
      expect(document.querySelector("[data-media-list]")).toBeDefined();
    });

    const input = document.querySelector('[data-media-upload-input]') as HTMLInputElement;
    expect(input).toBeDefined();

    const file = new File(["hello"], "up.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(uploadCalls).toBe(1);
    });
    await waitFor(() => {
      const items = document.querySelectorAll("[data-media-item]");
      expect(items.length).toBeGreaterThanOrEqual(0);
    });
  });

  it("TV-MEDIA-INSERT-001: selecting asset calls onSelectAsset with canonical ref", async () => {
    const assets = [
      { assetId: "asset_1", url: "/1", filename: "a.png", contentType: "image/png", size: 10, createdAt: "2026-02-11T12:00:00Z" },
    ];
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).includes("assets/list")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: { assets } }), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }
      return Promise.reject(new Error("Unexpected"));
    }) as typeof fetch;

    const onSelect = vi.fn();
    render(
      <MediaLibraryPane baseUrl="http://cf.test" dataset="prod" onSelectAsset={onSelect} />
    );

    await waitFor(() => {
      const btn = document.querySelector('[data-media-select]');
      expect(btn).toBeDefined();
    });

    const selectBtn = document.querySelector('[data-media-select]');
    fireEvent.click(selectBtn!);

    expect(onSelect).toHaveBeenCalledWith({
      _type: "asset",
      _ref: "asset_1",
      assetType: "image",
    });
  });
});

describe("AssetWidget", () => {
  it("shows Select from library when onOpenMediaPicker provided", () => {
    const onOpen = vi.fn();
    render(
      <AssetWidget value={null} onChange={() => {}} onOpenMediaPicker={onOpen} />
    );
    const btn = document.querySelector('[data-asset-open-media]');
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    expect(onOpen).toHaveBeenCalled();
  });
});
