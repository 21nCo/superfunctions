import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { decodeImage } from "./images.js";
import type { Screenshot, VisualEnvironment } from "../types.js";

type StoredScreenshot = Omit<Screenshot, "buffer"> & { buffer: string };
interface RecordFile {
  name: string;
  environment: string;
  approved?: StoredScreenshot;
  pending?: StoredScreenshot;
  revision?: string;
}
export function environmentKey(environment?: VisualEnvironment): string {
  return JSON.stringify([
    environment?.name ?? "",
    environment?.browser ?? "",
    environment?.viewport?.width ?? null,
    environment?.viewport?.height ?? null,
  ]);
}

/** Durable pending/approved snapshots. store stages; only approve changes the approved baseline. */
export class BaselineManager {
  private directory: string;
  private environment: string;
  constructor(directory: string, environment?: VisualEnvironment) {
    this.directory = resolve(directory);
    this.environment = environmentKey(environment);
    mkdirSync(this.directory, { recursive: true });
  }
  private path(name: string): string {
    if (!name || name.includes("\0"))
      throw new Error("Baseline name must be non-empty");
    return join(
      this.directory,
      createHash("sha256")
        .update(JSON.stringify([this.environment, name]))
        .digest("hex") + ".json",
    );
  }
  private read(name: string): RecordFile {
    try {
      return JSON.parse(readFileSync(this.path(name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { name, environment: this.environment };
      throw error;
    }
  }
  private write(record: RecordFile): void {
    const path = this.path(record.name),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record));
      renameSync(temporary, path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  async store(name: string, screenshot: Screenshot): Promise<void> {
    const png = decodeImage(screenshot.buffer);
    const record = this.read(name);
    record.pending = {
      ...screenshot,
      name,
      width: png.width,
      height: png.height,
      buffer: screenshot.buffer.toString("base64"),
    };
    record.revision = randomUUID();
    this.write(record);
  }
  async retrieve(name: string): Promise<Screenshot | null> {
    const value = this.read(name).approved;
    return value
      ? { ...value, buffer: Buffer.from(value.buffer, "base64") }
      : null;
  }
  async getPending(
    name: string,
  ): Promise<{ screenshot: Screenshot; revision: string } | null> {
    const record = this.read(name);
    return record.pending
      ? {
          screenshot: {
            ...record.pending,
            buffer: Buffer.from(record.pending.buffer, "base64"),
          },
          revision: record.revision!,
        }
      : null;
  }
  async approve(name: string, expectedRevision?: string): Promise<void> {
    const record = this.read(name);
    if (!record.pending) throw new Error(`No pending baseline for ${name}`);
    if (expectedRevision !== undefined && record.revision !== expectedRevision)
      throw new Error("Pending baseline changed");
    record.approved = record.pending;
    delete record.pending;
    delete record.revision;
    this.write(record);
  }
  async reject(name: string, expectedRevision?: string): Promise<void> {
    const record = this.read(name);
    if (!record.pending) throw new Error(`No pending baseline for ${name}`);
    if (expectedRevision !== undefined && record.revision !== expectedRevision)
      throw new Error("Pending baseline changed");
    delete record.pending;
    delete record.revision;
    this.write(record);
  }
  async listPending(): Promise<string[]> {
    const names: string[] = [];
    for (const file of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const record: RecordFile = JSON.parse(
        readFileSync(join(this.directory, file), "utf8"),
      );
      if (record.environment === this.environment && record.pending)
        names.push(record.name);
    }
    return names.sort();
  }
}
