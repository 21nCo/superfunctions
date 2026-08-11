import { dirname, resolve } from "node:path";
import type {
  DocsCollection,
  DocsProviderWatchMetadata,
  DocsProviderWatchSubscription,
  DocsSourceEntry,
} from "@docsfn/core";

export interface FsWatchMetadataInput {
  root: string;
  collectionDirectories: Partial<Record<DocsCollection, string[]>>;
  entries: DocsSourceEntry[];
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );
}

export function buildFsWatchMetadata(
  input: FsWatchMetadataInput
): DocsProviderWatchMetadata {
  const watchedFiles = uniqueSorted(
    input.entries
      .map((entry) => entry.absolutePath)
      .filter((value): value is string => typeof value === "string")
      .map((value) => resolve(value))
  );

  const watchedDirectories = uniqueSorted([
    resolve(input.root),
    ...Object.values(input.collectionDirectories)
      .flatMap((value) => value ?? [])
      .map((value) => resolve(value)),
    ...watchedFiles.map((value) => dirname(value)),
  ]);

  const collectionGlobs: Partial<Record<DocsCollection, string[]>> = {};
  for (const [collection, directories] of Object.entries(input.collectionDirectories)) {
    if (!directories || directories.length === 0) {
      continue;
    }

    collectionGlobs[collection as DocsCollection] = directories.flatMap((directory) => [
      `${resolve(directory)}/**/*`,
      `${resolve(directory)}/**/meta.json`,
    ]);
  }

  return {
    watchedFiles,
    watchedDirectories,
    collectionGlobs,
  };
}

export function createNoopWatchSubscription(
  metadata: DocsProviderWatchMetadata
): DocsProviderWatchSubscription {
  return {
    metadata,
    async close(): Promise<void> {
      return;
    },
  };
}
