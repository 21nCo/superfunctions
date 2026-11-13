/**
 * Workers test: worker.ts is bundled exactly as `wrangler deploy` would bundle
 * it (no nodejs_compat), the esbuild metafile proves no AWS SDK module is in
 * the Worker build, and the bundle is served by workerd through Miniflare. No
 * Cloudflare account is used. The round trip runs when STORAGE_R2_S3_ENDPOINT
 * names an S3-compatible server (MinIO in CI); STORAGE_R2_S3_REQUIRED=1 makes a
 * missing endpoint a failure instead of a skip.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const COMPATIBILITY_DATE = '2025-11-13';
const endpoint = process.env.STORAGE_R2_S3_ENDPOINT;
if (process.env.STORAGE_R2_S3_REQUIRED === '1' && !endpoint) {
  throw new Error('STORAGE_R2_S3_REQUIRED=1 but STORAGE_R2_S3_ENDPOINT is not set');
}

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const require = createRequire(import.meta.url);

let workDir: string;
let bundleInputs: string[];
let script: string;
let mf: Miniflare;

async function bundleWorker(): Promise<void> {
  const outDir = join(workDir, 'out');
  const config = join(workDir, 'wrangler.json');
  await writeFile(
    config,
    JSON.stringify({
      name: 'storage-r2-workers-test',
      main: fromHere('./worker.ts'),
      compatibility_date: COMPATIBILITY_DATE,
      alias: { '@superfunctions/storage-r2': fromHere('../../src/index.ts') },
    })
  );
  const wrangler = join(require.resolve('wrangler/package.json'), '..', 'bin', 'wrangler.js');
  await promisify(execFile)(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', outDir, '--metafile', join(workDir, 'meta.json')],
    {
      cwd: workDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
    }
  );
  const meta = JSON.parse(await readFile(join(workDir, 'meta.json'), 'utf8')) as { inputs: Record<string, unknown> };
  bundleInputs = Object.keys(meta.inputs);
  script = await readFile(join(outDir, 'worker.js'), 'utf8');
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'storage-r2-workers-'));
  await bundleWorker();
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    bindings: {
      S3_ENDPOINT: endpoint ?? '',
      S3_BUCKET: process.env.STORAGE_R2_S3_BUCKET ?? '',
      S3_ACCESS_KEY_ID: process.env.STORAGE_R2_S3_ACCESS_KEY_ID ?? '',
      S3_SECRET_ACCESS_KEY: process.env.STORAGE_R2_S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('storage-r2 on workerd', () => {
  it('builds a Worker bundle with no AWS SDK module', () => {
    expect(bundleInputs.some((input) => input.includes('packages/storage-r2/src/adapter.ts'))).toBe(true);
    expect(bundleInputs.filter((input) => /@aws-sdk|@smithy|s3-compatible/.test(input))).toEqual([]);
    expect(script).not.toMatch(/@aws-sdk|@smithy/);
  });

  it('signs the AWS presigned-URL example with workerd Web Crypto', async () => {
    const response = await mf.dispatchFetch('https://storage-r2.test/vector');
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(
      /&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/
    );
  });

  it.skipIf(!endpoint)('drives uploads, downloads and multipart against an S3-compatible server', async () => {
    const response = await mf.dispatchFetch('https://storage-r2.test/roundtrip', { method: 'POST' });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({
      conformance: true,
      putStatus: 200,
      size: 18,
      contentType: 'text/plain',
      downloaded: 'from',
      signedGetStatus: 200,
      signedGetBody: 'hello from workerd',
      multipartSize: 18,
      afterDelete: 'STORAGE_NOT_FOUND',
    });
  });
});
