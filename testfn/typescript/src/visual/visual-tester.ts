import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Screenshot, ComparisonResult, VisualTestConfig } from '../types.js';

export class VisualTester {
  private config: Required<VisualTestConfig>;

  constructor(config: VisualTestConfig) {
    this.config = {
      baselineDir: config.baselineDir,
      diffDir: config.diffDir,
      threshold: config.threshold ?? 0.1,
      updateBaselines: config.updateBaselines ?? false,
      fullPage: config.fullPage ?? false
    };

    this.ensureDirectory(this.config.baselineDir);
    this.ensureDirectory(this.config.diffDir);
  }

  async captureScreenshot(name: string, buffer: Buffer): Promise<Screenshot> {
    const png = PNG.sync.read(buffer);
    
    return {
      name,
      buffer,
      width: png.width,
      height: png.height,
      timestamp: Date.now()
    };
  }

  async compareScreenshot(current: Screenshot, name: string): Promise<ComparisonResult> {
    const baselinePath = join(this.config.baselineDir, `${name}.png`);
    
    if (!existsSync(baselinePath)) {
      if (this.config.updateBaselines) {
        writeFileSync(baselinePath, current.buffer);
        return {
          passed: true,
          similarity: 1,
          pixelDiffCount: 0,
          diffPercentage: 0
        };
      }
      
      throw new Error(`No baseline found for ${name}. Run with updateBaselines=true to create.`);
    }

    const baselineBuffer = readFileSync(baselinePath);
    const baseline = PNG.sync.read(baselineBuffer);
    const currentPng = PNG.sync.read(current.buffer);

    if (baseline.width !== currentPng.width || baseline.height !== currentPng.height) {
      return {
        passed: false,
        similarity: 0,
        pixelDiffCount: baseline.width * baseline.height,
        diffPercentage: 100
      };
    }

    const diff = new PNG({ width: baseline.width, height: baseline.height });
    const pixelDiffCount = pixelmatch(
      baseline.data,
      currentPng.data,
      diff.data,
      baseline.width,
      baseline.height,
      { threshold: this.config.threshold }
    );

    const totalPixels = baseline.width * baseline.height;
    const diffPercentage = (pixelDiffCount / totalPixels) * 100;
    const similarity = 1 - (pixelDiffCount / totalPixels);

    if (pixelDiffCount > 0) {
      const diffPath = join(this.config.diffDir, `${name}-diff.png`);
      writeFileSync(diffPath, PNG.sync.write(diff));
    }

    return {
      passed: diffPercentage < this.config.threshold * 100,
      similarity,
      pixelDiffCount,
      diffPercentage,
      diffImage: pixelDiffCount > 0 ? PNG.sync.write(diff) : undefined
    };
  }

  async updateBaseline(name: string, screenshot: Screenshot): Promise<void> {
    const baselinePath = join(this.config.baselineDir, `${name}.png`);
    writeFileSync(baselinePath, screenshot.buffer);
  }

  async getDiff(name: string): Promise<Buffer | null> {
    const diffPath = join(this.config.diffDir, `${name}-diff.png`);
    if (!existsSync(diffPath)) {
      return null;
    }
    return readFileSync(diffPath);
  }

  private ensureDirectory(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  pixelDiff(img1: Buffer, img2: Buffer, threshold: number = 0.1): number {
    const png1 = PNG.sync.read(img1);
    const png2 = PNG.sync.read(img2);

    if (png1.width !== png2.width || png1.height !== png2.height) {
      return png1.width * png1.height;
    }

    const diff = new PNG({ width: png1.width, height: png1.height });
    return pixelmatch(
      png1.data,
      png2.data,
      diff.data,
      png1.width,
      png1.height,
      { threshold }
    );
  }
}
