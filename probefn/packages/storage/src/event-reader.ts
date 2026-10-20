import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRepositoryRelativePath } from './manifest-writer.js';

export interface StoredEvent {
  relativePath: string;
  lineNumber: number;
  payload: Record<string, unknown>;
}

/** Read the initial sink and its numbered rollover siblings in numeric order. */
export async function readEventSinkFamily(repoRoot: string, initialPath: string): Promise<StoredEvent[]> {
  const relativePath = assertRepositoryRelativePath(initialPath);
  const directory = path.posix.dirname(relativePath);
  const name = path.posix.basename(relativePath);
  const stem = name.endsWith('.ndjson') ? name.slice(0, -7) : name;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d{4,})\\.ndjson$`);
  // Read the initial file first: a missing anchor remains a missing sink, not an empty result.
  const initial = await readFile(path.resolve(repoRoot, relativePath), 'utf8');
  const siblings = (await readdir(path.resolve(repoRoot, directory)))
    .map(name => ({ name, index: Number(pattern.exec(name)?.[1]) }))
    .filter(entry => Number.isSafeInteger(entry.index) && entry.index >= 2)
    .sort((left, right) => left.index - right.index);
  const records: StoredEvent[] = [];
  const append = (file: string, contents: string) => {
    for (const [index, line] of contents.split('\n').entries()) {
      if (line.trim()) records.push({ relativePath: file, lineNumber: index + 1,
        payload: JSON.parse(line) as Record<string, unknown> });
    }
  };
  append(relativePath, initial);
  for (const sibling of siblings) {
    const file = path.posix.join(directory, sibling.name);
    append(file, await readFile(path.resolve(repoRoot, file), 'utf8'));
  }
  return records;
}
