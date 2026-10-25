import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isProbefnError, loadConfig, validateConfig } from '../src/index.js';

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

  it('loads storage caps and rejects invalid cap values instead of dropping them', async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'probefn-config-caps-'));
    try {
      for(const [index,storageCaps] of [{maxArtifactBytes:2048,maxEventsPerSink:3,maxAccountingDatabaseBytes:65536},{maxArtifactBytes:-1},{maxEventsPerSink:0},{maxAccountingDatabaseBytes:1},{maxArtifactBytes:1.5},{typo:3}].entries()) {
        const filename=`config-${index}.mjs`;
        await writeFile(path.join(root,filename),`export default ${JSON.stringify({storageCaps})}`);
        if(index===0)expect((await loadConfig(filename,{cwd:root})).storageCaps).toEqual(storageCaps);
        else await expect(loadConfig(filename,{cwd:root})).rejects.toMatchObject({code:'E_CONFIG_INVALID'});
      }
    } finally {await rm(root,{recursive:true,force:true});}
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

describe('configuration input and parsed output', () => {
  it('parses nested defaults and preserves trimmed record values', () => {
    const config = validateConfig({
      projectName: ' project ',
      deterministicDefaults: { viewport: { width: 800 }, locale: ' en-GB ' },
      devServers: { web: { mode: 'attach', name: ' web ', url: ' http://localhost:3000 ' } },
      analyzers: { custom: { enabled: true }, absent: undefined },
      ignoredLegacyKey: true,
    });
    expect(config.projectName).toBe('project');
    expect(config.deterministicDefaults).toEqual({ enabled: true, viewport: { width: 800, height: 900 }, locale: 'en-GB', timezone: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', animationPolicy: 'freeze', networkIdleMs: 500 });
    expect(config.devServers.web).toMatchObject({ name: 'web', url: 'http://localhost:3000', timeoutMs: 120000, envAllowlist: [] });
    expect(config.analyzers).toEqual({ custom: { enabled: true }, absent: undefined });
    expect(config).not.toHaveProperty('ignoredLegacyKey');
    expect(validateConfig({}).deterministicDefaults.viewport).toEqual({ width: 1440, height: 900 });
  });
  it('rejects malformed records, null settings and unsafe integer caps', () => {
    for (const input of [{ devServers: [] }, { devServers: { web: null } }, { analyzers: [] }, { deterministicDefaults: null }, { storageCaps: { maxArtifactBytes: Number.MAX_SAFE_INTEGER + 1 } }]) {
      expect(() => validateConfig(input)).toThrow();
    }
  });
});
