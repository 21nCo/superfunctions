import { describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/renderer";
import type { ImageElement, Scene } from "../src/types";
const image = (src: string): ImageElement => ({ id: src, type: "image", src, x: 0, y: 0, w: 10, h: 10, rotation: 0, stroke: "black", fill: "transparent", strokeWidth: 0, opacity: 1 });
const scene = (sources: string[]): Scene => ({ version: 1, id: "scene", camera: { x: 0, y: 0, zoom: 1 }, background: { color: "white" }, elements: sources.map(image) });
const canvas = () => { const c = document.createElement("canvas"); c.width = 100; c.height = 100; return c; };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const sources = Array.from({ length: 64 }, (_, i) => `image:${i}`);

describe("renderer image capacity", () => {
  it("rejects oversized export preloads before invoking any loader", async () => {
    const loader = vi.fn(); const renderer = new Renderer(canvas(), loader);
    await expect(renderer.preloadImages(scene([...sources, "overflow"]).elements)).rejects.toMatchObject({ code: "SCENE_LIMIT_EXCEEDED" });
    expect(loader).not.toHaveBeenCalled(); renderer.dispose();
  });

  it("retains visible images and reports excess sources once, then recovers when one is removed", async () => {
    const assets: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const loader = vi.fn(async () => { const asset = { close: vi.fn() }; assets.push(asset); return asset as unknown as ImageBitmap; });
    const error = vi.fn(); const renderer = new Renderer(canvas(), loader, { onImageError: error });
    renderer.render(scene([...sources, "overflow"])); await settle();
    renderer.render(scene([...sources, "overflow"])); await settle();
    expect(loader).toHaveBeenCalledTimes(64); expect(error).toHaveBeenCalledTimes(1);
    expect(assets.every(asset => asset.close.mock.calls.length === 0)).toBe(true);
    renderer.render(scene([...sources.slice(1), "overflow"])); await settle();
    expect(loader).toHaveBeenCalledTimes(65); expect(assets[0].close).toHaveBeenCalledOnce();
    renderer.dispose(); expect(assets.every(asset => asset.close.mock.calls.length === 1)).toBe(true);
  });

  it("reserves removed pending requests until settlement, closes stale assets, and wakes blocked sources", async () => {
    const finish: Array<(asset: ImageBitmap) => void> = [];
    const loader = vi.fn(() => new Promise<ImageBitmap>(resolve => finish.push(resolve)));
    const loaded = vi.fn(); const error = vi.fn(); const renderer = new Renderer(canvas(), loader, { onImageLoaded: loaded, onImageError: error });
    renderer.render(scene(sources)); await settle();
    renderer.render(scene(["replacement"])); await settle();
    expect(loader).toHaveBeenCalledTimes(64); expect(error).toHaveBeenCalledOnce();
    const old = { close: vi.fn() };
    finish[0](old as unknown as ImageBitmap); await settle();
    expect(old.close).toHaveBeenCalledOnce(); expect(loaded).toHaveBeenCalledWith("replacement");
    renderer.render(scene(["replacement"])); await settle(); expect(loader).toHaveBeenCalledTimes(65);
    renderer.dispose();
    const late = finish.slice(1).map(resolve => { const asset = { close: vi.fn() }; resolve(asset as unknown as ImageBitmap); return asset; });
    await settle(); expect(late.every(asset => asset.close.mock.calls.length === 1)).toBe(true);
  });

  it("shares same-source flights and releases reservations after synchronous loader failures", async () => {
    let resolve!: (asset: ImageBitmap) => void;
    const loader = vi.fn(() => new Promise<ImageBitmap>(done => { resolve = done; }));
    const renderer = new Renderer(canvas(), loader);
    const first = renderer.preloadImages([image("same"), image("same")]);
    const second = renderer.preloadImages([image("same")]); await settle();
    expect(loader).toHaveBeenCalledOnce(); resolve({ close: vi.fn() } as unknown as ImageBitmap); await Promise.all([first, second]); renderer.dispose();
    const fail = vi.fn(() => { throw new Error("offline"); });
    const retry = new Renderer(canvas(), fail);
    for (let i = 0; i < 65; i++) await expect(retry.preloadImages([image(String(i))])).rejects.toMatchObject({ code: "EXPORT_IMAGE_LOAD_FAILED" });
    expect(fail).toHaveBeenCalledTimes(65); retry.dispose();
  });
});
