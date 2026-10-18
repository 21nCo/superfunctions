import { PNG } from "pngjs";
import type { Screenshot } from "../types.js";

/** Reject decompression bombs before allocating RGBA pixels (maximum 16 million pixels). */
export interface DecodedImage {
  width: number;
  height: number;
  data: Buffer;
}
export function decodeImage(buffer: Buffer): DecodedImage {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 33 ||
    buffer.length > 64 * 1024 * 1024 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid or oversized PNG");
  const width = buffer.readUInt32BE(16),
    height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > 16_000_000)
    throw new Error("PNG exceeds 16 million pixel limit");
  return PNG.sync.read(buffer);
}

/** Windowed luminance SSIM (Wang et al.), 8x8 windows, population covariance. */
export function structuralSimilarity(first: Buffer, second: Buffer): number {
  const a = decodeImage(first),
    b = decodeImage(second);
  if (a.width !== b.width || a.height !== b.height) return 0;
  const luminance = (data: Buffer, offset: number) => {
    const alpha = data[offset + 3] / 255;
    return (
      (0.299 * data[offset] +
        0.587 * data[offset + 1] +
        0.114 * data[offset + 2]) *
        alpha +
      255 * (1 - alpha)
    );
  };
  let sum = 0,
    windows = 0;
  for (let y = 0; y < a.height; y += 8)
    for (let x = 0; x < a.width; x += 8) {
      const left: number[] = [],
        right: number[] = [];
      for (let row = y; row < Math.min(y + 8, a.height); row++)
        for (let col = x; col < Math.min(x + 8, a.width); col++) {
          const offset = (row * a.width + col) * 4;
          left.push(luminance(a.data, offset));
          right.push(luminance(b.data, offset));
        }
      const n = left.length,
        meanA = left.reduce((s, v) => s + v, 0) / n,
        meanB = right.reduce((s, v) => s + v, 0) / n;
      let varianceA = 0,
        varianceB = 0,
        covariance = 0;
      for (let i = 0; i < n; i++) {
        varianceA += (left[i] - meanA) ** 2 / n;
        varianceB += (right[i] - meanB) ** 2 / n;
        covariance += ((left[i] - meanA) * (right[i] - meanB)) / n;
      }
      const c1 = (0.01 * 255) ** 2,
        c2 = (0.03 * 255) ** 2;
      sum +=
        ((2 * meanA * meanB + c1) * (2 * covariance + c2)) /
        ((meanA ** 2 + meanB ** 2 + c1) * (varianceA + varianceB + c2));
      windows++;
    }
  return Math.max(0, Math.min(1, sum / windows));
}

export function sideBySide(first: Buffer, second: Buffer): Buffer {
  const a = decodeImage(first),
    b = decodeImage(second);
  const output = new PNG({
    width: a.width + b.width,
    height: Math.max(a.height, b.height),
  });
  for (let y = 0; y < a.height; y++)
    a.data.copy(
      output.data,
      y * output.width * 4,
      y * a.width * 4,
      (y + 1) * a.width * 4,
    );
  for (let y = 0; y < b.height; y++)
    b.data.copy(
      output.data,
      (y * output.width + a.width) * 4,
      y * b.width * 4,
      (y + 1) * b.width * 4,
    );
  return PNG.sync.write(output);
}

/** Insert a standards-compliant PNG iTXt chunk before IEND. */
export function pngWithMetadata(
  png: Buffer,
  metadata: Record<string, unknown>,
): Buffer {
  const data = Buffer.from(
    `TestFn\0\0\0\0\0${JSON.stringify(metadata)}`,
    "utf8",
  );
  const type = Buffer.from("iTXt");
  const body = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4),
    footer = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([
    png.subarray(0, -12),
    header,
    body,
    footer,
    png.subarray(-12),
  ]);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function comparisonHtml(
  name: string,
  baseline: Screenshot,
  current: Screenshot,
): string {
  const image = (value: Screenshot) =>
    `data:image/png;base64,${value.buffer.toString("base64")}`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(name)} — visual comparison</title><style>body{font:16px system-ui;margin:2rem}main{max-width:1200px;margin:auto}.comparison{position:relative;max-width:100%;width:${Math.max(baseline.width, current.width)}px}.comparison img{display:block;width:100%}.overlay{position:absolute;inset:0;clip-path:inset(0 50% 0 0)}input{width:100%}.pair{display:flex;gap:1rem}.pair figure{margin:0;width:50%}.pair img{max-width:100%}</style><main><h1>${escapeHtml(name)}</h1><p>Move the slider to compare baseline (left) and current (right).</p><div class="comparison"><img alt="Current screenshot" src="${image(current)}"><div class="overlay" id="baseline"><img alt="Baseline screenshot" src="${image(baseline)}"></div></div><label for="position">Baseline visibility</label><input id="position" type="range" min="0" max="100" value="50"><div class="pair"><figure><figcaption>Baseline</figcaption><img alt="Baseline" src="${image(baseline)}"></figure><figure><figcaption>Current</figcaption><img alt="Current" src="${image(current)}"></figure></div></main><script>document.getElementById('position').addEventListener('input',function(){document.getElementById('baseline').style.clipPath='inset(0 '+(100-Number(this.value))+'% 0 0)'});</script></html>`;
}
