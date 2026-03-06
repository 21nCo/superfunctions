import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as toYaml } from "yaml";
import type { Collection, CollectionItem } from "./types.js";

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, toYaml(value), "utf8");
}

async function writeItem(rootDir: string, item: CollectionItem): Promise<void> {
  if (item.kind === "folder") {
    const folderDir = path.join(rootDir, item.path);
    await ensureDir(folderDir);
    await writeYaml(path.join(folderDir, "folder.yml"), {
      name: item.name,
      ...(item.seq !== undefined ? { seq: item.seq } : {}),
    });

    for (const child of item.children ?? []) {
      await writeItem(rootDir, child);
    }

    return;
  }

  if (!item.request) {
    throw new Error(`Request item missing request payload: ${item.path}`);
  }

  await writeYaml(path.join(rootDir, item.path), item.request);
}

export async function writeCollection(collection: Collection): Promise<void> {
  if (!collection.rootDir) {
    throw new Error("Collection rootDir is required for writeCollection");
  }

  await ensureDir(collection.rootDir);

  await writeYaml(path.join(collection.rootDir, "opencollection.yml"), {
    name: collection.info.name,
    ...(collection.info.description ? { description: collection.info.description } : {}),
    ...(collection.info.version ? { version: collection.info.version } : {}),
  });

  const envDir = path.join(collection.rootDir, "environments");
  await ensureDir(envDir);

  for (const [name, env] of Object.entries(collection.environments)) {
    await writeYaml(path.join(envDir, `${name}.yml`), {
      name: env.name,
      variables: env.variables,
    });
  }

  for (const item of collection.items) {
    await writeItem(collection.rootDir, item);
  }
}
