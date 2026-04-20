import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isProbefnError, loadConfig } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

describe('loadConfig', () => {
  it('loads a valid config file and applies defaults', async () => {
    const config = await loadConfig('test/fixtures/vite-healthy/probefn.config.ts', {
      cwd: repoRoot,
    });

    expect(config.projectName).toBe('vite-healthy');
    expect(config.artifactRoot).toBe('.artifacts');
    expect(config.baselineRoot).toBe('.artifacts/baselines');
    expect(config.defaultBrowser).toBe('chromium');
    expect(config.defaultMode).toBe('mixed');
    expect(Object.keys(config.devServers)).toEqual(['web']);
    expect(config.devServers.web?.timeoutMs).toBe(120000);
    expect(config.deterministicDefaults.viewport.width).toBe(1440);
    expect(config.deterministicDefaults.viewport.height).toBe(900);
  });

  it('rejects an invalid browser engine', async () => {
    await expect(
      loadConfig('test/fixtures/invalid-browser/probefn.config.ts', {
        cwd: repoRoot,
      }),
    ).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      message: 'Invalid browser engine "safari" in probefn config.',
    });
  });

  it('rejects absolute artifact roots', async () => {
    await expect(
      loadConfig('test/fixtures/absolute-artifact-root/probefn.config.ts', {
        cwd: repoRoot,
      }),
    ).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      message: 'artifactRoot must be a repository-relative path.',
    });
  });

  it('rejects malformed timeout values', async () => {
    try {
      await loadConfig('test/fixtures/invalid-timeout/probefn.config.ts', {
        cwd: repoRoot,
      });

      throw new Error('Expected invalid-timeout fixture to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_CONFIG_INVALID',
        message: 'timeoutMs must be a positive integer in probefn config.',
      });
    }
  });
});
