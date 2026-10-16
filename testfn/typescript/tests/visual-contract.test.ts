import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  BaselineManager,
  VisualTester,
  structuralSimilarity,
  visualTest,
} from "../src/visual/index.js";
import type { Screenshot } from "../src/types.js";
const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "testfn-visual-contract-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function png(value: number, width = 16, height = 16): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}
function screenshot(value: number): Screenshot {
  return {
    name: "home",
    buffer: png(value),
    width: 16,
    height: 16,
    timestamp: 10,
  };
}
it("SSIM matches the closed-form constant-image case and distinguishes structural changes", () => {
  expect(structuralSimilarity(png(100), png(100))).toBe(1);
  const expected = (2 * 100 * 110 + 6.5025) / (100 ** 2 + 110 ** 2 + 6.5025);
  expect(structuralSimilarity(png(100), png(110))).toBeCloseTo(expected, 8);
  expect(structuralSimilarity(png(0), png(255))).toBeLessThan(0.001);
  expect(structuralSimilarity(png(100), png(100, 8))).toBe(0);
  const pattern = PNG.sync.read(png(100));
  for (let offset = 0; offset < pattern.data.length; offset += 8)
    pattern.data.fill(0, offset, offset + 3);
  expect(structuralSimilarity(png(100), PNG.sync.write(pattern))).toBeLessThan(
    0.1,
  );
});
it("preserves approved bytes across proposals, reloads, rejection and stale approval attempts", async () => {
  const root = directory(),
    manager = new BaselineManager(root, { browser: "chromium" });
  await manager.store("home", screenshot(100));
  expect(await manager.retrieve("home")).toBeNull();
  const first = (await manager.getPending("home"))!;
  await manager.approve("home", first.revision);
  await manager.store("home", screenshot(110));
  const stale = (await manager.getPending("home"))!;
  await manager.store("home", screenshot(120));
  const reloaded = new BaselineManager(root, { browser: "chromium" });
  await expect(reloaded.approve("home", stale.revision)).rejects.toThrow(
    "changed",
  );
  expect((await reloaded.retrieve("home"))!.buffer).toEqual(png(100));
  expect(await reloaded.listPending()).toEqual(["home"]);
  await reloaded.reject("home");
  expect(await manager.listPending()).toEqual([]);
  expect((await manager.retrieve("home"))!.buffer).toEqual(png(100));
  expect(
    await new BaselineManager(root, { browser: "firefox" }).retrieve("home"),
  ).toBeNull();
});
it("supports page capture/fullPage and independent browser/viewport baselines", async () => {
  const root = directory(),
    options: unknown[] = [];
  const visual = new VisualTester({
    baselineDir: root,
    fullPage: true,
    environment: { browser: "chromium", viewport: { width: 800, height: 600 } },
  });
  const current = await visual.captureScreenshot(
    {
      screenshot: async (value) => {
        options.push(value);
        return png(100);
      },
    },
    "home",
  );
  expect(options).toEqual([{ type: "png", fullPage: true }]);
  await visual.updateBaseline("home", current);
  expect((await visual.compareScreenshot(current, "home")).passed).toBe(true);
  const other = new VisualTester({
    baselineDir: root,
    environment: { browser: "chromium", viewport: { width: 400, height: 600 } },
  });
  await expect(other.compareScreenshot(current, "home")).rejects.toThrow(
    "No baseline",
  );
});
it("uses SSIM acceptance separately from pixel tolerance and emits PNG metadata, regions and safe offline viewer", async () => {
  const root = directory(),
    visual = new VisualTester({
      baselineDir: root,
      threshold: 0,
      algorithm: "ssim",
      ssimThreshold: 0.99,
    });
  const result = await visual.compareScreenshot(
    screenshot(110),
    screenshot(100),
  );
  expect(result.passed).toBe(true);
  expect(result.pixelDiffCount).toBe(256);
  expect(result.ssim).toBeGreaterThan(0.99);
  expect(result.regions).toEqual([
    { x: 0, y: 0, width: 16, height: 16, severity: "major" },
  ]);
  expect(result.diffImage!.includes(Buffer.from("TestFn\0"))).toBe(true);
  expect(PNG.sync.read(result.diffImage!).width).toBe(16);
  const comparison = (await visual.getComparison("home"))!;
  expect(PNG.sync.read(comparison.image).width).toBe(32);
  expect(comparison.html).toContain('type="range"');
  expect(comparison.html).toContain("data:image/png;base64,");
  const malicious = { ...screenshot(100), name: "<script>alert(1)</script>" };
  // Rendering helper escapes untrusted titles independently of filesystem identifiers.
  const { comparisonHtml } = await import("../src/visual/index.js");
  expect(comparisonHtml(malicious.name, malicious, malicious)).not.toContain(
    "<script>alert(1)</script>",
  );
});
it("replaces stale evidence on dimension changes and clears it on later identical images", async () => {
  const visual = new VisualTester({ baselineDir: directory(), threshold: 0 });
  await visual.compareScreenshot(screenshot(0), screenshot(255));
  const before = await visual.getDiff("home");
  const small = { ...screenshot(0), buffer: png(0, 8), width: 8 };
  const mismatch = await visual.compareScreenshot(small, screenshot(255));
  expect(mismatch.passed).toBe(false);
  expect(await visual.getDiff("home")).not.toEqual(before);
  expect(PNG.sync.read((await visual.getDiff("home"))!).width).toBe(24);
  await visual.compareScreenshot(screenshot(255), screenshot(255));
  expect(await visual.getDiff("home")).toBeNull();
});
it("requires explicit approval before accepting baseline changes, including automatic-update mode", async () => {
  const root = directory(),
    visual = new VisualTester({
      baselineDir: root,
      approvalRequired: true,
      threshold: 0,
    });
  await expect(visual.compareScreenshot(screenshot(0), "home")).rejects.toThrow(
    "No approved baseline",
  );
  await visual.baselines.approve("home");
  expect((await visual.compareScreenshot(screenshot(0), "home")).passed).toBe(
    true,
  );
  expect((await visual.compareScreenshot(screenshot(255), "home")).passed).toBe(
    false,
  );
  expect((await visual.baselines.retrieve("home"))!.buffer).toEqual(png(0));
  const update = new VisualTester({
    baselineDir: root,
    approvalRequired: true,
    updateBaselines: true,
  });
  expect((await update.compareScreenshot(screenshot(255), "home")).passed).toBe(
    false,
  );
  await update.baselines.approve("home");
  expect((await visual.compareScreenshot(screenshot(255), "home")).passed).toBe(
    true,
  );
});
it("visualTest reads runner configuration, captures the page and fails changed rendering", async () => {
  const previous = process.env.TESTFN_VISUAL_CONFIG,
    root = directory();
  try {
    process.env.TESTFN_VISUAL_CONFIG = JSON.stringify({
      baselineDir: root,
      updateBaselines: true,
    });
    await expect(
      visualTest({ screenshot: async () => png(0) }, "home"),
    ).resolves.toMatchObject({ passed: true });
    process.env.TESTFN_VISUAL_CONFIG = JSON.stringify({
      baselineDir: root,
      threshold: 0,
    });
    await expect(
      visualTest({ screenshot: async () => png(255) }, "home"),
    ).rejects.toThrow("Visual comparison failed");
    expect(readFileSync(join(root, "home.png"))).toEqual(png(0));
  } finally {
    if (previous === undefined) delete process.env.TESTFN_VISUAL_CONFIG;
    else process.env.TESTFN_VISUAL_CONFIG = previous;
  }
});
it("prevents path escapes for baseline and viewer writes", async () => {
  const visual = new VisualTester({ baselineDir: directory() });
  await expect(
    visual.compareScreenshot(
      { ...screenshot(0), name: "../../escape" },
      screenshot(255),
    ),
  ).rejects.toThrow("escapes");
  await expect(
    visual.updateBaseline("/tmp/escape", screenshot(0)),
  ).rejects.toThrow("relative");
});

it("rejects oversized PNG dimensions before decompression through capture and baseline proposals", async () => {
  const buffer = Buffer.from(png(0));
  buffer.writeUInt32BE(100000, 16);
  buffer.writeUInt32BE(100000, 20);
  const visual = new VisualTester({ baselineDir: directory() });
  await expect(visual.captureScreenshot("huge", buffer)).rejects.toThrow(
    "pixel limit",
  );
  await expect(
    visual.baselines.store("huge", { ...screenshot(0), buffer }),
  ).rejects.toThrow("pixel limit");
});
