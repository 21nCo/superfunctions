/** Build the shared closure and WatchFn before running this isolated consumer check. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'watchfn-packed-'));
const npm = (args, cwd = temporary) => execFileSync(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const paths = ['packages/observability', 'packages/http', 'packages/db', 'logfn/typescript', 'watchfn/typescript'];
  const tarballs = paths.map(path => {
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, path)));
    return join(temporary, pack.filename);
  });
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  npm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@18']);
  for (const name of ['express', 'fastify', 'hono', 'next', '@sveltejs/kit']) assert.equal(existsSync(join(temporary, 'node_modules', name)), false, `Core must not install ${name}`);
  const check = `
async function check(WatchFn) {
  const watch = new WatchFn({name:'packed',storage:'memory',infra:{enabled:false},auth:{enabled:true,apiKey:'local-key'}});
  const {createLogger} = await import('@logfn/core');
  const logger = createLogger({name:'packed-log', sinks:[()=>{}]});
  watch.use(logger);
  watch.start();
  try {
    const event={ts:'2026-10-20T12:00:00.000Z',name:'packed',msg:'retained',traceId:'0123456789abcdef0123456789abcdef',ctx:{nested:true}};
    const request=(key)=>new Request('http://local/ingest',{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({events:[event]})});
    assert.equal((await watch.httpRouter.handler(request('wrong'))).status,401);
    assert.equal((await watch.httpRouter.handler(request('local-key'))).status,202);
    assert.deepEqual(await watch.query({}),[event]);
    assert.deepEqual(await watch.query({timeRange:{from:event.ts,to:event.ts}}),[event]);
    const queryResponse = await watch.httpRouter.handler(new Request('http://local/query',{method:'POST',headers:{authorization:'Bearer local-key'},body:JSON.stringify({metric:'packed'})}));
    assert.equal(queryResponse.status,200);
    assert.deepEqual((await queryResponse.json()).results,[event]);
    assert.deepEqual(await watch.aggregate({metric:'packed',aggregation:'count'}),[{value:1}]);
    logger.info('installed-log', {service:'packed-service',password:'private-password'});
    logger.info('other-service', {service:'other'});
    await logger.flush();
    const logs = await watch.logs.query({filters:{service:'packed-service'}});
    assert.equal(logs.length,1); assert.equal(logs[0].message,'installed-log');
    assert.equal(JSON.stringify(logs).includes('private-password'),false);
    const transaction = watch.startTransaction('packed-transaction');
    transaction.startSpan('packed-child').finish(); transaction.finish(); transaction.finish();
    const spans = await watch.query({metric:'trace.span'});
    assert.equal(spans.length,2);
    assert.equal(spans[0].properties.parentId,spans[1].properties.id);

  } finally { await watch.stop(); }
  console.log('packed WatchFn',process.version);
}
`;
  writeFileSync(join(temporary, 'smoke.mjs'), `import assert from 'node:assert/strict'; import {WatchFn} from '@watchfn/core';${check}\nawait check(WatchFn);`);
  // This must remain a real synchronous require, not an async import workaround.
  writeFileSync(join(temporary, 'smoke.cjs'), `const assert=require('node:assert/strict'); const {WatchFn}=require('@watchfn/core');${check}\ncheck(WatchFn).catch(error=>{console.error(error);process.exitCode=1;});`);
  for (const version of ['18.18.0', '20.19.0', '22']) {
    for (const file of ['smoke.mjs', 'smoke.cjs']) console.log(npm(['exec', '--yes', `--package=node@${version}`, '--', 'node', file]).trim());
  }
  writeFileSync(join(temporary, 'consumer.mts'), `import {WatchFn, getWatchFnSchema, getBugIssueSchema} from '@watchfn/core';
export const watch = new WatchFn({name:'typed',storage:'memory'}); export const router = watch.httpRouter; export const schema = getWatchFnSchema(); export const bugSchema = getBugIssueSchema();`);
  writeFileSync(join(temporary, 'consumer.cts'), `import {WatchFn, getWatchFnSchema, getBugIssueSchema} from '@watchfn/core'; export const watch = new WatchFn({name:'typed',storage:'memory'}); export const router = watch.httpRouter; export const schema = getWatchFnSchema(); export const bugSchema = getBugIssueSchema();`);
  const inferredSchemas = `
import { ContextSchema } from '@watchfn/core';
export const optionalContext = ContextSchema.optional();
export const refinedContext = ContextSchema.refine(value => value.userId !== 'blocked');
export const partialContext = ContextSchema.partial();
export const contextArray = ContextSchema.array();
export const nullableContext = ContextSchema.nullable();
export const brandedContext = ContextSchema.brand<'Context'>();
export const contextLength = ContextSchema.transform(value => Object.keys(value).length);
`;
  for (const extension of ['mts', 'cts']) writeFileSync(join(temporary, `consumer.${extension}`), readFileSync(join(temporary, `consumer.${extension}`), 'utf8') + inferredSchemas);
  for (const mode of ['Node16', 'NodeNext']) execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts'], { cwd: temporary, stdio: 'pipe', encoding: 'utf8' });
  // Modern consumers compose the actual public schemas with their Zod instance.
  // Bundling all Zod declarations duplicates brands/registry symbols and can make
  // recursive ZodType assignment fail even when a basic import compiles.
  const composition = `import { WatchFnConfigSchema, ContextSchema } from '@watchfn/core';
import { z } from 'zod';
export const nested = z.object({ watch: WatchFnConfigSchema });
export const extended = ContextSchema.extend({ extra: z.string() });
export const union = z.union([ContextSchema, z.string()]);
export const structural: z.ZodType = ContextSchema;
const branded = ContextSchema.brand<'Context'>();
declare const output: z.output<typeof branded>;
export const externalBrand: z.output<typeof ContextSchema> & z.core.$brand<'Context'> = output;
const registry = z.registry<{ example: z.$output }>();
ContextSchema.register(registry, { example: ContextSchema.parse({}) });`;
  for (const extension of ['mts', 'cts']) writeFileSync(join(temporary, `composition.${extension}`), composition);
  for (const mode of ['Node16', 'NodeNext']) execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'composition.mts', 'composition.cts'], { cwd: temporary, stdio: 'pipe', encoding: 'utf8' });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', 'CommonJS', '--moduleResolution', 'Node10', '--esModuleInterop', 'composition.cts'], { cwd: temporary, stdio: 'pipe', encoding: 'utf8' });
  console.log('External Zod schema, brand and registry composition passed');
  // Use Node declarations contemporary with the promised compiler floor;
  // current @types/node releases can independently require a newer compiler.
  npm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@18.16.19']);
  for (const version of ['5.0.4', '5.3.3', '5.4.5']) {
    for (const mode of ['Node16', 'NodeNext']) npm(['exec', '--yes', `--package=typescript@${version}`, '--', 'tsc', '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts']);
    npm(['exec', '--yes', `--package=typescript@${version}`, '--', 'tsc', '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', 'CommonJS', '--moduleResolution', 'Node10', '--esModuleInterop', 'consumer.cts']);
    console.log(`TypeScript ${version} consumer declarations passed`);
  }
  // Check the first compiler receiving the ordinary external-Zod declaration path.
  for (const mode of ['Node16', 'NodeNext']) npm(['exec', '--yes', '--package=typescript@5.4.5', '--', 'tsc', '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'composition.mts', 'composition.cts']);
  let audit;
  try { audit = JSON.parse(npm(['audit', '--omit=dev', '--json'])); }
  catch (error) {
    if (!error.stdout) throw error;
    audit = JSON.parse(error.stdout);
  }
  console.log('production dependency audit', audit.metadata.vulnerabilities);
  for (const finding of Object.values(audit.vulnerabilities ?? {})) console.log(finding.name, finding.severity, 'fixAvailable:', finding.fixAvailable);
  assert.equal(audit.metadata.vulnerabilities.total, 0, 'Production dependency audit must be clear');
  console.log('WatchFn packed runtimes and runtime audit passed');
} finally { rmSync(temporary, { recursive: true, force: true }); }
