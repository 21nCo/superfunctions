import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const node = process.execPath;
const jitiUrl = import.meta.resolve('jiti');
const root = await realpath(await mkdtemp(join(tmpdir(), 'docsfn-process-spike-')));
const put = async (name, content) => {
  const path = join(root, name);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
};
const worker = `
  import { createJiti } from ${JSON.stringify(jitiUrl)};
  import { pathToFileURL } from 'node:url';
  const path = process.env.DOCSFN_SPIKE_CONFIG;
  try {
    const jiti = createJiti(pathToFileURL(path).href, { fsCache: false, moduleCache: false, interopDefault: false });
  const mod = await jiti.import(path);
  const candidate = mod.default ?? mod;
  const value = typeof candidate === 'function' ? await candidate() : candidate;
  const seen = new Set();
  function assertPlainData(current, path) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object') throw new Error(path + ' must be plain JSON data');
    if (seen.has(current)) throw new Error(path + ' contains a cycle');
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)
      throw new Error(path + ' must be a plain object');
    seen.add(current);
    const keys = Reflect.ownKeys(current);
    if (Array.isArray(current)) {
      if (keys.length !== current.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9]\\d*)$/.test(String(key))))
        throw new Error(path + ' must be a dense plain array');
    }
    for (const key of keys) {
      if (key === 'length' && Array.isArray(current)) continue;
      if (typeof key !== 'string') throw new Error(path + ' contains a symbol key');
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(path + '.' + key + ' must be an enumerable data property');
      assertPlainData(descriptor.value, path + '.' + key);
    }
    seen.delete(current);
  }
  assertPlainData(value, 'config');
  process.send({ ok: true, value });
  } catch (error) {
    process.send({ ok: false, error: String(error?.stack ?? error) });
  }
`;
const load = (path, extraArgs = []) => new Promise((resolveResult, reject) => {
  const child = spawn(node, [...extraArgs, '--input-type=module', '-e', worker], {
    env: { ...process.env, DOCSFN_SPIKE_CONFIG: path },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', result => resolveResult(result));
  child.on('error', reject);
  child.on('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}: ${stderr}`)); });
});
const check = async (name, path, expected, extraArgs = []) => {
  const result = await load(path, extraArgs);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  assert.deepEqual(result.value, expected, name);
  console.log(`PASS ${name}`);
};
const reject = async (name, path, message) => {
  const result = await load(path);
  assert.equal(result.ok, false, name);
  assert.match(result.error, message, name);
  console.log(`PASS ${name}`);
};

try {
  const esmDep = await put('esm/dep.mjs', 'export default "Before";');
  const esm = await put('esm/docsfn.config.mjs', 'import dep from "./dep.mjs"; export default { value: dep };');
  await check('transitive ESM before', esm, { value: 'Before' });
  await writeFile(esmDep, 'export default "After";');
  await check('transitive ESM after', esm, { value: 'After' });

  const jsonDep = await put('cjs/dep.json', '{"value":"Before"}');
  const cjs = await put('cjs/docsfn.config.cjs', 'module.exports = require("./dep.json");');
  await check('transitive CJS JSON before', cjs, { value: 'Before' });
  await writeFile(jsonDep, '{"value":"After"}');
  await check('transitive CJS JSON after', cjs, { value: 'After' });

  await put('pkg/package.json', JSON.stringify({ type: 'module', imports: { '#condition': { import: './esm.mjs', require: './cjs.cjs' } } }));
  await put('pkg/esm.mjs', 'export default "ESM";');
  await put('pkg/cjs.cjs', 'module.exports = "CJS";');
  const mixed = await put('pkg/docsfn.config.mjs', 'import esm from "#condition"; import cjs from "./bridge.cjs"; export default { esm, cjs };');
  await put('pkg/bridge.cjs', 'module.exports = require("#condition");');
  await check('mixed ESM import and CJS require conditions', mixed, { esm: 'ESM', cjs: 'CJS' });

  await put('conditions/package.json', JSON.stringify({ type: 'module', imports: { '#theme': { development: './dev.mjs', default: './prod.mjs' } } }));
  await put('conditions/dev.mjs', 'export default "development";');
  await put('conditions/prod.mjs', 'export default "production";');
  const conditioned = await put('conditions/docsfn.config.mjs', 'import value from "#theme"; export default { value };');
  await check('default package condition', conditioned, { value: 'production' });
  await check('custom package condition', conditioned, { value: 'development' }, ['--conditions=development']);
  await check('custom short package condition', conditioned, { value: 'development' }, ['-C', 'development']);

  const meta = await put('meta/docsfn.config.mjs', 'export default { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname, resolved: import.meta.resolve("./dep.mjs") };');
  const metaDep = await put('meta/dep.mjs', 'export default 1;');
  await check('native import.meta identities', meta, {
    url: pathToFileURL(meta).href,
    filename: meta,
    dirname: resolve(meta, '..'),
    resolved: pathToFileURL(metaDep).href,
  });

  await put('meta/alternate/asset.json', '{}');
  const parentUrl = pathToFileURL(join(root, 'meta/alternate/parent.mjs')).href;
  const metaParent = await put('meta/parent.config.mjs', `export default { resolved: import.meta.resolve('./asset.json', ${JSON.stringify(parentUrl)}) };`);
  await check('optional import.meta.resolve parent', metaParent, {
    resolved: pathToFileURL(join(root, 'meta/alternate/asset.json')).href,
  }, ['--experimental-import-meta-resolve']);

  const tsDep = await put('ts/dep.ts', 'export default "TS";');
  const ts = await put('ts/docsfn.config.ts', 'import dep from "./dep"; export default { value: dep, url: import.meta.url };');
  await check('TypeScript extensionless and identity', ts, { value: 'TS', url: pathToFileURL(ts).href });
  await writeFile(tsDep, 'export default "TS2";');
  await check('TypeScript transitive refresh', ts, { value: 'TS2', url: pathToFileURL(ts).href });

  const original = await put('symlink/source.mjs', 'export default { filename: import.meta.filename };');
  const link = join(root, 'symlink/link.mjs');
  await symlink(original, link);
  await check('symlink default realpath', link, { filename: original });
  await check('symlink preserve flag', link, { filename: link }, ['--preserve-symlinks']);

  const readonly = await put('readonly/docsfn.config.mjs', 'export default { value: true };');
  await chmod(resolve(readonly, '..'), 0o555);
  await check('read-only source directory', readonly, { value: true });
  assert.deepEqual(await readFile(readonly, 'utf8'), 'export default { value: true };');

  const nonData = await put('data/docsfn.config.mjs', 'export default { site: { theme: { render() {} } } };');
  await reject('reject nested function with path', nonData, /config\.site\.theme\.render must be plain JSON data/);
  await writeFile(nonData, 'const value = {}; value.self = value; export default value;');
  await reject('reject cycle with path', nonData, /config\.self contains a cycle/);
  await writeFile(nonData, 'export default { site: { theme: { date: new Date() } } };');
  await reject('reject non-plain object with path', nonData, /config\.site\.theme\.date must be a plain object/);
} finally {
  await chmod(join(root, 'readonly'), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
