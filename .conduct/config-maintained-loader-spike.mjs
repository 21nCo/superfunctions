// Untracked compatibility probe. Never stage or wire into production.
// Usage: node .conduct/config-maintained-loader-spike.mjs tsx|vite /absolute/api.mjs
// Install the pinned candidate in a disposable directory, outside this checkout.
// Tested candidate pins: tsx@4.23.15 and vite@8.3.2.
// Compatibility failures intentionally produce exit status 1.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDocsConfig } from '@docsfn/core';

const [kind, apiPath] = process.argv.slice(2);
if (!['tsx', 'vite'].includes(kind) || !apiPath) throw new Error('Expected tsx|vite and an absolute API module path');
const api = await import(pathToFileURL(resolve(apiPath)).href);
const root = await realpath(await mkdtemp(join(tmpdir(), 'docsfn-maintained-loader-')));
const results = [];
const writableDirectories = [];
const preserve = process.execArgv.some(arg => /^--preserve[-_]symlinks$/.test(arg)) || /--preserve[-_]symlinks/.test(process.env.NODE_OPTIONS??'') || process.env.NODE_PRESERVE_SYMLINKS==='1';
const conditionsEnabled = process.execArgv.some(arg => arg.includes('development')) || /development/.test(process.env.NODE_OPTIONS ?? '');
const put = async (name, source) => {
  const file = join(root, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);
  return file;
};
async function load(file) {
  const dependencies = [];
  let mod;
  if (kind === 'tsx') {
    mod = await api.tsImport(file, {
      parentURL: import.meta.url,
      tsconfig: false,
      onImport: url => { if (url.startsWith('file:')) dependencies.push(fileURLToPath(url)); },
    });
  } else {
    const result = await api.runnerImport(file, {
      root: dirname(file), configFile: false, logLevel: 'silent',
      server: { watch: null }, cacheDir: join(root, 'vite-cache'),
      // Vite uses explicit configuration for these native process choices.
      resolve: { preserveSymlinks: preserve },
      environments: { inline: { resolve: { conditions: ['node', ...(conditionsEnabled ? ['development'] : [])] } } },
    });
    mod = result.module;
    dependencies.push(...result.dependencies);
  }
  // Node exposes transpiled CommonJS ES modules as default(module.exports).
  // Normalize that documented interop shape rather than counting a nested
  // default export as a loader compatibility failure.
  let candidate = mod.default ?? mod;
  if (candidate?.__esModule === true && Object.hasOwn(candidate, 'default')) candidate = candidate.default;
  return { value: typeof candidate === 'function' ? await candidate() : candidate, dependencies };
}
async function check(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: error.message }); }
}

