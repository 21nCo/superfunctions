import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { createReadStream } from "node:fs";
import type { Artifact } from "../types.js";
import type { StorageBackend, StoredArtifact } from "./backends.js";
interface Manifest extends StoredArtifact {
  storage?: { chunks: string[]; encoding: "gzip" | "identity" };
}
const CHUNK_SIZE = 64 * 1024;
/** Bounded chunks allow incremental persistence and reads on every backend. */
export async function persistArtifact(
  manager: StorageBackend,
  artifact: StoredArtifact,
  source?: AsyncIterable<Uint8Array>,
): Promise<void> {
  const previous = (await manager.getArtifact(artifact.id)) as Manifest | null;
  const chunks: string[] = [];
  const { buffer, ...metadata } = artifact;
  const input =
    source ??
    (buffer
      ? (async function* () {
          yield buffer;
        })()
      : undefined);
  if (!input) {
    await manager.putArtifact({ ...metadata, storage: undefined } as Manifest);
    for (const id of previous?.storage?.chunks ?? [])
      await manager.deleteArtifact(id);
    return;
  }
  const encoding =
    artifact.type === "log" || artifact.type === "trace" ? "gzip" : "identity";
  const token = randomUUID();
  try {
    for await (const part of input) {
      if (!(part instanceof Uint8Array))
        throw new TypeError("Artifact stream must yield bytes");
      for (let offset = 0; offset < part.byteLength; offset += CHUNK_SIZE) {
        const bytes = Buffer.from(part.subarray(offset, offset + CHUNK_SIZE));
        const id = `${artifact.id}.chunk.${token}.${chunks.length}`;
        await manager.putArtifact({
          id,
          runId: artifact.runId,
          testId: artifact.testId,
          type: artifact.type,
          path: artifact.path,
          buffer: encoding === "gzip" ? gzipSync(bytes) : bytes,
        });
        chunks.push(id);
      }
    }
    await manager.putArtifact({
      ...metadata,
      storage: { chunks, encoding },
    } as Manifest);
  } catch (error) {
    await Promise.allSettled(chunks.map((id) => manager.deleteArtifact(id)));
    throw error;
  }
  for (const id of previous?.storage?.chunks ?? [])
    await manager.deleteArtifact(id);
}
export async function* readArtifactStream(
  manager: StorageBackend,
  id: string,
): AsyncGenerator<Buffer> {
  const artifact = (await manager.getArtifact(id)) as Manifest | null;
  if (!artifact) throw new Error(`Artifact ${id} not found`);
  if (artifact.storage) {
    for (const chunkId of artifact.storage.chunks) {
      const chunk = await manager.getArtifact(chunkId);
      if (!chunk?.buffer)
        throw new Error(`Artifact chunk ${chunkId} is missing`);
      const bytes = Buffer.from(chunk.buffer);
      yield artifact.storage.encoding === "gzip"
        ? gunzipSync(bytes, { maxOutputLength: CHUNK_SIZE })
        : bytes;
    }
  } else if (artifact.buffer) yield Buffer.from(artifact.buffer);
  else
    for await (const chunk of createReadStream(artifact.path, {
      highWaterMark: CHUNK_SIZE,
    }))
      yield Buffer.from(chunk);
}
export async function readArtifact(
  manager: StorageBackend,
  id: string,
): Promise<Artifact | null> {
  const artifact = (await manager.getArtifact(id)) as Manifest | null;
  if (!artifact) return null;
  const { storage, ...publicArtifact } = artifact;
  if (!storage) return publicArtifact;
  const chunks: Buffer[] = [];
  for await (const chunk of readArtifactStream(manager, id)) chunks.push(chunk);
  return { ...publicArtifact, buffer: Buffer.concat(chunks) };
}
