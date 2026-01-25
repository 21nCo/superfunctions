import * as zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface CompressionOptions {
  algorithm?: "gzip" | "none";
  level?: number; // 1-9 for gzip
}

export class DataCompressor {
  /**
   * Compress data using the specified algorithm
   */
  static async compress(
    data: any,
    options: CompressionOptions = {}
  ): Promise<Buffer> {
    const { algorithm = "gzip", level = 6 } = options;

    const jsonString = JSON.stringify(data);
    const buffer = Buffer.from(jsonString, "utf-8");

    if (algorithm === "none") {
      return buffer;
    }

    return gzip(buffer, { level });
  }

  /**
   * Decompress data
   */
  static async decompress(
    compressed: Buffer,
    options: CompressionOptions = {}
  ): Promise<any> {
    const { algorithm = "gzip" } = options;

    let buffer: Buffer;
    if (algorithm === "none") {
      buffer = compressed;
    } else {
      buffer = await gunzip(compressed);
    }

    const jsonString = buffer.toString("utf-8");
    return JSON.parse(jsonString);
  }

  /**
   * Compress synchronously
   */
  static compressSync(data: any, options: CompressionOptions = {}): Buffer {
    const { algorithm = "gzip", level = 6 } = options;

    const jsonString = JSON.stringify(data);
    const buffer = Buffer.from(jsonString, "utf-8");

    if (algorithm === "none") {
      return buffer;
    }

    return zlib.gzipSync(buffer, { level });
  }

  /**
   * Decompress synchronously
   */
  static decompressSync(
    compressed: Buffer,
    options: CompressionOptions = {}
  ): any {
    const { algorithm = "gzip" } = options;

    let buffer: Buffer;
    if (algorithm === "none") {
      buffer = compressed;
    } else {
      buffer = zlib.gunzipSync(compressed);
    }

    const jsonString = buffer.toString("utf-8");
    return JSON.parse(jsonString);
  }

  /**
   * Calculate compression ratio
   */
  static getCompressionRatio(original: Buffer, compressed: Buffer): number {
    return compressed.length / original.length;
  }

  /**
   * Estimate compressed size without actually compressing
   */
  static estimateCompressedSize(data: any): number {
    const jsonString = JSON.stringify(data);
    const buffer = Buffer.from(jsonString, "utf-8");

    // Rough estimation: typical JSON compression ratio is 0.3-0.5
    return Math.floor(buffer.length * 0.4);
  }
}
