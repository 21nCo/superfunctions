/**
 * Workers smoke test: worker.ts is bundled exactly as `wrangler deploy` would
 * bundle it and served by workerd (Miniflare). Every request goes through the
 * Hono host app into FileFn mounted at /files. It drives a proxy upload end to
 * end (init, sign, part upload, part complete, complete, download), checks the
 * processing FileFn deferred through ctx.waitUntil (counting the registrations),
 * and fires the cron trigger against a session that has expired.
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

const ORIGIN = 'https://filefn.smoke.test';
const BASE_URL = `${ORIGIN}/files`;
const COMPATIBILITY_DATE = '2025-11-13';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];
const USER = { 'x-smoke-user': 'smoke_user' };

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const require = createRequire(import.meta.url);

type EnvelopeBody = { ok?: boolean; data?: any; error?: { code: string } };

let workDir: string;
let mf: Miniflare;

/** Bundles worker.ts with wrangler's deploy bundler, @filefn/server resolved to its source. */
async function bundleWorker(outDir: string): Promise<string> {
  const config = join(workDir, 'wrangler.json');
  await writeFile(
    config,
    JSON.stringify({
      name: 'filefn-workers-smoke',
      main: fromHere('./worker.ts'),
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
      alias: { '@filefn/server': fromHere('../../src/index.ts') },
    }),
  );
  const wrangler = join(require.resolve('wrangler/package.json'), '..', 'bin', 'wrangler.js');
  await promisify(execFile)(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', outDir],
    {
      cwd: workDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
    },
  );
  return readFile(join(outDir, 'worker.js'), 'utf8');
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'filefn-workers-smoke-'));
  const script = await bundleWorker(join(workDir, 'out'));
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: COMPATIBILITY_FLAGS,
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
  }
});

async function call(url: string, init: RequestInit = {}) {
  const response = await mf.dispatchFetch(url, {
    ...init,
    headers: { ...USER, ...(init.headers as Record<string, string> | undefined) },
  } as never);
  const body = (await response.json()) as EnvelopeBody;
  return { status: response.status, body };
}

