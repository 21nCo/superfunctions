import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Adapter } from '@superfunctions/db';
import type { CompFnConfig, Logger } from 'compfn';

export interface CliConfig extends Omit<CompFnConfig, 'database'> {
  database: Adapter;
}

const stderrLogger: Logger = {
  debug: () => {},
  info: (message, context) => console.error(message, context ?? ''),
  warn: (message, context) => console.error(message, context ?? ''),
  error: (message, context) => console.error(message, context ?? ''),
};

/** Module configuration supplies a real shared DB adapter and evidence clients. */
export async function loadConfig(configPath?: string): Promise<CliConfig> {
  const resolvedPath = resolve(configPath ?? process.env.COMPFN_CONFIG ?? 'compfn.config.json');
  let config: CliConfig;
  if (['.js', '.mjs', '.cjs'].includes(extname(resolvedPath))) {
    const module = await import(pathToFileURL(resolvedPath).href);
    config = typeof module.default === 'function' ? await module.default() : await module.default;
  } else {
    const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
    const databaseType = parsed.database?.type ?? 'memory';
    if (databaseType !== 'memory') {
      throw new Error(`Database type ${databaseType} requires a .mjs/.js/.cjs config exporting a shared DB adapter`);
    }
    const { memoryAdapter } = await import('@superfunctions/db/adapters');
    config = { ...parsed, database: memoryAdapter() };
  }
  if (!config || typeof config !== 'object' ||
      !config.database || typeof config.database.initialize !== 'function' ||
      typeof config.database.close !== 'function' || typeof config.database.create !== 'function') {
    throw new Error('Config must export a CompFn config with a shared database Adapter');
  }
  for (const [name, adapter] of Object.entries(config.adapters ?? {})) {
    if (!adapter || typeof adapter.runCheck !== 'function') {
      throw new Error(`Evidence adapter ${name} must provide runCheck; configure adapters in a module config`);
    }
  }
  return { ...config, logger: config.logger ?? stderrLogger };
}

/** Commands flush output normally and always close the database they initialized. */
export async function withConfig(path: string | undefined, run: (config: CliConfig) => Promise<void>): Promise<void> {
  let config: CliConfig | undefined;
  try {
    config = await loadConfig(path);
    await config.database.initialize();
    await run(config);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (config) {
      try { await config.database.close(); }
      catch (error) {
        console.error(`Error closing database: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }
}
