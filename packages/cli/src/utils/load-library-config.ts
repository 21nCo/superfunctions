import { loadConfigModule } from './load-config-module.js';

/**
 * Load library config file
 * Handles TS/JS/MJS with proper runtime compilation
 */
export async function loadLibraryConfig(
  configPath: string
): Promise<any> {
  const loaded = await loadConfigModule(configPath, {
    exportNames: ['config'],
  });

  return loaded.value;
}
