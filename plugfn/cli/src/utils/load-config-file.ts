import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadConfigFile(configPath: string): Promise<unknown> {
  const ext = path.extname(configPath);

  if (ext === '.ts') {
    const jiti = await import('jiti').then((module) => module.default || module);
    const loader = jiti(process.cwd(), {
      interopDefault: true,
      extensions: ['.ts', '.js', '.mjs', '.cjs'],
    });

    const loaded = loader(configPath);
    return resolveLoadedValue(loaded);
  }

  const loaded = await import(pathToFileURL(configPath).href);
  return resolveLoadedValue(loaded.default ?? loaded);
}

function resolveLoadedValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'plug' in (value as Record<string, unknown>)) {
    return value;
  }

  if (value && typeof value === 'object' && 'default' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).default;
  }

  return value;
}
