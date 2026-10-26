import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chokidar from 'chokidar';

// Disposable design probe only: the config and its consumers stay in one child.
// Only a final plain-data artifact crosses the process boundary.
const jitiUrl = import.meta.resolve('jiti');
const coreUrl = import.meta.resolve('@docsfn/core');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'docsfn-consumer-boundary-'));
const configPath = join(fixtureRoot, 'docsfn.config.mjs');
const leafPath = join(fixtureRoot, 'leaf.mjs');
const dataPath = join(fixtureRoot, 'data.json');
const artifactPath = join(fixtureRoot, 'artifact.json');
let watcher;

const worker = `
  import { createJiti } from ${JSON.stringify(jitiUrl)};
  import { validateDocsConfig } from ${JSON.stringify(coreUrl)};
  import { writeFile } from 'node:fs/promises';
  import { pathToFileURL } from 'node:url';

  try {
    const configPath = process.env.DOCSFN_SPIKE_CONFIG;
    const jiti = createJiti(pathToFileURL(configPath).href, {
      fsCache: false, moduleCache: false, interopDefault: false,
    });
    const mod = await jiti.import(configPath);
    const candidate = mod.default ?? mod;
    const config = validateDocsConfig(
      typeof candidate === 'function' ? await candidate() : candidate,
      configPath,
    );
    let cloneRejected = false;
    try { structuredClone(config); } catch { cloneRejected = true; }
    const artifact = {
      title: config.site.title,
      rendered: config.site.theme.render(),
      action: config.site.pageActions[0].primary.label(),
      cloneRejected,
    };
    await writeFile(process.env.DOCSFN_SPIKE_ARTIFACT, JSON.stringify(artifact));
    process.send({ ok: true, artifact });
  } catch (error) {
    process.send({ ok: false, error: String(error?.stack ?? error) });
  }
`;

async function runFreshConsumer(nodeBinary) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary, ['--input-type=module', '-e', worker], {
      env: {
        ...process.env,
        DOCSFN_SPIKE_CONFIG: configPath,
        DOCSFN_SPIKE_ARTIFACT: artifactPath,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result;
    let stderr = '';
    child.on('message', (message) => { result = message; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 || !result?.ok) {
        reject(new Error(result?.error ?? `consumer exited ${code}: ${stderr}`));
      } else {
        resolve(result.artifact);
      }
    });
  });
}

try {
  await writeFile(leafPath, 'export const title = "Before";');
  await writeFile(dataPath, '{"title":"Before"}');
  await writeFile(join(fixtureRoot, 'bridge.cjs'), 'module.exports = require("./data.json");');
  await writeFile(configPath, `
    import { title } from './leaf.mjs';
    import data from './bridge.cjs';
    await Promise.resolve();
    class Action { label() { return title + '/' + data.title; } }
    export default async () => ({
      schemaVersion: 1,
      site: {
        title: title + '/' + data.title,
        theme: { render: () => title },
        pageActions: [{ primary: new Action() }],
      },
      content: { root: ${JSON.stringify(fixtureRoot)} },
    });
  `);

  const nodeBinary = process.argv[2] ?? process.execPath;
  const before = await runFreshConsumer(nodeBinary);
  assert.deepEqual(before, {
    title: 'Before/Before', rendered: 'Before', action: 'Before/Before', cloneRejected: true,
  });
  assert.deepEqual(JSON.parse(await readFile(artifactPath, 'utf8')), before);

  const watchEvents = [];
  watcher = chokidar.watch(fixtureRoot, {
    ignoreInitial: true,
    ignored: (pathname) => pathname === artifactPath,
  });
  watcher.on('all', (event, pathname) => watchEvents.push({ event, pathname }));
  await once(watcher, 'ready');
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('dependency watch timed out')), 5_000);
    const handler = (event, pathname) => {
      if (pathname !== leafPath && pathname !== dataPath) return;
      clearTimeout(timeout);
      watcher.off('all', handler);
      resolve({ event, pathname });
    };
    watcher.on('all', handler);
  });
  await writeFile(leafPath, 'export const title = "After";');
  await writeFile(dataPath, '{"title":"After"}');
  await changed;
  const after = await runFreshConsumer(nodeBinary);
  assert.deepEqual(after, {
    title: 'After/After', rendered: 'After', action: 'After/After', cloneRejected: true,
  });
  assert.deepEqual(JSON.parse(await readFile(artifactPath, 'utf8')), after);
  assert.equal(
    Object.values(watcher.getWatched()).some((names) => names.includes('artifact.json')),
    false,
  );
  assert.equal(watchEvents.some(({ pathname }) => pathname === artifactPath), false);
  console.log(JSON.stringify({ nodeBinary, before, after, watchEvents, result: 'PASS' }));
} finally {
  await watcher?.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