function postJson(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return call(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

async function waitUntilRegistrations(): Promise<number> {
  const response = await mf.dispatchFetch(`${ORIGIN}/__smoke/wait-until`);
  return ((await response.json()) as { registrations: number }).registrations;
}

/** A returned FileFn URL is relative to the mount, the way @filefn/client resolves it. */
function underMount(url: string): string {
  expect(url.startsWith('/')).toBe(true);
  return `${BASE_URL}${url}`;
}

describe('FileFn on workerd under Hono at /files', () => {
  it('leaves non-FileFn host routes to the Hono app', async () => {
    const host = await mf.dispatchFetch(`${ORIGIN}/`);
    expect(await host.text()).toBe('host app');

    const root = await mf.dispatchFetch(`${ORIGIN}/upload/init`, { method: 'POST', headers: USER });
    expect(root.status).toBe(404);
  });

  it('completes init, upload, complete and download, and runs deferred processing', async () => {
    const text = 'hello from workerd';
    const bytes = new TextEncoder().encode(text);
    const token = (session: { uploadSessionToken?: string }): Record<string, string> =>
      session.uploadSessionToken ? { 'x-upload-session-token': session.uploadSessionToken } : {};

    const init = await postJson('/upload/init', {
      policy: 'note',
      fileName: 'hello.txt',
      size: bytes.byteLength,
      mimeType: 'text/plain',
    });
    expect(init.status).toBe(200);
    const session = init.body.data;
    expect(session.uploadSessionId).toMatch(/^upl_[0-9a-hjkmnp-tv-z]{20}$/);
    expect(session.uploadMode).toBe('proxy');

    const status = await call(`${BASE_URL}/upload/${session.uploadSessionId}/status`, { headers: token(session) });
    expect(status.status).toBe(200);

    const signed = await postJson(`/upload/${session.uploadSessionId}/parts/1/sign`, { contentLength: bytes.byteLength }, token(session));
    expect(signed.status).toBe(200);
    expect(signed.body.data.url).toBe(`/upload/${session.uploadSessionId}/parts/1`);

    const put = await call(underMount(signed.body.data.url), {
      method: 'PUT',
      headers: { ...signed.body.data.headers, ...token(session), 'content-length': String(bytes.byteLength) },
      body: bytes,
    });
    expect(put.status).toBe(200);

    const part = await postJson(
      `/upload/${session.uploadSessionId}/parts/1/complete`,
      { etag: put.body.data.etag, size: put.body.data.size },
      token(session),
    );
    expect(part.status).toBe(200);

    const registrationsBefore = await waitUntilRegistrations();
    const completed = await postJson(`/upload/${session.uploadSessionId}/complete`, {}, token(session));
    expect(completed.status).toBe(200);
    // Completing hands queue-less processing to the method-style hook, which registered it with ctx.waitUntil.
    expect(await waitUntilRegistrations()).toBeGreaterThan(registrationsBefore);
    const { fileId, versionId } = completed.body.data;
    expect(fileId).toMatch(/^file_[0-9a-hjkmnp-tv-z]{20}$/);
    expect(versionId).toMatch(/^ver_[0-9a-hjkmnp-tv-z]{20}$/);

    const listed = await call(BASE_URL);
    expect(listed.status).toBe(200);
    expect(listed.body.data.files.map((file: { fileId: string }) => file.fileId)).toContain(fileId);

    const download = await call(`${BASE_URL}/${fileId}/download`);
    expect(download.status).toBe(200);
    expect(download.body.data.url).toBe(`/proxy/files/${fileId}/download`);
    const content = await mf.dispatchFetch(underMount(download.body.data.url), { headers: USER });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(text);

    // Processing ran after the complete response, kept alive by ctx.waitUntil.
    let artifacts: Array<{ artifactId: string; kind: string }> = [];
    for (let attempt = 0; attempt < 50 && artifacts.length === 0; attempt += 1) {
      const listedArtifacts = await call(`${BASE_URL}/${fileId}/artifacts`);
      expect(listedArtifacts.status).toBe(200);
      artifacts = listedArtifacts.body.data.artifacts;
      if (artifacts.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactId).toMatch(/^art_[0-9a-hjkmnp-tv-z]{20}$/);
    const artifactLink = await call(`${BASE_URL}/${fileId}/artifacts/${artifacts[0].artifactId}/download`);
    expect(artifactLink.status).toBe(200);
    expect(artifactLink.body.data.url).toBe(`/proxy/files/${fileId}/artifacts/${artifacts[0].artifactId}/download`);
    const artifact = await mf.dispatchFetch(underMount(artifactLink.body.data.url), { headers: USER });
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toBe(text.toUpperCase());
  });

  it('runs expired-session cleanup from a cron trigger', async () => {
    const expiring = await call(`${ORIGIN}/expiring/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'note', fileName: 'stale.txt', size: 5, mimeType: 'text/plain' }),
    });
    expect(expiring.status).toBe(200);
    // The session expires on creation; let the clock move past its expiresAt.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const worker = await mf.getWorker();
    const result = await worker.scheduled({ cron: '0 * * * *' });
    expect(result.outcome).toBe('ok');

    const cleanup = await mf.dispatchFetch(`${ORIGIN}/__smoke/last-cleanup`);
    expect(await cleanup.json()).toEqual({ deletedSessions: 1, abortedMultipart: 0 });

    const gone = await call(`${ORIGIN}/expiring/upload/${expiring.body.data.uploadSessionId}/status`, {
      headers: expiring.body.data.uploadSessionToken ? { 'x-upload-session-token': expiring.body.data.uploadSessionToken } : {},
    });
    expect(gone.status).toBe(404);
  });
});