try {
  const esmLeaf = await put('esm/leaf.mjs', 'export const title = "Before";');
  const esm = await put('esm/config.mjs', `import {title} from './leaf.mjs';
    await Promise.resolve();
    class Action { label() { return title; } }
    const action = new Action();
    export default async () => ({schemaVersion:1,site:{title,theme:{render:()=>title,Action,action},pageActions:[{primary:action}]},content:{root:'.'}});`);
  let before;
  await check('live functions and class identity through validation', async () => {
    before = validateDocsConfig((await load(esm)).value);
    assert.equal(before.site.theme.render(), 'Before');
    assert.ok(before.site.theme.action instanceof before.site.theme.Action);
    assert.equal(before.site.pageActions[0].primary, before.site.theme.action);
  });
  await writeFile(esmLeaf, 'export const title = "After";');
  await check('same-process ESM reload with live previous generation', async () => {
    const after = validateDocsConfig((await load(esm)).value);
    assert.equal(after.site.title, 'After');
    assert.equal(after.site.theme.render(), 'After');
    assert.equal(before.site.theme.render(), 'Before');
  });
  await check('successful ESM dependency watch paths', async () => {
    assert.ok((await load(esm)).dependencies.includes(esmLeaf));
  });

  const json = await put('mixed/data.json', '{"title":"Before"}');
  await put('mixed/bridge.cjs', 'module.exports=require("./data.json");');
  const mixed = await put('mixed/config.mjs', 'import data from "./bridge.cjs"; export default {title:data.title};');
  await check('mixed ESM and CommonJS JSON initial load', async () => {
    assert.equal((await load(mixed)).value.title, 'Before');
  });
  await writeFile(json, '{"title":"After"}');
  await check('same-process mixed CommonJS JSON reload', async () => {
    assert.equal((await load(mixed)).value.title, 'After');
  });
  await check('CommonJS JSON dependency watch path', async () => {
    assert.ok((await load(mixed)).dependencies.includes(json));
  });
  const cjsJson = await put('cjs/data.json', '{"title":"Before"}');
  const cjs = await put('cjs/config.cjs', 'module.exports=require("./data.json");');
  await check('CommonJS entry initial load', async () => {
    assert.equal((await load(cjs)).value.title, 'Before');
  });
  await writeFile(cjsJson, '{"title":"After"}');
  await check('same-process CommonJS entry JSON reload', async () => {
    assert.equal((await load(cjs)).value.title, 'After');
  });

  const meta = await put('meta/config.mjs', 'export default {url:import.meta.url,filename:import.meta.filename,dirname:import.meta.dirname,resolved:import.meta.resolve("./leaf.mjs")};');
  const metaLeaf = await put('meta/leaf.mjs', 'export default 1;');
  for (const [key, expected] of Object.entries({url:pathToFileURL(meta).href,filename:meta,dirname:dirname(meta),resolved:pathToFileURL(metaLeaf).href})) {
    await check('native import.meta.' + (key === 'resolved' ? 'resolve' : key), async () => assert.equal((await load(meta)).value[key], expected));
  }
  const parent = await put('meta/alternate/parent.mjs', 'export default 1;');
  const parentMeta = await put('meta/parent-config.mjs', `export default {resolved:import.meta.resolve('./asset.json',${JSON.stringify(pathToFileURL(parent).href)})};`);
  // Node ignores this second argument unless the experimental feature is enabled.
  // Run with the actual flag to exercise the alternative native behavior.
  const parentEnabled = process.execArgv.some(arg => /^--experimental[-_]import[-_]meta[-_]resolve$/.test(arg))
    || /--experimental[-_]import[-_]meta[-_]resolve/.test(process.env.NODE_OPTIONS ?? '');
  await check('optional resolver parent follows actual Node flag', async () => {
    assert.equal((await load(parentMeta)).value.resolved, pathToFileURL(join(dirname(parentEnabled ? parent : parentMeta), 'asset.json')).href);
  });

  await put('conditions/package.json', JSON.stringify({type:'module',imports:{'#value':{development:'./dev.mjs',default:'./prod.mjs'},'#kind':{import:'./import.mjs',require:'./require.cjs'}}}));
  await put('conditions/dev.mjs', 'export default "Development";');
  await put('conditions/prod.mjs', 'export default "Production";');
  await put('conditions/import.mjs', 'export default "Import";');
  await put('conditions/require.cjs', 'module.exports="Require";');
  const conditions = await put('conditions/config.mjs', 'import value from "#value"; export default {value};');
  await check('package condition follows active Node conditions', async () => {
    assert.equal((await load(conditions)).value.value, conditionsEnabled ? 'Development' : 'Production');
  });
  await put('conditions/bridge.cjs', 'module.exports=require("#kind");');
  const mixedConditions = await put('conditions/mixed-config.mjs', 'import esm from "#kind"; import cjs from "./bridge.cjs"; export default {esm,cjs};');
  await check('mixed import and require package conditions', async () => {
    assert.deepEqual((await load(mixedConditions)).value, {esm:'Import',cjs:'Require'});
  });

  const tsLeaf = await put('ts/leaf.ts', 'export const title:string="Before";');
  const ts = await put('ts/config.ts', 'import {title} from "./leaf"; export default {title};');
  await check('extensionless TypeScript initial load', async () => assert.equal((await load(ts)).value.title, 'Before'));
  await writeFile(tsLeaf, 'export const title:string="After";');
  await check('same-process extensionless TypeScript reload', async () => assert.equal((await load(ts)).value.title, 'After'));

  const external = await put('external/leaf.mjs', 'export default "External";');
  const computed = await put('project/config.mjs', 'const name="../external/leaf.mjs"; export default {value:(await import(name)).default};');
  await check('computed external import load and watch path', async () => {
    const result = await load(computed);
    assert.equal(result.value.value, 'External');
    assert.ok(result.dependencies.includes(external));
  });
  const missing = await put('recovery/config.ts', 'import value from "./missing"; export default {value};');
  await check('missing dependency fails and recovers after creation', async () => {
    await assert.rejects(load(missing));
    await put('recovery/missing.ts', 'export default "Recovered";');
    assert.equal((await load(missing)).value.value, 'Recovered');
  });
  // A successful-path callback cannot establish the required failure-path watch
  // candidates. This negative probe records whether the API reports any.
  const missingWatch = await put('missing-watch/config.ts', 'import value from "./absent"; export default {value};');
  await check('failed load exposes missing watch candidates', async () => {
    const dependencies=[];
    let error;
    try {
      if (kind==='tsx') await api.tsImport(missingWatch,{parentURL:import.meta.url,tsconfig:false,onImport:url=>dependencies.push(url)});
      else await api.runnerImport(missingWatch,{root:dirname(missingWatch),configFile:false,logLevel:'silent',server:{watch:null},cacheDir:join(root,'vite-cache')});
    } catch (caught) { error=caught; }
    assert.ok(error, 'missing import must fail');
    const candidates=[...dependencies,...(error.dependencies??[])].map(path=>path.startsWith('file:')?fileURLToPath(path):path);
    assert.ok(candidates.some(path=>path.startsWith(join(dirname(missingWatch),'absent'))), 'no missing dependency candidate supplied');
  });

  await put('source/theme.mjs', 'export default "Source";');
  await put('alias/theme.mjs', 'export default "Alias";');
  const source = await put('source/config.mjs', 'import value from "./theme.mjs"; export default {value,filename:import.meta.filename};');
  const alias = join(root,'alias/config.mjs');
  await symlink(source,alias);
  await check('symlink resolution follows actual Node flag', async () => {
    assert.deepEqual((await load(alias)).value,{value:preserve?'Alias':'Source',filename:preserve?alias:source});
  });
  const readonly = await put('readonly/config.mjs', 'export default {value:true};');
  const sourceBytes = await readFile(readonly,'utf8');
  writableDirectories.push(dirname(readonly));
  await chmod(dirname(readonly),0o555);
  await check('read-only source without generated source files', async () => {
    assert.equal((await load(readonly)).value.value,true);
    assert.equal(await readFile(readonly,'utf8'),sourceBytes);
    assert.deepEqual(await readdir(dirname(readonly)),['config.mjs']);
  });
  console.log(JSON.stringify({kind,node:process.version,flags:process.execArgv,passed:results.filter(result=>result.pass).length,total:results.length,results},null,2));
  if (results.some(result=>!result.pass)) process.exitCode=1;
} finally {
  for (const directory of writableDirectories) await chmod(directory,0o755).catch(()=>{});
  await rm(root,{recursive:true,force:true});
}
