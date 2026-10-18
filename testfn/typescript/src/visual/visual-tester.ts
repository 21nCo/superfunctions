import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type {
  Screenshot,
  ComparisonResult,
  VisualTestConfig,
  CaptureOptions,
  PageLike,
} from "../types.js";
import { BaselineManager, environmentKey } from "./baseline-manager.js";
import {
  decodeImage,
  structuralSimilarity,
  sideBySide,
  comparisonHtml,
  pngWithMetadata,
} from "./images.js";

export class VisualTester {
  private config: VisualTestConfig & {
    diffDir: string;
    threshold: number;
    ssimThreshold: number;
  };
  readonly baselines: BaselineManager;
  constructor(config: VisualTestConfig) {
    const scope = config.environment
      ? createHash("sha256")
          .update(environmentKey(config.environment))
          .digest("hex")
      : "";
    this.config = {
      ...config,
      baselineDir: join(config.baselineDir, scope),
      diffDir: join(config.diffDir ?? `${config.baselineDir}-diffs`, scope),
      threshold: config.threshold ?? 0.1,
      ssimThreshold: config.ssimThreshold ?? 0.99,
    };
    for (const value of [this.config.threshold, this.config.ssimThreshold])
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new Error("threshold must be between 0 and 1");
    if (
      config.algorithm !== undefined &&
      !["pixel", "ssim"].includes(config.algorithm)
    )
      throw new Error("Unsupported visual comparison algorithm");
    mkdirSync(this.config.baselineDir, { recursive: true });
    mkdirSync(this.config.diffDir, { recursive: true });
    this.baselines = new BaselineManager(
      join(this.config.baselineDir, ".approvals"),
    );
  }
  async captureScreenshot(name: string, buffer: Buffer): Promise<Screenshot>;
  async captureScreenshot(
    page: PageLike,
    name: string,
    options?: CaptureOptions,
  ): Promise<Screenshot>;
  async captureScreenshot(
    source: string | PageLike,
    value: string | Buffer,
    options: CaptureOptions = {},
  ): Promise<Screenshot> {
    const name = typeof source === "string" ? source : (value as string);
    const buffer =
      typeof source === "string"
        ? (value as Buffer)
        : Buffer.from(
            await source.screenshot({
              type: "png",
              fullPage: options.fullPage ?? this.config.fullPage ?? false,
            }),
          );
    const png = decodeImage(buffer);
    return {
      name,
      buffer,
      width: png.width,
      height: png.height,
      timestamp: Date.now(),
      metadata: { environment: options.environment ?? this.config.environment },
    };
  }
  async compareScreenshot(
    current: Screenshot,
    baseline: string | Screenshot,
    options: { updateBaselines?: boolean } = {},
  ): Promise<ComparisonResult> {
    const name = typeof baseline === "string" ? baseline : current.name;
    this.imagePath(this.config.diffDir, name, "-diff.png");
    if (
      typeof baseline === "string" &&
      (options.updateBaselines ?? this.config.updateBaselines)
    ) {
      await this.updateBaseline(name, current);
      this.clearComparison(name);
      // Approval-required captures are proposals, never an automatically passing baseline change.
      return {
        passed: !this.config.approvalRequired,
        similarity: this.config.approvalRequired ? 0 : 1,
        pixelDiffCount: 0,
        diffPercentage: 0,
      };
    }
    let previous: Screenshot;
    if (typeof baseline !== "string") previous = baseline;
    else if (this.config.approvalRequired) {
      const approved = await this.baselines.retrieve(name);
      if (!approved) {
        await this.baselines.store(name, current);
        throw new Error(
          `No approved baseline for ${name}; approve the pending capture first`,
        );
      }
      previous = approved;
    } else {
      const path = this.imagePath(this.config.baselineDir, name, ".png");
      if (!existsSync(path))
        throw new Error(
          `No baseline found for ${name}. Run with updateBaselines=true to create.`,
        );
      previous = await this.captureScreenshot(name, readFileSync(path));
    }
    this.clearComparison(name);
    const a = decodeImage(previous.buffer),
      b = decodeImage(current.buffer);
    const sameSize = a.width === b.width && a.height === b.height;
    let count: number, diffImage: Buffer | undefined;
    let regions: ComparisonResult["regions"];
    if (sameSize) {
      const diff = new PNG({ width: a.width, height: a.height });
      count = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
        threshold: this.config.threshold,
        diffMask: true,
      });
      if (count) {
        let left = a.width,
          top = a.height,
          right = 0,
          bottom = 0;
        for (let y = 0; y < a.height; y++)
          for (let x = 0; x < a.width; x++)
            if (diff.data[(y * a.width + x) * 4 + 3]) {
              left = Math.min(left, x);
              top = Math.min(top, y);
              right = Math.max(right, x);
              bottom = Math.max(bottom, y);
            }
        regions = [
          {
            x: left,
            y: top,
            width: right - left + 1,
            height: bottom - top + 1,
            severity: count / (a.width * a.height) > 0.1 ? "major" : "minor",
          },
        ];
        diffImage = PNG.sync.write(diff);
      }
    } else {
      count = Math.max(a.width * a.height, b.width * b.height);
      diffImage = sideBySide(previous.buffer, current.buffer);
    }
    const percentage = sameSize ? (count / (a.width * a.height)) * 100 : 100;
    const ssim = structuralSimilarity(previous.buffer, current.buffer);
    const result: ComparisonResult = {
      passed:
        sameSize &&
        (this.config.algorithm === "ssim"
          ? ssim >= this.config.ssimThreshold
          : percentage <= this.config.threshold * 100),
      similarity:
        this.config.algorithm === "ssim" ? ssim : 1 - percentage / 100,
      ssim,
      pixelDiffCount: count,
      diffPercentage: percentage,
      ...(regions ? { regions } : {}),
    };
    if (diffImage) {
      result.diffImage = pngWithMetadata(diffImage, {
        name,
        timestamp: current.timestamp,
        ...result,
      });
      this.write(name, "-diff.png", result.diffImage);
    }
    this.write(
      name,
      "-comparison.png",
      pngWithMetadata(sideBySide(previous.buffer, current.buffer), {
        name,
        timestamp: current.timestamp,
        similarity: result.similarity,
      }),
    );
    this.write(
      name,
      "-comparison.html",
      comparisonHtml(name, previous, current),
    );
    if (this.config.approvalRequired && !result.passed)
      await this.baselines.store(name, current);
    return result;
  }
  async updateBaseline(name: string, screenshot: Screenshot): Promise<void> {
    this.imagePath(this.config.baselineDir, name, ".png");
    decodeImage(screenshot.buffer);
    if (this.config.approvalRequired) {
      await this.baselines.store(name, screenshot);
      return;
    }
    const path = this.imagePath(this.config.baselineDir, name, ".png");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, screenshot.buffer);
  }
  async getDiff(name: string): Promise<Buffer | null> {
    const path = this.imagePath(this.config.diffDir, name, "-diff.png");
    return existsSync(path) ? readFileSync(path) : null;
  }
  async getComparison(
    name: string,
  ): Promise<{ image: Buffer; html: string } | null> {
    const path = this.imagePath(this.config.diffDir, name, "-comparison.png");
    return existsSync(path)
      ? {
          image: readFileSync(path),
          html: readFileSync(
            this.imagePath(this.config.diffDir, name, "-comparison.html"),
            "utf8",
          ),
        }
      : null;
  }
  private write(name: string, suffix: string, value: Buffer | string): void {
    const path = this.imagePath(this.config.diffDir, name, suffix);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
  private clearComparison(name: string): void {
    for (const suffix of ["-diff.png", "-comparison.png", "-comparison.html"])
      rmSync(this.imagePath(this.config.diffDir, name, suffix), {
        force: true,
      });
  }
  private imagePath(directory: string, name: string, suffix: string): string {
    if (!name || name.includes("\0") || isAbsolute(name))
      throw new Error("Screenshot name must be a relative path");
    const root = resolve(directory),
      path = resolve(root, `${name}${suffix}`),
      local = relative(root, path);
    if (
      local === ".." ||
      local.startsWith("../") ||
      local.startsWith("..\\") ||
      isAbsolute(local)
    )
      throw new Error("Screenshot name escapes its directory");
    return path;
  }
  pixelDiff(img1: Buffer, img2: Buffer, threshold = 0.1): number {
    const a = decodeImage(img1),
      b = decodeImage(img2);
    if (a.width !== b.width || a.height !== b.height)
      return Math.max(a.width * a.height, b.width * b.height);
    return pixelmatch(a.data, b.data, null, a.width, a.height, { threshold });
  }
}

/** Framework-neutral screenshot assertion; runner-provided configuration travels to child processes via env. */
export async function visualTest(
  page: PageLike,
  name: string,
  config?: VisualTestConfig,
): Promise<ComparisonResult> {
  const resolved: VisualTestConfig =
    config ??
    (process.env.TESTFN_VISUAL_CONFIG
      ? JSON.parse(process.env.TESTFN_VISUAL_CONFIG)
      : undefined);
  if (!resolved || typeof resolved.baselineDir !== "string")
    throw new Error(
      "visualTest requires configuration or TESTFN_VISUAL_CONFIG",
    );
  const tester = new VisualTester(resolved);
  const result = await tester.compareScreenshot(
    await tester.captureScreenshot(page, name),
    name,
  );
  if (!result.passed)
    throw new Error(
      `Visual comparison failed for ${name}: ${result.diffPercentage.toFixed(2)}% changed, similarity ${result.similarity.toFixed(4)}`,
    );
  return result;
}
